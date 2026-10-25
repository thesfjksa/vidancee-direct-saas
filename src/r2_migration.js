'use strict';
// Moves MySQL-stored videos (db:video) into cloud object storage one at a
// time. Source chunks are deleted only after the uploaded object's size and
// MD5 have been verified, in the same transaction as the marker change.
const crypto=require('node:crypto');
const {getPool}=require('./db.js');
const {readStoredRange}=require('./google_drive_migration.js');
const {configuredStorage,storageConfiguration,videoKey,MARKER,blobRef}=require('./object_storage.js');
const {logActivity,errorDetails}=require('./activity_log.js');

async function migrateOneVideoToStorage({db=getPool(),store,log=logActivity}={}){
  if(!store)store=await configuredStorage();
  if(!store)return {migrated:false,reason:'not_enabled'};
  const lock=await db.getConnection(),name='cmm_r2_migration';
  let locked=false;
  try{
    const [[acquired]]=await lock.query('SELECT GET_LOCK(?,0) AS acquired',[name]);
    locked=Number(acquired.acquired)===1;
    if(!locked)return {migrated:false,reason:'busy'};
    const [[row]]=await db.query("SELECT g.id,o.byte_length,o.mime_type FROM generations g JOIN generation_video_outputs o ON o.generation_id=g.id WHERE g.output_url='db:video' ORDER BY g.created_at ASC LIMIT 1");
    if(!row)return {migrated:false,reason:'finished'};
    const id=row.id,size=Number(row.byte_length);
    if(!Number.isSafeInteger(size)||size<=0)throw new Error('Invalid stored video metadata. Original retained.');
    const data=await readStoredRange(db,id,size,0,size);
    const md5=crypto.createHash('md5').update(data).digest('hex');
    const key=videoKey(id);
    await store.put(key,data,row.mime_type||'video/mp4');
    const meta=await store.head(key);
    if(!meta||meta.size!==size||(meta.etag&&meta.etag!==md5))
      throw new Error('Cloud storage video integrity check failed; original MySQL data retained.');
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [[fresh]]=await conn.execute('SELECT output_url FROM generations WHERE id=? FOR UPDATE',[id]);
      if(!fresh||fresh.output_url!=='db:video'){await conn.rollback();return {migrated:false,reason:'changed',generationId:id};}
      await conn.execute('UPDATE generations SET output_url=?,updated_at=UTC_TIMESTAMP() WHERE id=?',[MARKER+key,id]);
      await conn.execute('DELETE FROM generation_video_chunks WHERE generation_id=?',[id]);
      await conn.execute('DELETE FROM generation_video_outputs WHERE generation_id=?',[id]);
      await conn.commit();
    }catch(error){await conn.rollback().catch(()=>{});throw error;}
    finally{conn.release();}
    log({category:'system',event:'r2.video_migrated',generationId:id,
      message:'Verified cloud storage video and released MySQL video chunks',details:{bytes:size}});
    return {migrated:true,generationId:id,bytes:size};
  }finally{
    if(locked)await lock.query('SELECT RELEASE_LOCK(?)',[name]).catch(()=>{});
    lock.release();
  }
}

// BLOB tables whose files move to cloud storage. Offloaded cells hold a tag
// shorter than 512 bytes (see object_storage.js), so LENGTH>=512 means "still in MySQL".
const BLOB_TABLES=[
  {table:'generation_image_outputs',pk:'generation_id',field:'image_data',prefix:'images'},
  {table:'generation_images',pk:'id',field:'image_data',prefix:'refs'},
  {table:'generation_media',pk:'id',field:'media_data',prefix:'media'},
];

async function migrateOneBlobToStorage({db=getPool(),store,log=logActivity}={}){
  if(!store)store=await configuredStorage();
  if(!store)return {migrated:false,reason:'not_enabled'};
  for(const t of BLOB_TABLES){
    const [[row]]=await db.query('SELECT '+t.pk+' AS pk,generation_id,mime_type,'+t.field+' AS data FROM '+t.table+' WHERE LENGTH('+t.field+')>=512 LIMIT 1');
    if(!row)continue;
    const data=Buffer.from(row.data);
    const md5=crypto.createHash('md5').update(data).digest('hex');
    const key=t.prefix+'/'+row.generation_id+'/'+crypto.randomUUID();
    await store.put(key,data,row.mime_type||'application/octet-stream');
    const meta=await store.head(key);
    if(!meta||meta.size!==data.length||(meta.etag&&meta.etag!==md5)){
      await store.remove(key).catch(()=>{});
      throw new Error('Cloud storage file integrity check failed; original MySQL data retained.');
    }
    // Replace only if the cell still holds the same bytes. BINARY avoids
    // "illegal mix of collations" between MD5()'s result and the parameter.
    const [result]=await db.execute('UPDATE '+t.table+' SET '+t.field+'=? WHERE '+t.pk+'=? AND LENGTH('+t.field+')=? AND BINARY MD5('+t.field+')=BINARY ?',
      [blobRef(key),row.pk,data.length,md5]);
    if(!result.affectedRows){await store.remove(key).catch(()=>{});return {migrated:false,reason:'changed',table:t.table};}
    log({category:'system',event:'r2.file_migrated',generationId:row.generation_id,
      message:'Moved a stored file to cloud storage',details:{table:t.table,bytes:data.length}});
    return {migrated:true,table:t.table,bytes:data.length};
  }
  return {migrated:false,reason:'finished'};
}

async function storageMigrationStats(db=getPool()){
  const [[pending]]=await db.query("SELECT COUNT(*) AS videoCount,COALESCE(SUM(o.byte_length),0) AS videoBytes FROM generations g JOIN generation_video_outputs o ON o.generation_id=g.id WHERE g.output_url='db:video'");
  const [[done]]=await db.query("SELECT COUNT(*) AS videoCount FROM generations WHERE output_url LIKE 'r2:%'");
  let pendingFiles=0,pendingFileBytes=0;
  for(const t of BLOB_TABLES){
    const [[r]]=await db.query('SELECT COUNT(*) AS n,COALESCE(SUM(LENGTH('+t.field+')),0) AS bytes FROM '+t.table+' WHERE LENGTH('+t.field+')>=512');
    pendingFiles+=Number(r.n);pendingFileBytes+=Number(r.bytes);
  }
  return {pendingVideos:Number(pending.videoCount),pendingBytes:Number(pending.videoBytes),storedVideos:Number(done.videoCount),
    pendingFiles,pendingFileBytes};
}

function startStorageMigrationLoop({db=getPool(),intervalMs=15000,log=logActivity}={}){
  let running=false,stopped=false,cooldown=0;
  const tick=async()=>{
    if(running||stopped||Date.now()<cooldown)return;
    running=true;
    try{
      const cfg=await storageConfiguration();
      if(!cfg.enabled||!cfg.migrationEnabled)return;
      // Videos first (largest), then images and reference files.
      let outcome=await migrateOneVideoToStorage({db,log});
      if(outcome.reason==='finished')outcome=await migrateOneBlobToStorage({db,log});
      if(outcome.reason==='finished')cooldown=Date.now()+5*60000;
    }catch(error){
      cooldown=Date.now()+5*60000;
      log({level:'error',category:'system',event:'r2.migration_failed',
        message:'Moving files to cloud storage paused for 5 minutes; the MySQL copy is kept.',details:errorDetails(error)});
    }finally{running=false;}
  };
  const timer=setInterval(()=>{tick().catch(()=>{});},intervalMs);
  timer.unref?.();
  tick().catch(()=>{});
  return ()=>{stopped=true;clearInterval(timer);};
}

module.exports={migrateOneVideoToStorage,migrateOneBlobToStorage,storageMigrationStats,startStorageMigrationLoop,BLOB_TABLES};

'use strict';
// Moves MySQL-stored videos (db:video) into cloud object storage one at a
// time. Source chunks are deleted only after the uploaded object's size and
// MD5 have been verified, in the same transaction as the marker change.
const crypto=require('node:crypto');
const {getPool}=require('./db.js');
const {readStoredRange}=require('./google_drive_migration.js');
const {configuredStorage,storageConfiguration,videoKey,MARKER}=require('./object_storage.js');
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

async function storageMigrationStats(db=getPool()){
  const [[pending]]=await db.query("SELECT COUNT(*) AS videoCount,COALESCE(SUM(o.byte_length),0) AS videoBytes FROM generations g JOIN generation_video_outputs o ON o.generation_id=g.id WHERE g.output_url='db:video'");
  const [[done]]=await db.query("SELECT COUNT(*) AS videoCount FROM generations WHERE output_url LIKE 'r2:%'");
  return {pendingVideos:Number(pending.videoCount),pendingBytes:Number(pending.videoBytes),storedVideos:Number(done.videoCount)};
}

function startStorageMigrationLoop({db=getPool(),intervalMs=15000,log=logActivity}={}){
  let running=false,stopped=false,cooldown=0;
  const tick=async()=>{
    if(running||stopped||Date.now()<cooldown)return;
    running=true;
    try{
      const cfg=await storageConfiguration();
      if(!cfg.enabled||!cfg.migrationEnabled)return;
      const outcome=await migrateOneVideoToStorage({db,log});
      if(outcome.reason==='finished')cooldown=Date.now()+5*60000;
    }catch(error){
      cooldown=Date.now()+5*60000;
      log({level:'error',category:'system',event:'r2.migration_failed',
        message:'Cloud storage video migration paused for 5 minutes; original MySQL bytes retained.',details:errorDetails(error)});
    }finally{running=false;}
  };
  const timer=setInterval(()=>{tick().catch(()=>{});},intervalMs);
  timer.unref?.();
  tick().catch(()=>{});
  return ()=>{stopped=true;clearInterval(timer);};
}

module.exports={migrateOneVideoToStorage,storageMigrationStats,startStorageMigrationLoop};

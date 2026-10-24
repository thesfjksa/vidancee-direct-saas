'use strict';
const crypto=require('node:crypto');
const {getPool}=require('./db.js');
const {configuredDrive}=require('./google_drive.js');
const {getSettingValue}=require('./settings.js');
const {logActivity,errorDetails}=require('./activity_log.js');

const MB=1024*1024, BATCH_BYTES=4*MB;
async function readStoredRange(db,id,size,offset,length){
  if(offset<0||length<=0||offset+length>size)throw new Error('Invalid MySQL video byte range.');
  const first=Math.floor(offset/MB),last=Math.floor((offset+length-1)/MB);
  const [rows]=await db.execute('SELECT chunk_index,video_data FROM generation_video_chunks WHERE generation_id=? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index',
    [id,first,last]);
  if(rows.length!==last-first+1)throw new Error('MySQL video has missing data chunks. The original is retained.');
  for(let i=0;i<rows.length;i++)if(Number(rows[i].chunk_index)!==first+i)
    throw new Error('MySQL video has unexpected chunk order.');
  const source=Buffer.concat(rows.map(r=>r.video_data));
  const out=source.subarray(offset-first*MB,offset-first*MB+length);
  if(out.length!==length)throw new Error('MySQL video is incomplete; not deleting the source.');
  return out;
}
async function migrateOneVideo({db=getPool(),drive,log=logActivity}={}){
  if(!drive)drive=await configuredDrive();
  if(!drive)return {migrated:false,reason:'not_enabled'};
  const lock=await db.getConnection(),name='cmm_gdrive_migration';
  let locked=false;
  try{
    const [[acquired]]=await lock.query('SELECT GET_LOCK(?,0) AS acquired',[name]);
    locked=Number(acquired.acquired)===1;
    if(!locked)return {migrated:false,reason:'busy'};
    const [[row]]=await db.query("SELECT g.id,o.byte_length FROM generations g JOIN generation_video_outputs o ON o.generation_id=g.id WHERE g.output_url='db:video' ORDER BY g.created_at ASC LIMIT 1");
    if(!row)return {migrated:false,reason:'finished'};
    const id=row.id,size=Number(row.byte_length);
    if(!Number.isSafeInteger(size)||size<=0)throw new Error('Invalid stored video metadata. Original retained.');
    const chunkReader=(off,len)=>readStoredRange(db,id,size,off,len);
    const md5=crypto.createHash('md5');
    for(let offset=0;offset<size;offset+=BATCH_BYTES)
      md5.update(await chunkReader(offset,Math.min(BATCH_BYTES,size-offset)));
    const checksum=md5.digest('hex');
    const driveId=await drive.uploadVideo({generationId:id,size,md5Checksum:checksum,readChunk:chunkReader});
    // Verify again after upload, before deleting any database content.
    const metadata=await drive.metadata(driveId);
    if(metadata.md5Checksum!==checksum||Number(metadata.size)!==size||metadata.mimeType!=='video/mp4')
      throw new Error('Google Drive video integrity check failed; original MySQL data retained.');
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [[fresh]]=await conn.execute("SELECT output_url FROM generations WHERE id=? FOR UPDATE",[id]);
      if(!fresh||fresh.output_url!=='db:video'){
        await conn.rollback();
        return {migrated:false,reason:'changed',generationId:id};
      }
      // Set marker in the same transaction as chunk deletion. Failure rolls
      // back everything, so an incomplete upload can never remove originals.
      await conn.execute('UPDATE generations SET output_url=?,updated_at=UTC_TIMESTAMP() WHERE id=?',
        ['gdrive:'+driveId,id]);
      await conn.execute('DELETE FROM generation_video_chunks WHERE generation_id=?',[id]);
      await conn.execute('DELETE FROM generation_video_outputs WHERE generation_id=?',[id]);
      await conn.commit();
    }catch(error){await conn.rollback().catch(()=>{});throw error;}
    finally{conn.release();}
    log({category:'system',event:'gdrive.video_migrated',generationId:id,
      message:'Verified Drive video and released MySQL video chunks',details:{bytes:size}});
    return {migrated:true,generationId:id,bytes:size};
  }finally{
    if(locked)await lock.query('SELECT RELEASE_LOCK(?)',[name]).catch(()=>{});
    lock.release();
  }
}
async function videoMigrationStats(db=getPool()){
  const [[pending]]=await db.query("SELECT COUNT(*) AS videoCount,COALESCE(SUM(o.byte_length),0) AS videoBytes FROM generations g JOIN generation_video_outputs o ON o.generation_id=g.id WHERE g.output_url='db:video'");
  const [[done]]=await db.query("SELECT COUNT(*) AS videoCount FROM generations WHERE output_url LIKE 'gdrive:%'");
  return {pendingVideos:Number(pending.videoCount),pendingBytes:Number(pending.videoBytes),
    driveVideos:Number(done.videoCount)};
}
function startDriveMigrationLoop({db=getPool(),intervalMs=20000,log=logActivity}={}){
  let running=false,stopped=false,cooldown=0;
  const tick=async()=>{
    if(running||stopped||Date.now()<cooldown)return;
    running=true;
    try{
      if(await getSettingValue('gdrive_migration_enabled','false')!=='true')return;
      const drive=await configuredDrive();
      if(!drive)return;
      const outcome=await migrateOneVideo({db,drive,log});
      if(outcome.reason==='finished')cooldown=Date.now()+60000;
    }catch(error){
      cooldown=Date.now()+5*60000;
      log({level:'error',category:'system',event:'gdrive.migration_failed',
        message:'Google Drive video migration paused; original MySQL bytes retained.',
        details:errorDetails(error)});
    }finally{running=false;}
  };
  const timer=setInterval(()=>{tick().catch(()=>{});},intervalMs);
  timer.unref?.();
  tick().catch(()=>{});
  return ()=>{stopped=true;clearInterval(timer);};
}
module.exports={readStoredRange,migrateOneVideo,videoMigrationStats,startDriveMigrationLoop};

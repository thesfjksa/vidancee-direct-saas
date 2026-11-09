'use strict';

const CHUNK_SIZE=1024*1024;
function byteRange(header,total) {
  if(!header)return {start:0,end:total-1,partial:false};
  const m=String(header).match(/^bytes=(\d*)-(\d*)$/);
  if(!m||(!m[1]&&!m[2]))return null;
  const start=m[1]?Number(m[1]):Math.max(0,total-Number(m[2]));
  const end=m[1]?(m[2]?Math.min(Number(m[2]),total-1):total-1):total-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=total||(!m[1]&&Number(m[2])===0))return null;
  return {start,end,partial:true};
}

// The one video-storage entry point shared by provider workers. Cloud
// object storage (R2) comes first, then a connected Drive account; with
// neither enabled, legacy MySQL storage remains available unchanged.
async function saveVideoOutput(conn,id,output) {
  const {configuredStorage,videoKey,MARKER}=require('./object_storage.js');
  const store=await configuredStorage();
  if(store){
    const key=videoKey(id);
    if(output.data)await store.put(key,output.data,output.mimeType||'video/mp4');
    else await store.putStream(key,output,output.mimeType);
    return MARKER+key;
  }
  const {configuredDrive}=require('./google_drive.js');
  const drive=await configuredDrive();
  if(drive){
    const fileId=output.data?await drive.uploadBuffer(id,output.data):
      await drive.uploadVideo({generationId:id,size:output.size,readChunk:output.readChunk,md5Checksum:output.md5});
    return 'gdrive:'+fileId;
  }
  const size=output.data?.length??output.size;
  await conn.execute('INSERT INTO generation_video_outputs (generation_id,mime_type,byte_length) VALUES (?,?,?)',
    [id,output.mimeType,size]);
  for(let offset=0,index=0;offset<size;offset+=CHUNK_SIZE,index++) {
    const length=Math.min(CHUNK_SIZE,size-offset);
    const chunk=output.data?output.data.subarray(offset,offset+length):await output.readChunk(offset,length);
    await conn.execute('INSERT INTO generation_video_chunks (generation_id,chunk_index,video_data) VALUES (?,?,?)',
      [id,index,chunk]);
  }
  return 'db:video';
}

async function getVideoOutput(db,id) {
  const [[output]]=await db.execute('SELECT mime_type,byte_length FROM generation_video_outputs WHERE generation_id=?',[id]);
  return output;
}

async function getVideoChunk(db,id,index) {
  const [[chunk]]=await db.execute('SELECT video_data FROM generation_video_chunks WHERE generation_id=? AND chunk_index=?',[id,index]);
  return chunk?.video_data;
}

async function* readVideoChunks(db,id,total,signal) {
  for(let offset=0,index=0;offset<total;offset+=CHUNK_SIZE,index++) {
    signal.throwIfAborted();
    const chunk=await getVideoChunk(db,id,index);
    if(chunk?.length!==Math.min(CHUNK_SIZE,total-offset))throw new Error('Stored video chunk is incomplete.');
    yield chunk;
  }
}

async function serveVideoOutput(db,req,res,id) {
  const output=await getVideoOutput(db,id);
  if(!output) {res.writeHead(404,{'content-type':'application/json'});res.end('{"ok":false,"error":"Video is unavailable."}');return;}
  const total=Number(output.byte_length),range=byteRange(req.headers.range,total);
  if(!range) {res.writeHead(416,{'content-range':'bytes */'+total,'accept-ranges':'bytes'});res.end();return;}
  const headers={'content-type':'video/mp4','content-length':range.end-range.start+1,'accept-ranges':'bytes',
    'cache-control':'private, max-age=31536000, immutable','x-content-type-options':'nosniff'};
  if(range.partial)headers['content-range']='bytes '+range.start+'-'+range.end+'/'+total;
  res.writeHead(range.partial?206:200,headers);
  for(let index=Math.floor(range.start/CHUNK_SIZE);index<=Math.floor(range.end/CHUNK_SIZE);index++) {
    if(res.destroyed)return;
    const chunk=await getVideoChunk(db,id,index);
    if(!chunk){res.destroy();return;}
    const lo=Math.max(0,range.start-index*CHUNK_SIZE),hi=Math.min(chunk.length,range.end-index*CHUNK_SIZE+1);
    if(!res.write(chunk.subarray(lo,hi)))await new Promise(resolve=>{
      const done=()=>{res.removeListener('drain',done);res.removeListener('close',done);resolve();};
      res.once('drain',done);res.once('close',done);
    });
  }
  res.end();
}

module.exports={CHUNK_SIZE,byteRange,saveVideoOutput,serveVideoOutput,getVideoOutput,readVideoChunks};

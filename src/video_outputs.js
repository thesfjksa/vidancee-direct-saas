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

// The one video-storage entry point shared by provider workers. A connected,
// enabled Drive account becomes the default; no MySQL BLOB is written. When
// disabled, legacy MySQL storage remains available unchanged.
async function saveVideoOutput(conn,id,output) {
  const {configuredDrive}=require('./google_drive.js');
  const drive=await configuredDrive();
  if(drive){
    const fileId=await drive.uploadBuffer(id,output.data);
    return 'gdrive:'+fileId;
  }
  await conn.execute('INSERT INTO generation_video_outputs (generation_id,mime_type,byte_length) VALUES (?,?,?)',
    [id,output.mimeType,output.data.length]);
  for(let offset=0,index=0;offset<output.data.length;offset+=CHUNK_SIZE,index++) {
    await conn.execute('INSERT INTO generation_video_chunks (generation_id,chunk_index,video_data) VALUES (?,?,?)',
      [id,index,output.data.subarray(offset,offset+CHUNK_SIZE)]);
  }
  return 'db:video';
}

async function serveVideoOutput(db,req,res,id) {
  const [[output]]=await db.execute('SELECT mime_type,byte_length FROM generation_video_outputs WHERE generation_id=?',[id]);
  if(!output) {res.writeHead(404,{'content-type':'application/json'});res.end('{"ok":false,"error":"Video is unavailable."}');return;}
  const total=Number(output.byte_length),range=byteRange(req.headers.range,total);
  if(!range) {res.writeHead(416,{'content-range':'bytes */'+total,'accept-ranges':'bytes'});res.end();return;}
  const headers={'content-type':'video/mp4','content-length':range.end-range.start+1,'accept-ranges':'bytes',
    'cache-control':'private, max-age=31536000, immutable','x-content-type-options':'nosniff'};
  if(range.partial)headers['content-range']='bytes '+range.start+'-'+range.end+'/'+total;
  res.writeHead(range.partial?206:200,headers);
  for(let index=Math.floor(range.start/CHUNK_SIZE);index<=Math.floor(range.end/CHUNK_SIZE);index++) {
    if(res.destroyed)return;
    const [[chunk]]=await db.execute('SELECT video_data FROM generation_video_chunks WHERE generation_id=? AND chunk_index=?',[id,index]);
    if(!chunk){res.destroy();return;}
    const lo=Math.max(0,range.start-index*CHUNK_SIZE),hi=Math.min(chunk.video_data.length,range.end-index*CHUNK_SIZE+1);
    if(!res.write(chunk.video_data.subarray(lo,hi)))await new Promise(resolve=>{
      const done=()=>{res.removeListener('drain',done);res.removeListener('close',done);resolve();};
      res.once('drain',done);res.once('close',done);
    });
  }
  res.end();
}

module.exports={CHUNK_SIZE,byteRange,saveVideoOutput,serveVideoOutput};

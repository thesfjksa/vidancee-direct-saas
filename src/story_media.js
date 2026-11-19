'use strict';
const fs=require('node:fs/promises');
const {pipeline}=require('node:stream/promises'),{Readable,Transform}=require('node:stream'),{createWriteStream}=require('node:fs');
const MAX=256*1024*1024,CHUNK=1024*1024;
async function download(db,row,file){
 const stored=await require('./video_outputs').getVideoOutput(db,row.id);
 if(stored){
  if(Number(stored.byte_length)>MAX)throw new Error('Story source exceeds the assembly size limit.');
  const handle=await fs.open(file,'w');try{
   for await(const b of require('./video_outputs').readVideoChunks(db,row.id,Number(stored.byte_length),new AbortController().signal))await handle.write(b);
  }finally{await handle.close();}return;
 }
 const url=String(row.output_url||'');let response;
 if(url.startsWith('r2:')){
  const store=await require('./object_storage').configuredStorage({requireEnabled:false});
  response=await store.request('GET',url.slice(3));
 }else if(url.startsWith('gdrive:')){
  response=await (await require('./google_drive').configuredDrive({requireEnabled:false})).getVideo(url.slice(7));
 }else{
  const out=await require('./remote_image').openPublicVideo(url,{timeoutMs:30000,maxBytes:MAX,accept:'*/*'});
  response={ok:true,body:out.body};
 }
 if(!response.ok)throw new Error('Story source download failed.');
 let bytes=0;const limit=new Transform({transform(chunk,enc,cb){bytes+=chunk.length;cb(bytes>MAX?new Error('Story source exceeds size limit.'):null,chunk);}});
 const body=typeof response.body?.getReader==='function'?Readable.fromWeb(response.body):response.body;
 const timer=setTimeout(()=>body.destroy(new Error('Story download timed out.')),120000);
 try{await pipeline(body,limit,createWriteStream(file));}finally{clearTimeout(timer);}
}
async function publish(db,id,file,duration=120){
 const tier=require('./story_tiers').durationTier(duration);
 const size=(await fs.stat(file)).size;if(size<=0||size>(tier.duration/120)*128*1024*1024)throw new Error('Final story exceeds the supported file size.');
 const cloud=await require('./object_storage').configuredStorage();
 if(cloud){
  const crypto=require('node:crypto'),{createReadStream}=require('node:fs');
  const md5=crypto.createHash('md5'),sha=crypto.createHash('sha256');
  for await(const chunk of createReadStream(file)){md5.update(chunk);sha.update(chunk);}
  const key='stories/'+id+'/final.mp4';
  await cloud.putStream(key,{size,md5:md5.digest('hex'),sha256:sha.digest('hex'),openStream:()=>createReadStream(file)},'video/mp4');
  return 'r2:'+key;
 }
 const conn=await db.getConnection(),handle=await fs.open(file,'r');
 try{
  await conn.beginTransaction();await conn.execute('DELETE FROM story_output_chunks WHERE story_id=?',[id]);
  for(let i=0,pos=0;pos<size;i++,pos+=CHUNK){const b=Buffer.alloc(Math.min(CHUNK,size-pos));const read=await handle.read(b,0,b.length,pos);if(read.bytesRead!==b.length)throw new Error('Story file read was incomplete.');await conn.execute('INSERT INTO story_output_chunks(story_id,position_index,video_data) VALUES(?,?,?)',[id,i,b]);}
  await conn.commit();
 }catch(e){await conn.rollback();throw e;}finally{await handle.close();conn.release();}
}
async function serve(db,req,res,id,output){
 if(output==='r2:stories/'+id+'/final.mp4'){
  const cloud=await require('./object_storage').configuredStorage({requireEnabled:false});
  return cloud.stream(output.slice(3),req,res);
 }

 const [[total]]=await db.execute('SELECT SUM(OCTET_LENGTH(video_data)) AS total FROM story_output_chunks WHERE story_id=?',[id]);
 const size=Number(total.total);if(!size){res.writeHead(404);res.end();return;}
 const range=require('./video_outputs').byteRange(req.headers.range,size);
 if(!range){res.writeHead(416,{'content-range':'bytes */'+size});res.end();return;}
 const h={'content-type':'video/mp4','content-length':range.end-range.start+1,'accept-ranges':'bytes','cache-control':'private, max-age=3600','x-content-type-options':'nosniff'};
 if(range.partial)h['content-range']=`bytes ${range.start}-${range.end}/${size}`;
 res.writeHead(range.partial?206:200,h);if(req.method==='HEAD')return res.end();
 for(let i=Math.floor(range.start/CHUNK);i<=Math.floor(range.end/CHUNK);i++){
  if(res.destroyed)return;
  const [[row]]=await db.execute('SELECT video_data FROM story_output_chunks WHERE story_id=? AND position_index=?',[id,i]);
  if(!row){res.destroy();return;}const b=row.video_data.subarray(Math.max(0,range.start-i*CHUNK),Math.min(CHUNK,range.end-i*CHUNK+1));
  if(!res.write(b))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
 }res.end();
}
module.exports={download,publish,serve};

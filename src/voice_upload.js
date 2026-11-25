'use strict';
const Busboy=require('busboy'),path=require('node:path');
const {probe,probeCloneSample}=require('./voice_probe');
const {fail}=require('./voice_contract');
const AUDIO=new Set(['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave','audio/mp4','audio/m4a','audio/aac','audio/ogg','audio/webm','audio/flac','audio/x-flac']);
const VIDEO=new Set(['video/mp4','video/quicktime','video/webm']);
const CLONE_AUDIO_ALIASES=new Map([
 ['audio/x-m4a','audio/mp4'],['audio/x-mp3','audio/mpeg'],['audio/vnd.wave','audio/wav'],
]);
const CLONE_AUDIO_EXTENSIONS=new Map([['.m4a','audio/mp4'],['.mp3','audio/mpeg'],['.wav','audio/wav']]);
function cloneAudioType(type,filename){
 if(type===''||type==='application/octet-stream'||type==='video/mp4'){
  return CLONE_AUDIO_EXTENSIONS.get(path.extname(filename||'').toLowerCase())||type;
 }
 return CLONE_AUDIO_ALIASES.get(type)||type;
}
function readUpload(req,{maxBytes=100*1024*1024,allowVideo=true}={}){return new Promise((resolve,reject)=>{
 const fields=Object.create(null);let sample=null,settled=false;
 const stop=e=>{if(!settled){settled=true;reject(e);}};let bb;
 try{bb=Busboy({headers:req.headers,limits:{files:1,fileSize:maxBytes,fields:24,fieldSize:100000,parts:26}});}catch{reject(fail(400,'Upload a supported media file.'));return;}
 bb.on('field',(name,value,info)=>{if(info.valueTruncated)return stop(fail(400,'Voice settings are too large.'));fields[name]=value;});
 bb.on('file',(name,file,info)=>{
  const type=String(info.mimeType||'').toLowerCase();
  const mimeType=allowVideo?type:cloneAudioType(type,info.filename);
  if(name!=='file'||(!AUDIO.has(mimeType)&&!(allowVideo&&VIDEO.has(mimeType)))){file.resume();stop(fail(400,allowVideo?'Upload a supported audio or video file.':'Choose an MP3, WAV, or M4A recording.'));return;}
  const chunks=[];let bytes=0;
  file.on('data',chunk=>{if(!settled){bytes+=chunk.length;chunks.push(chunk);}});
  file.on('limit',()=>stop(fail(413,'Media exceeds the '+Math.floor(maxBytes/1024/1024)+' MB upload limit.')));
  file.on('error',stop);file.on('end',()=>{if(!settled&&bytes)sample={filename:path.basename(info.filename||'upload').replace(/[\x00-\x1f]/g,'').slice(0,200),mimeType,data:Buffer.concat(chunks)};});
 });
 for(const name of ['filesLimit','fieldsLimit','partsLimit'])bb.on(name,()=>stop(fail(400,'Too many upload parts.')));
 bb.on('error',stop);req.on('aborted',()=>stop(fail(400,'Upload interrupted.')));
 bb.on('close',()=>{if(settled)return;if(!sample)return stop(fail(400,'A media file is required.'));settled=true;resolve({...fields,sample});});req.pipe(bb);
});}
module.exports={readUpload,probe,probeCloneSample};

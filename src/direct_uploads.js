'use strict';
// Customers' browsers upload large reference files (videos, sound) straight to
// cloud storage with short-lived presigned PUT links, because slow uploads
// through the web host time out ("Failed to fetch"). The generation request
// then carries only the object keys.
const crypto=require('node:crypto');
const {configuredStorage}=require('./object_storage.js');

const KINDS={
  video:{types:['video/mp4','video/webm','video/quicktime'],maxBytes:25*1024*1024,field:'videos',label:'Each video reference must be 25 MB or smaller.'},
  audio:{types:['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave','audio/vnd.wave'],maxBytes:15*1024*1024,field:'audios',label:'Each sound reference must be 15 MB or smaller.'},
};
const UPLOAD_SECONDS=15*60;
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const prefixFor=userId=>'uploads/'+Number(userId)+'/';

async function presignUpload(userId,{kind,mimeType,size}={},{store}={}){
  const spec=KINDS[kind];
  if(!spec)fail('Unsupported upload type.');
  const type=String(mimeType||'').toLowerCase();
  if(!spec.types.includes(type))fail(kind==='video'?'Video references must be MP4, WebM, or MOV.':'Sound references must be MP3 or WAV.');
  if(!(Number(size)>0)||Number(size)>spec.maxBytes)fail(spec.label,413);
  store=store||await configuredStorage();
  if(!store)fail('Direct uploads are not available.',409);
  const key=prefixFor(userId)+crypto.randomUUID();
  return {key,url:store.presign(key,{method:'PUT',expires:UPLOAD_SECONDS}),expiresIn:UPLOAD_SECONDS};
}

// Reads `videoUploads` / `audioUploads` ([{key,filename,mimeType}]) from a
// generation form and appends the files to body.videos / body.audios.
// Returns the temporary keys, to delete once the request is handled.
async function collectDirectUploads(body,userId,{store}={}){
  const keys=[];
  for(const [kind,spec] of Object.entries(KINDS)){
    let list=body[kind+'Uploads'];
    delete body[kind+'Uploads'];
    if(!list)continue;
    try{list=typeof list==='string'?JSON.parse(list):list;}catch{fail('Invalid uploaded file list.');}
    if(!Array.isArray(list)||list.length>10)fail('Invalid uploaded file list.');
    if(!list.length)continue;
    store=store||await configuredStorage({requireEnabled:false});
    if(!store)fail('Uploaded files are not available. Please upload them again.',409);
    body[spec.field]=Array.isArray(body[spec.field])?body[spec.field]:[];
    for(const item of list){
      const key=String(item?.key||'');
      if(!key.startsWith(prefixFor(userId))||!/^[0-9a-f-]{36}$/.test(key.slice(prefixFor(userId).length)))fail('Invalid uploaded file.');
      const type=String(item.mimeType||'').toLowerCase();
      if(!spec.types.includes(type))fail('Unsupported uploaded file type.');
      const meta=await store.head(key);
      if(!meta)fail('An uploaded file has expired. Please add it again.',409);
      if(meta.size>spec.maxBytes)fail(spec.label,413);
      keys.push(key);
      const data=Buffer.from(await (await store.get(key)).arrayBuffer());
      body[spec.field].push({filename:String(item.filename||kind).slice(0,255),mimeType:type,data});
    }
  }
  return keys;
}

async function removeDirectUploads(keys,{store}={}){
  if(!keys?.length)return;
  store=store||await configuredStorage({requireEnabled:false});
  if(store)for(const key of keys)await store.remove(key).catch(()=>{});
}

module.exports={presignUpload,collectDirectUploads,removeDirectUploads,KINDS};

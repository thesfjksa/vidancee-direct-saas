'use strict';
const crypto=require('node:crypto');
const API='https://api.aivid.dev';
const UPLOAD_ORIGINS=new Set(['https://aivid-dev.s3.ap-southeast-1.amazonaws.com']);
const TYPES=['image','video','audio'];
const ID=/^[a-zA-Z0-9_-]{16,80}$/;
const fail=()=>Object.assign(new Error('AIVID reference upload could not be verified. No video was submitted.'),{aividCode:'reference_upload'});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});promise.catch(()=>{});return {promise,resolve,reject};}
async function bounded(promise,ms=20000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail()),ms)})]);}finally{clearTimeout(timer)}}
function referenceName(kind, mimeType, index) {
  const extensions = {'image/jpeg':'jpg','video/quicktime':'mov','audio/mpeg':'mp3'};
  return 'reference-'+kind+'-'+(index+1)+'.'+(extensions[mimeType]||mimeType.split('/')[1]);
}
function providerReferenceName(kind, mimeType, index) {
  // The Generate form rebuilds Files from its previews before uploading.
  if(kind==='image')return 'image-'+index+'.png';
  if(kind==='video')return 'image-'+index+(mimeType==='video/mp4'?'.mp4':'.mov');
  return 'audio-'+index+(mimeType==='audio/mpeg'?'.mp3':'.wav');
}
function manifests(references) {
  return TYPES.flatMap(kind => references.filter(ref => ref.kind===kind).map((ref,index) => ({
    kind, mimeType:ref.mimeType, size:ref.data.length, name:referenceName(kind,ref.mimeType,index),
    providerName:providerReferenceName(kind,ref.mimeType,index),
    sha256:crypto.createHash('sha256').update(ref.data).digest('hex'),
  })));
}
function storageKey(postData) {
  // Chrome may omit binary file bytes. The key is a small multipart field.
  return String(postData||'').slice(0,65536)
    .match(/Content-Disposition: form-data; name="key"\r?\n\r?\n([^\r\n]+)\r?\n/i)?.[1];
}
function exactIds(body,job,uploaded=[]){
  const count=job.counts.image+job.counts.video+job.counts.audio;
  if(body.firstFrameId!=null||body.lastFrameId!=null||(body.mode!=null&&body.mode!=='references'))throw fail();
  if(body.references!=null&&(!Array.isArray(body.references)||body.references.length))throw fail();
  if(uploaded.length!==count)throw fail();
  const all=[];
  for(const kind of TYPES){
    const ids=body[kind+'Ids']??[],wanted=uploaded.filter(r=>r.kind===kind).map(r=>r.id);
    if(!Array.isArray(ids)||ids.length!==job.counts[kind]||wanted.length!==ids.length||ids.some((id,i)=>typeof id!=='string'||!ID.test(id)||id!==wanted[i]))throw fail();
    all.push(...ids);
  }
  if(new Set(all).size!==all.length)throw fail();
}
// Mirror the observed AIVID presign -> S3 POST -> save flow. Only the
// files already verified in the browser's FileLists can receive upload IDs.
class UploadTracker {
  constructor(references,onError) {
    this.expected=manifests(references);
    this.records=new Map();
    this.onError=onError;
    this.storageTail=Promise.resolve();
  }
  find(phase, matches, key) {
    const candidates=[...this.records.values()].filter(record=>record.phase===phase&&matches(record));
    if(key!==undefined)return candidates.find(record=>record.key===key);
    return candidates.length===1?candidates[0]:null;
  }
  async before(request) {
    const url=new URL(request.url);
    if(request.method!=='POST')return false;
    if(url.origin===API&&url.pathname==='/v2/uploads/presigned-url'&&!url.search){
      const body=JSON.parse(request.postData||'{}');
      if(typeof body.fileName!=='string'||!body.fileName||body.fileName.length>255||/[\\/\x00]/.test(body.fileName))throw fail();
      const named=this.expected.find(ref=>ref.name===body.fileName||ref.providerName===body.fileName);
      const matches=this.expected.filter(ref=>!this.records.has(ref.name)&&ref.mimeType===body.fileType&&ref.size===body.fileSize);
      const expected=named?(matches.includes(named)?named:null):(matches.length===1?matches[0]:null);
      if(!expected||[...this.records.values()].some(record=>record.requestedName===body.fileName))throw fail();
      this.records.set(expected.name,{...expected,requestedName:body.fileName,presigned:deferred(),stored:deferred(),done:deferred(),phase:'presign'});
      return true;
    }
    if(UPLOAD_ORIGINS.has(url.origin)){
      const presigning=[...this.records.values()].filter(record=>record.phase==='presign');
      await Promise.all(presigning.map(record=>bounded(record.presigned.promise)));
      const record=this.find('storage_ready',r=>r.url===url.href,storageKey(request.postData));
      if(!record)throw fail();
      // Only one storage POST is in flight. Chrome may omit multipart data
      // from the response's request, so the response can still be attributed.
      record.phase='storage_queued';
      const previous=this.storageTail;
      this.storageTail=record.stored.promise;
      await bounded(previous);
      record.phase='storage';return true;
    }
    if(url.origin===API&&url.pathname==='/v2/uploads/presigned-save'&&!url.search){
      const body=JSON.parse(request.postData||'{}');
      if(typeof body.filePath!=='string')throw fail();
      const record=[...this.records.values()].find(r=>r.key===body.filePath);
      if(!record)throw fail();
      await bounded(record.stored.promise);
      if(record.phase!=='save_ready'||body.fileName!==record.fileName||body.fileSize!==record.size||
        body.fileType!==record.mimeType||body.folderPath!==record.folderPath)throw fail();
      record.phase='save';return true;
    }
    return false;
  }
  async response(response) {
    const request=response.request();
    if(request.method()!=='POST')return;
    const url=new URL(response.url());
    let record;
    try{
      if(url.origin===API&&url.pathname==='/v2/uploads/presigned-url'){
        const name=JSON.parse(request.postData?.()||'{}').fileName;
        record=this.find('presign',r=>!name||r.requestedName===name);
        if(!record||!response.ok())throw fail();
        const data=(await response.json())?.data,upload=new URL(data?.url);
        if(!UPLOAD_ORIGINS.has(upload.origin)||upload.username||upload.password||upload.search||upload.hash||
          typeof data.key!=='string'||!data.key||data.key.length>1024||data.fields?.key!==data.key||
          [...this.records.values()].some(r=>r!==record&&r.key===data.key)||
          typeof data.fileName!=='string'||!data.fileName||data.fileName.length>255||
          typeof data.folderPath!=='string'||data.folderPath.length>1024)throw fail();
        Object.assign(record,{url:upload.href,key:data.key,fileName:data.fileName,folderPath:data.folderPath,phase:'storage_ready'});
        record.presigned.resolve();
      }else if(UPLOAD_ORIGINS.has(url.origin)){
        record=this.find('storage',r=>r.url===url.href,storageKey(request.postData?.()));
        if(!record||!response.ok())throw fail();
        record.phase='save_ready';record.stored.resolve();
      }else if(url.origin===API&&url.pathname==='/v2/uploads/presigned-save'){
        const key=JSON.parse(request.postData?.()||'{}').filePath;
        record=this.find('save',()=>true,key);
        if(!record||!response.ok())throw fail();
        const data=(await response.json())?.data;
        if(typeof data?.id!=='string'||!ID.test(data.id)||[...this.records.values()].some(r=>r!==record&&r.id===data.id)||
          (data.fileSize!=null&&data.fileSize!==record.size)||(data.fileType!=null&&data.fileType!==record.mimeType))throw fail();
        record.id=data.id;record.phase='done';record.done.resolve();
      }
    }catch{
      const error=fail();
      record?.presigned.reject(error);record?.stored.reject(error);record?.done.reject(error);
      this.onError(error);
    }
  }
  async completed() {
    if(this.records.size!==this.expected.length)throw fail();
    const ordered=this.expected.map(ref=>this.records.get(ref.name));
    await Promise.all(ordered.map(r=>bounded(r.done.promise)));
    return ordered.map(r=>({kind:r.kind,id:r.id,sha256:r.sha256}));
  }
}
module.exports={UploadTracker,exactIds,manifests,referenceName,bounded,deferred,fail,API};

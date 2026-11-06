'use strict';
const crypto=require('node:crypto');
const API='https://api.aivid.dev';
const UPLOAD_ORIGINS=new Set(['https://aivid-dev.s3.ap-southeast-1.amazonaws.com']);
const TYPES=['image','video','audio'];
const ID=/^[a-zA-Z0-9_-]{16,80}$/;
const fail=()=>Object.assign(new Error('AIVID reference upload could not be verified. No video was submitted.'),{aividCode:'reference_upload'});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});promise.catch(()=>{});return {promise,resolve,reject};}
async function bounded(promise,ms=20000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail()),ms)})]);}finally{clearTimeout(timer)}}
function manifests(references){return TYPES.flatMap(kind=>references.filter(r=>r.kind===kind).map(r=>({kind,mimeType:r.mimeType,size:r.data.length,sha256:crypto.createHash('sha256').update(r.data).digest('hex')})));}
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
  constructor(references,onError){this.expected=manifests(references);this.records=[];this.onError=onError;}
  get active(){return this.records.at(-1)}
  async before(request){
    const url=new URL(request.url);
    if(request.method!=='POST')return false;
    if(url.origin===API&&url.pathname==='/v2/uploads/presigned-url'&&!url.search){
      if(this.active)await bounded(this.active.done.promise);
      const expected=this.expected[this.records.length],body=JSON.parse(request.postData||'{}');
      if(!expected||body.fileType!==expected.mimeType||body.fileSize!==expected.size||
        typeof body.fileName!=='string'||!body.fileName||body.fileName.length>255||/[\\/\x00]/.test(body.fileName))throw fail();
      const record={...expected,requestedName:body.fileName,presigned:deferred(),stored:deferred(),done:deferred(),phase:'presign'};
      this.records.push(record);return true;
    }
    if(UPLOAD_ORIGINS.has(url.origin)){
      const record=this.active;if(!record)throw fail();
      await bounded(record.presigned.promise);
      if(record.phase!=='storage_ready'||url.href!==record.url)throw fail();
      record.phase='storage';return true;
    }
    if(url.origin===API&&url.pathname==='/v2/uploads/presigned-save'&&!url.search){
      const record=this.active;if(!record)throw fail();
      await bounded(record.stored.promise);
      const body=JSON.parse(request.postData||'{}');
      if(record.phase!=='save_ready'||body.fileName!==record.fileName||body.fileSize!==record.size||
        body.fileType!==record.mimeType||body.filePath!==record.key||body.folderPath!==record.folderPath)throw fail();
      record.phase='save';return true;
    }
    return false;
  }
  async response(response){
    const record=this.active;if(!record||response.request().method()!=='POST')return;
    const url=new URL(response.url());let signal;
    try {
      if(url.origin===API&&url.pathname==='/v2/uploads/presigned-url'&&record.phase==='presign'){
        signal=record.presigned;
        if(!response.ok())throw fail();
        const data=(await response.json())?.data,upload=new URL(data?.url);
        if(!UPLOAD_ORIGINS.has(upload.origin)||upload.username||upload.password||upload.search||upload.hash||
          typeof data.key!=='string'||!data.key||data.key.length>1024||data.fields?.key!==data.key||
          typeof data.fileName!=='string'||!data.fileName||data.fileName.length>255||
          typeof data.folderPath!=='string'||data.folderPath.length>1024)throw fail();
        Object.assign(record,{url:upload.href,key:data.key,fileName:data.fileName,folderPath:data.folderPath,phase:'storage_ready'});
        signal.resolve();
      }else if(UPLOAD_ORIGINS.has(url.origin)&&url.href===record.url&&record.phase==='storage'){
        signal=record.stored;if(!response.ok())throw fail();record.phase='save_ready';signal.resolve();
      }else if(url.origin===API&&url.pathname==='/v2/uploads/presigned-save'&&record.phase==='save'){
        signal=record.done;if(!response.ok())throw fail();
        const data=(await response.json())?.data;
        if(typeof data?.id!=='string'||!ID.test(data.id)||this.records.some(r=>r!==record&&r.id===data.id)||
          (data.fileSize!=null&&data.fileSize!==record.size)||(data.fileType!=null&&data.fileType!==record.mimeType))throw fail();
        record.id=data.id;record.phase='done';signal.resolve();
      }
    }catch{const error=fail();signal?.reject(error);record.done.reject(error);this.onError(error);}
  }
  async completed(){
    if(this.records.length!==this.expected.length)throw fail();
    await Promise.all(this.records.map(r=>bounded(r.done.promise)));
    return this.records.map(r=>({kind:r.kind,id:r.id,sha256:r.sha256}));
  }
}
module.exports={UploadTracker,exactIds,manifests,bounded,deferred,fail,API};

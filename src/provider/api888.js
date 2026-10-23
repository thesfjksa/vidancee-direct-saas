'use strict';
// Account-scoped catalog endpoint. Never log or expose the token.
const ORIGIN='https://888api.xin';
class Api888Client {
  constructor({apiKey='',fetchImpl=fetch}={}){this.apiKey=String(apiKey||'').trim();this.fetch=fetchImpl;}
  async models(){
    if(!this.apiKey)throw Object.assign(new Error('Configure an 888API token in Admin first.'),{statusCode:400});
    let response;
    try{response=await this.fetch(ORIGIN+'/v1/models',{method:'GET',headers:{authorization:'Bearer '+this.apiKey,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});}
    catch{throw Object.assign(new Error('Could not connect to 888API.'),{statusCode:502});}
    if(!response.ok){await response.body?.cancel?.().catch(()=>{});throw Object.assign(new Error(response.status===401||response.status===403?'888API rejected the configured token.':'888API model catalog is unavailable (HTTP '+response.status+').'),{statusCode:502});}
    let body;
    try{const raw=await response.text();if(raw.length>5*1024*1024)throw new Error('too large');body=JSON.parse(raw);}
    catch{throw Object.assign(new Error('888API returned an invalid model catalog.'),{statusCode:502});}
    if(!Array.isArray(body?.data)||!body.data.length)throw Object.assign(new Error('888API model catalog was empty. Existing models were preserved.'),{statusCode:502});
    return body;
  }
}

const {readBounded,checkOutputUrl,imageMime,IMAGE_LIMIT,VIDEO_LIMIT}=require('./vercel.js');
// Large 4K images are often returned inline as base64 JSON. The default 4 MiB
// bound is for small status/metadata responses, not image payloads.
const API888_JSON_LIMIT=4*1024*1024;
const API888_IMAGE_JSON_LIMIT=Math.ceil(IMAGE_LIMIT*4/3)+64*1024;
const {validateCanvas}=require('../image_canvas.js');

// Keep upstream refusal details for the protected Activity log, never include
// Bearer credentials, signed reference URLs, or raw request/response payloads.
function safeProviderError(value) {
  const source=value?.error?.message||value?.error?.detail||value?.message||value?.msg||
    (typeof value?.error==='string'?value.error:'');
  if(typeof source!=='string')return '';
  return source
    .replace(/https?:\/\/[^\s"'<>]+/gi,'[URL redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [redacted]')
    .replace(/\b(?:sk-|cmm_support_)[A-Za-z0-9_\-]{6,}/gi,'[secret redacted]')
    .replace(/[\r\n\t]+/g,' ').slice(0,300);
}
function safeProviderRequestId(value) {
  const id=String(value?.request_id||value?.requestId||'');
  return /^[a-zA-Z0-9_-]{4,100}$/.test(id)?id:null;
}
Api888Client.prototype.json=async function(path,body=null,timeoutMs=30000,maxBytes=API888_JSON_LIMIT){
  if(!this.apiKey)throw new Error('888API key is not configured.');
  let response;
  try{response=await this.fetch(ORIGIN+path,{method:body?'POST':'GET',
    headers:{authorization:'Bearer '+this.apiKey,accept:'application/json',...(body?{'content-type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}
  catch{throw Object.assign(new Error('888API request interrupted. Paid operations are not retried automatically.'),{statusCode:502,retryable:false});}
  // Upstream failure bodies must stay small even for image requests.
  const limit=response.ok?maxBytes:API888_JSON_LIMIT;
  const data=await readBounded(response,limit).then(b=>{try{return JSON.parse(b.toString('utf8'));}catch{return null;}});
  if(!response.ok)throw Object.assign(new Error(response.status===402?'888API balance insufficient.':response.status===401||response.status===403?'888API rejected account access.':'888API request failed (HTTP '+response.status+').'),{
    statusCode:502,providerStatus:response.status,retryable:false,
    providerMessage:safeProviderError(data),providerRequestId:safeProviderRequestId(data),
    code:typeof data?.error?.code==='string'?data.error.code.slice(0,50):undefined,
  });
  if(!data||typeof data!=='object')throw Object.assign(new Error('888API returned an invalid JSON response.'),{statusCode:502});
  return data;
};
Api888Client.prototype.videoBody=function(model,params,references=[]){
  const images=references.filter(r=>r.mimeType?.startsWith('image/'));
  if(references.length!==images.length)throw new Error('This 888API model currently supports image references only.');
  const max=Number(model.referenceCapabilities?.image?.max||0);
  if(images.length>max)throw new Error('Too many image references for this model.');
  const min=Number(model.referenceCapabilities?.image?.min||0);
  if(images.length<min)throw new Error('This 888API model requires at least '+min+' reference image'+(min===1?'':'s')+'.');
  const timeField=model.api888?.secondsField==='seconds'?'seconds':'duration';
  const duration=Number(params.duration);
  if(!Number.isInteger(duration)||duration<=0)throw new Error('Invalid 888API video length.');
  return {model:model.providerModelId,prompt:String(params.prompt||''),
    [timeField]:duration,resolution:String(params.resolution||model.defaultResolution||'720p'),
    ratio:String(params.aspectRatio||'16:9'),
    ...(images.length?{images:images.map(r=>r.url)}:{})};
};
Api888Client.prototype.startVideo=async function(model,params,references=[]){
  const data=await this.json('/v1/videos',this.videoBody(model,params,references),120000);
  const id=String(data.id||data.task_id||'');
  if(!/^[A-Za-z0-9_-]{5,191}$/.test(id))throw new Error('888API did not return a valid video job ID.');
  return id;
};
Api888Client.prototype.videoStatus=async function(id){
  if(!/^[A-Za-z0-9_-]{5,191}$/.test(String(id)))throw new Error('Invalid 888API video job.');
  const data=await this.json('/v1/videos/'+encodeURIComponent(id));
  const status=String(data.status||'').toLowerCase();
  if(['completed','succeeded','success'].includes(status))return {status:'done',url:data.url||data.video_url||data.result_url||data.task_result?.videos?.[0]?.url||null,id};
  if(['failed','cancelled','canceled'].includes(status))return {status:'failed',error:String(data.error?.message||data.error||status).slice(0,200)};
  return {status:'pending'};
};
Api888Client.prototype.download=async function(url,maxBytes=VIDEO_LIMIT){
  // 888API also returns same-origin relative /v1/videos/..../content URLs.
  const uri=String(url||'');
  const absolute=uri.startsWith('/v1/videos/')?ORIGIN+uri:uri;
  let current=checkOutputUrl(absolute);
  for(let i=0;i<5;i++){
    const authenticated=new URL(current).origin===ORIGIN && new URL(current).pathname.startsWith('/v1/videos/');
    const r=await this.fetch(current,{redirect:'manual',signal:AbortSignal.timeout(180000),
      headers:authenticated?{authorization:'Bearer '+this.apiKey}:{}});
    const next=r.headers.get('location');
    if(r.status>=300&&r.status<400&&next){current=checkOutputUrl(new URL(next,current).toString());await r.body?.cancel?.().catch(()=>{});continue;}
    if(!r.ok){await r.body?.cancel?.().catch(()=>{});throw new Error('888API output could not be retrieved.');}
    return readBounded(r,maxBytes);
  }
  throw new Error('888API output redirected too often.');
};
Api888Client.prototype.videoContent=async function(id,url){
  let data;
  if(url)data=await this.download(url,VIDEO_LIMIT);
  else{
    const path='/v1/videos/'+encodeURIComponent(id)+'/content';
    const response=await this.fetch(ORIGIN+path,{headers:{authorization:'Bearer '+this.apiKey},redirect:'manual',signal:AbortSignal.timeout(180000)});
    if(response.status>=300&&response.status<400&&response.headers.get('location')){
      data=await this.download(new URL(response.headers.get('location'),ORIGIN+path).toString(),VIDEO_LIMIT);
      await response.body?.cancel?.().catch(()=>{});
    }else{if(!response.ok)throw new Error('888API video content is not accessible.');data=await readBounded(response,VIDEO_LIMIT);}
  }
  if(!data.length||data.toString('ascii',4,8)!=='ftyp')throw new Error('888API did not return MP4 video.');
  return {data,mimeType:'video/mp4'};
};
Api888Client.prototype.generateImage=async function(model,params,refs=[]){
  if(refs.length)throw new Error('888API image editing requires the dedicated multipart adapter; choose text-to-image.');
  const result=await this.json('/v1/images/generations',{model:model.providerModelId,
    prompt:String(params.prompt||''),n:1},180000,API888_IMAGE_JSON_LIMIT);
  const item=result.data?.[0];
  let data;
  if(item?.b64_json){if(item.b64_json.length>Math.ceil(IMAGE_LIMIT*4/3)+8)throw new Error('The generated image exceeds the supported 20 MiB limit.');data=Buffer.from(item.b64_json,'base64');}
  else if(item?.url)data=await this.download(item.url,IMAGE_LIMIT);
  if(!data?.length)throw new Error('888API did not return an image.');
  if(data.length>IMAGE_LIMIT)throw new Error('The generated image exceeds the supported 20 MiB limit.');
  const mimeType=imageMime(data);
  validateCanvas(data,mimeType,params.aspectRatio);
  return {data,mimeType};
};
module.exports={Api888Client,ORIGIN};


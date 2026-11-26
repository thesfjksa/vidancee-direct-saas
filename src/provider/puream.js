'use strict';

const { BASE_URL, pureamMediaModels } = require('../puream_models.js');
const {readBounded} = require('./vercel.js');
const {openPublicVideo} = require('../remote_image.js');
const {stageVideo} = require('../staged_video.js');
const VIDEO_LIMIT=256*1024*1024;
const TIMEOUT=300000;
const safeId = value => {
  const id=String(value||'');
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(id)) throw new Error('Puream did not return a valid task ID.');
  return id;
};
function payloadFor(options,references=[]){
  const {model,prompt,duration,resolution,aspectRatio,generationMode}=options;
  const fields={image:'reference_images',video:'reference_videos',audio:'reference_audios'};
  const payload={model:model.providerModelId,prompt:String(prompt),seconds:duration,resolution,aspect_ratio:aspectRatio};
  if (generationMode) payload.generation_mode=generationMode;
  for(const ref of references){
    const kind=String(ref.mimeType||'').split('/')[0];
    const field=fields[kind];
    if (!field||!model.referenceCapabilities[kind]?.supported) throw new Error('Unsupported Puream reference type.');
    const url=new URL(ref.url);
    if(url.protocol!=='https:'||url.username||url.password)throw new Error('Puream reference URLs require HTTPS.');
    (payload[field]||=[]).push(url.toString());
  }
  // Puream labels references by media kind and array order, starting at 1.
  payload.prompt=payload.prompt.replace(/@(image|video|audio)\s*(\d+)/gi,(_,type,n)=>'@'+({image:'图片',video:'视频',audio:'音频'}[type.toLowerCase()])+n);
  for (const match of payload.prompt.matchAll(/@(图片|视频|音频)(\d+)/g)) {
    const field={'图片':'reference_images','视频':'reference_videos','音频':'reference_audios'}[match[1]];
    if(Number(match[2])<1||Number(match[2])>(payload[field]?.length||0))throw new Error('The prompt references a Puream media file that was not supplied.');
  }
  for (const [kind,field] of Object.entries(fields)) if ((payload[field]?.length||0)>model.referenceCapabilities[kind].max) throw new Error('Too many Puream references.');
  if(model.puream?.audioRequiresVisual && payload.reference_audios?.length && !payload.reference_images?.length && !payload.reference_videos?.length)throw new Error('This Puream model requires visual references with audio.');
  if(references.length>model.referenceCapabilities.totalMax)throw new Error('Too many Puream reference files.');
  return payload;
}
class PureamClient {
  constructor({apiKey='',fetchImpl=fetch,fetchMedia=openPublicVideo}={}){this.apiKey=String(apiKey).trim();this.fetch=fetchImpl;this.fetchMedia=fetchMedia;}
  async request(path,{method='GET',body,idempotencyKey,timeoutMs=40000}={}){
    if(!this.apiKey)throw new Error('Save a Puream authorization code in Admin.');
    if(!/^\/(?:models|videos(?:\/[a-zA-Z0-9_-]+(?:\/content)?)?)$/.test(path))throw new Error('Invalid Puream request path.');
    let response;
    try {response=await this.fetch(BASE_URL+path,{method,redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{authorization:'Bearer '+this.apiKey,accept:path.endsWith('/content')?'video/mp4':'application/json',...(body?{'content-type':'application/json','Idempotency-Key':idempotencyKey}:{}),...(path.endsWith('/content')?{'accept-encoding':'identity'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch {throw Object.assign(new Error('Puream connection timed out or failed.'),{ambiguous:method==='POST',code:'PUREAM_CONNECTION'});}
    if(!response.ok && !(path.endsWith('/content')&&response.status>=300&&response.status<400)){
      await response.body?.cancel?.().catch(()=>{});
      throw Object.assign(new Error('Puream returned HTTP '+response.status+'.'),{providerStatus:response.status,statusCode:response.status===402?402:502,ambiguous:method==='POST'&&response.status>=500,code:response.status===402?'INSUFFICIENT_BALANCE':'PUREAM_HTTP'});
    }
    return response;
  }
  async json(path,options){
    const response=await this.request(path,options);
    try{return JSON.parse((await readBounded(response,4*1024*1024)).toString('utf8'));}
    catch {throw Object.assign(new Error('Puream returned an invalid JSON response.'),{ambiguous:options?.method==='POST'});}
  }
  async models(){const result=await this.json('/models');pureamMediaModels(result);return result;}
  async startVideo(payload,key){
    if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key))throw new Error('Invalid Puream idempotency key.');
    const result=await this.json('/videos',{method:'POST',body:payload,idempotencyKey:key,timeoutMs:90000});
    const task=result?.data||result;
    try{return {requestId:safeId(task.id||task.task_id),quotedCny:Number(task.quoted_charge_yuan)};}
    catch {throw Object.assign(new Error('Puream accepted the request without a task ID.'),{ambiguous:true});}
  }
  async videoStatus(id){
    const result=await this.json('/videos/'+safeId(id));const task=result?.data||result;
    const code=String(task.error?.code||'');
    return {status:task.status,billingStatus:task.billing_status,chargeCny:task.charge_yuan==null?null:Number(task.charge_yuan),
      errorCode:/^[A-Z0-9_-]{1,80}$/i.test(code)?code:null};
  }
  async download(id){
    const response=await this.request('/videos/'+safeId(id)+'/content',{timeoutMs:TIMEOUT});
    let media={body:response.body,contentLength:response.headers.get('content-length')};
    if(response.status>=300&&response.status<400){
      const location=response.headers.get('location');await response.body?.cancel?.().catch(()=>{});
      if(!location)throw new Error('Puream download link was missing.');
      const url=new URL(location,BASE_URL);
      if(url.protocol!=='https:'||url.username||url.password)throw new Error('Puream returned an invalid download link.');
      // Never forward the authorization code to the media host.
      media=await this.fetchMedia(url.href,{accept:'video/mp4',maxBytes:VIDEO_LIMIT,timeoutMs:TIMEOUT});
    }
    return stageVideo(media.body,{contentLength:media.contentLength,maxBytes:VIDEO_LIMIT});
  }
}
module.exports={PureamClient,payloadFor};

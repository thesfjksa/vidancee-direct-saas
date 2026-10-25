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
  // Public endpoint behind 888API's pricing-page status labels; needs no key.
  async modelHealth(){
    let response;
    try{response=await this.fetch(ORIGIN+'/api/model-health',{method:'GET',headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});}
    catch{throw Object.assign(new Error('Could not connect to 888API model health.'),{statusCode:502});}
    if(!response.ok){await response.body?.cancel?.().catch(()=>{});throw Object.assign(new Error('888API model health is unavailable (HTTP '+response.status+').'),{statusCode:502});}
    let body;
    try{const raw=await response.text();if(raw.length>5*1024*1024)throw new Error('too large');body=JSON.parse(raw);}
    catch{throw Object.assign(new Error('888API returned invalid model health.'),{statusCode:502});}
    if(!Array.isArray(body?.data)||!body.data.length)throw Object.assign(new Error('888API model health was empty.'),{statusCode:502});
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
  let source=value?.error?.message||value?.error?.detail||value?.message||value?.msg||
    (typeof value?.error==='string'?value.error:'');
  // 888API relays upstream errors as JSON inside the message string, sometimes
  // twice over. Unwrap to the innermost human-readable message.
  for(let depth=0;depth<3&&typeof source==='string'&&/^\s*\{/.test(source);depth++){
    let inner;try{inner=JSON.parse(source);}catch{inner=null;}
    let next=inner?.error?.message||inner?.message||inner?.msg||(typeof inner?.error==='string'?inner.error:'');
    if(!inner){
      // Truncated relay: take the last "message" value that is plain text.
      const found=[...source.matchAll(/\\*"message\\*"\s*:\s*\\*"([^"\\{]+)/g)].pop();
      next=found?found[1].trim():'';
    }
    if(typeof next!=='string'||!next)break;
    source=next;
  }
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
// GET checks are idempotent. Only an existing task may be queried again;
// NEVER retry POST /v1/videos or POST /v1/images/generations.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function networkKind(error){
  const name=String(error?.name||'');
  return name==='TimeoutError'||name==='AbortError'?'timeout':'connection';
}
function safeNetworkCode(error){
  const code=String(error?.cause?.code||error?.code||'').slice(0,50);
  return /^[A-Z][A-Z0-9_]{1,49}$/.test(code)?code:null;
}
Api888Client.prototype.json=async function(path,body=null,timeoutMs=30000,maxBytes=API888_JSON_LIMIT){
  if(!this.apiKey)throw new Error('888API key is not configured.');
  const isGet=body==null;
  const isVideoStatus=isGet&&/^\/v1\/videos\/[A-Za-z0-9_-]+$/.test(path);
  // Provider documentation recommends 60s timeout on video task reads.
  const requestTimeout=isVideoStatus?Math.max(timeoutMs,60000):timeoutMs;
  const attempts=isVideoStatus?2:1;
  for(let attempt=1;attempt<=attempts;attempt++){
    let response;
    try{
      response=await this.fetch(ORIGIN+path,{method:isGet?'GET':'POST',
        headers:{authorization:'Bearer '+this.apiKey,accept:'application/json',...(!isGet?{'content-type':'application/json'}:{})},
        body:isGet?undefined:JSON.stringify(body),signal:AbortSignal.timeout(requestTimeout),redirect:'error'});
    }catch(error){
      // A GET may be safely repeated; a POST may have been charged upstream.
      if(isVideoStatus&&attempt<attempts){await sleep(500);continue;}
      throw Object.assign(new Error(isVideoStatus?'888API video status request interrupted; original task will be checked again.':
        '888API request interrupted. Paid operations are not retried automatically.'),{
        statusCode:502,retryable:isVideoStatus,requestMethod:isGet?'GET':'POST',
        failureType:networkKind(error),networkCode:safeNetworkCode(error),
        attempts:attempt,timeoutMs:requestTimeout,
      });
    }
    if(isVideoStatus&&attempt<attempts&&[429,502,503,504].includes(response.status)){
      await response.body?.cancel?.().catch(()=>{});
      await sleep(500);
      continue;
    }
    // Upstream failure bodies stay small even for large image responses.
    const limit=response.ok?maxBytes:API888_JSON_LIMIT;
    const data=await readBounded(response,limit).then(b=>{try{return JSON.parse(b.toString('utf8'));}catch{return null;}});
    // Keep 888API's own (redacted) reason, e.g. no available channel for a
    // model, so a failed generation explains itself without the Admin log.
    const providerMessage=safeProviderError(data);
    if(!response.ok)throw Object.assign(new Error(response.status===402?'888API balance insufficient.':response.status===401||response.status===403?'888API rejected account access.':
      '888API request failed (HTTP '+response.status+')'+(providerMessage?': '+providerMessage.slice(0,200):'.')),{
      statusCode:502,providerStatus:response.status,retryable:isVideoStatus&&[429,502,503,504].includes(response.status),
      providerMessage,providerRequestId:safeProviderRequestId(data),
      requestMethod:isGet?'GET':'POST',attempts:attempt,
      code:typeof data?.error?.code==='string'?data.error.code.slice(0,50):undefined,
    });
    if(!data||typeof data!=='object')throw Object.assign(new Error('888API returned an invalid JSON response.'),{statusCode:502});
    return data;
  }
};
Api888Client.prototype.videoBody=function(model,params,references=[]){
  const images=references.filter(r=>r.mimeType?.startsWith('image/'));
  const videos=references.filter(r=>r.mimeType?.startsWith('video/'));
  const audios=references.filter(r=>r.mimeType?.startsWith('audio/'));
  if(references.length!==images.length+videos.length+audios.length)
    throw new Error('Unsupported 888API reference media type.');
  const caps=model.referenceCapabilities||{};
  for(const [type,items] of [['image',images],['video',videos],['audio',audios]]){
    const capability=caps[type]||{};
    const max=Number(capability.max||0),min=Number(capability.min||0);
    if(items.length>max||(!capability.supported&&items.length))
      throw new Error('This 888API model accepts at most '+max+' '+type+' reference'+(max===1?'':'s')+'.');
    if(items.length<min)
      throw new Error('This 888API model requires at least '+min+' reference '+type+(min===1?'':'s')+'.');
  }
  if(Number(caps.totalMax)>0&&references.length>Number(caps.totalMax))
    throw new Error('Too many reference files for this 888API model.');
  if(videos.length&&!['videos','video_urls','reference_videos','referenceVideos'].includes(model.api888?.videoField))
    throw new Error('888API video reference transport is not configured for this model.');
  if(audios.length&&!['audios','audio_urls','metadata.audios','referenceAudios'].includes(model.api888?.audioField))
    throw new Error('888API audio reference transport is not configured for this model.');
  // sd_2.0_mini_special rejects audio unless an image or video accompanies it.
  if(model.providerModelId==='sd_2.0_mini_special'&&audios.length&&!images.length&&!videos.length)
    throw new Error('This 888API model needs a reference image or video with reference audio.');
  if(references.some(r=>!/^https:\/\//i.test(String(r.url||''))))
    throw new Error('888API references need HTTPS direct media URLs.');
  const timeField=model.api888?.secondsField==='seconds'?'seconds':'duration';
  const duration=Number(params.duration);
  if(!Number.isInteger(duration)||duration<=0)throw new Error('Invalid 888API video length.');
  const ratio=String(params.aspectRatio||model.defaultAspectRatio||'16:9');
  if(Array.isArray(model.aspectRatios)&&model.aspectRatios.length&&!model.aspectRatios.includes(ratio))
    throw new Error('Unsupported aspect ratio for this 888API model.');
  const imageField=model.api888?.imageField||'images';
  if(!['images','image_urls','referenceImages'].includes(imageField))
    throw new Error('888API image reference transport is not supported.');
  const id=String(model.providerModelId||'');
  // Sora 2 fixed-SKU task endpoint: never send generic time, size, ratio, or
  // resolution keys. Image-to-video uses nested input_reference, not images[].
  if(/^sora2-(?:pro-)?(?:4|8|12)s-(?:16x9|9x16)$/.test(id)){
    const match=id.match(/-(4|8|12)s-(16x9|9x16)$/);
    const fixedSeconds=Number(match[1]),fixedRatio=match[2]==='16x9'?'16:9':'9:16';
    if(duration!==fixedSeconds||ratio!==fixedRatio)
      throw new Error('Sora 2 duration and ratio are fixed by the model ID.');
    const payload={model:id,prompt:String(params.prompt||'')};
    if(images.length)payload.input_reference={type:'input_image',image_url:{url:images[0].url}};
    return payload;
  }
  // Grok expects pixels in size, a string seconds and a singular image_url.
  if(/^grok-imagine-(?:1\.0-video|video(?:-preview|-1\.5-preview|-1\.5-fast)?)$/.test(id)){
    if(!['16:9','9:16'].includes(ratio))throw new Error('Unsupported Grok output ratio.');
    if(Array.isArray(model.durations)&&!model.durations.includes(duration))
      throw new Error('Unsupported Grok duration for this model.');
    const payload={model:id,prompt:String(params.prompt||''),seconds:String(duration),
      size:ratio==='16:9'?'1280x720':'720x1280'};
    if(images.length)payload.image_url=images[0].url;
    return payload;
  }
  const body={model:model.providerModelId,prompt:String(params.prompt||''),
    // 888API Go Alias seconds input requires a JSON string.
    [timeField]:timeField==='seconds'?String(duration):duration,
    resolution:String(params.resolution||model.defaultResolution||'720p'),
    ratio};
  // Jimeng fast-VIP requires functionMode, and the documented first/last
  // frame mode accepts at most two image URLs. No multipart A/V claims here.
  if(id==='jimeng-video-seedance-2.0-fast-vip')body.functionMode='first_last_frames';
  if(images.length)body[imageField]=images.map(r=>r.url);
  if(videos.length)body[model.api888.videoField]=videos.map(r=>r.url);
  if(audios.length){
    if(model.api888.audioField==='metadata.audios')body.metadata={audios:audios.map(r=>r.url)};
    else body[model.api888.audioField]=audios.map(r=>r.url);
  }
  return body;
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
  // Some 888API gateways additionally send task_status (e.g. SUCCESS / FAILURE).
  // Only use it when the top-level status is absent or unrecognized.
  const fallback=String(data.task_status||'').toLowerCase();
  const normalize=(value)=>{
    if(['completed','succeeded','success'].includes(value))return 'done';
    if(['failed','failure','cancelled','canceled'].includes(value))return 'failed';
    if(['queued','pending','submitted','processing','in_progress','running'].includes(value))return 'pending';
    return null;
  };
  const normalized=normalize(status)||normalize(fallback);
  const progress=typeof data.progress==='number'&&Number.isFinite(data.progress)
    ?Math.max(0,Math.min(100,data.progress)):null;
  if(normalized==='done')return {status:'done',url:data.url||data.video_url||data.result_url||data.task_result?.videos?.[0]?.url||null,
    id,providerStatus:status||fallback,progress};
  if(normalized==='failed')return {status:'failed',error:safeProviderError(data)||'888API reported generation failure.',
    id,providerStatus:status||fallback,progress};
  if(normalized==='pending')return {status:'pending',id,providerStatus:status||fallback,progress};
  throw Object.assign(new Error('888API returned an unrecognized video task status.'),{
    statusCode:502,providerStatus:200,
    providerMessage:String(status||fallback||'missing').replace(/[^a-z0-9_-]/gi,'').slice(0,50),
  });
};
// Only completed video downloads may use literal public IPv4 media servers.
// Literal addresses avoid DNS rebinding; private, special-use and metadata
// ranges stay blocked. Never forward provider credentials to these servers.
function publicIpv4(host) {
  if(require('node:net').isIP(host)!==4)return false;
  const [a,b,c]=host.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||
    a===100&&b>=64&&b<=127||a===169&&b===254||
    a===172&&b>=16&&b<=31||
    a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||
    a===198&&(b===18||b===19||b===51&&c===100)||
    a===203&&b===0&&c===113||host==='168.63.129.16');
}
// DNS media hosts retain the existing HTTPS-only policy. HTTP literal public
// IPv4 links are accepted only by the video path, without HTTPS rewriting:
// these provider media servers may not offer TLS on their custom port.
function publicMediaUrl(raw,base=ORIGIN,allowPublicIp=false){
  const value=String(raw||'').trim();
  const shape=/^https?:\/\//i.test(value)?'absolute':
    value.startsWith('//')?'protocol_relative':
    value.startsWith('/')||/^v1\/videos\//i.test(value)?'provider_relative':'other';
  const classify=(error,uri)=>{
    const host=String(uri?.hostname||'').toLowerCase();
    const hostnameType=!host?'missing':host==='localhost'||host.endsWith('.local')?'local':
      /^\d+\.\d+\.\d+\.\d+$/.test(host)||host.includes(':')?'ip':'dns';
    const scheme=String(uri?.protocol||'invalid').replace(/[^a-z0-9:]/gi,'').slice(0,20);
    const port=uri?.port?'custom':'default';
    return Object.assign(new Error('888API returned an unsupported video download URL ('+
      'shape='+shape+', scheme='+scheme+', target='+hostnameType+', port='+port+').'),{
      statusCode:502,mediaUrlShape:shape,mediaUrlScheme:scheme,
      mediaUrlTarget:hostnameType,mediaUrlPort:port,cause:error,
    });
  };
  let target;
  try {
    if(!value)throw new Error('empty');
    if(shape==='other')throw new Error('unrecognized relative URL');
    const input=shape==='provider_relative'&&!value.startsWith('/')?'/'+value:value;
    target=new URL(input,base);
    if(allowPublicIp&&['http:','https:'].includes(target.protocol)&&
       !target.username&&!target.password&&publicIpv4(target.hostname))return target.toString();
    if(target.protocol==='http:'){
      // HTTPS upgrade is allowed only for regular DNS hosts. Reject raw IPs
      // and hostnames that may point to local infrastructure.
      const host=target.hostname.toLowerCase();
      if(target.port&&target.port!=='80'||host==='localhost'||host.endsWith('.local')||
         host.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(host))
        throw new Error('unsafe HTTP target');
      target.protocol='https:';
      target.port='';
    }
    if(target.protocol!=='https:')throw new Error('non-HTTPS target');
    return checkOutputUrl(target.toString());
  }catch(error){throw classify(error,target);}
}

Api888Client.prototype.download=async function(url,maxBytes=VIDEO_LIMIT,{allowPublicIp=false}={}){
  // 888API also returns same-origin relative /v1/videos/..../content URLs.
  let current=publicMediaUrl(url,ORIGIN,allowPublicIp);
  for(let i=0;i<5;i++){
    const authenticated=new URL(current).origin===ORIGIN && new URL(current).pathname.startsWith('/v1/videos/');
    const r=await this.fetch(current,{redirect:'manual',signal:AbortSignal.timeout(180000),
      headers:authenticated?{authorization:'Bearer '+this.apiKey}:{}});
    const next=r.headers.get('location');
    if(r.status>=300&&r.status<400&&next){await r.body?.cancel?.().catch(()=>{});current=publicMediaUrl(next,current,allowPublicIp);continue;}
    if(!r.ok){await r.body?.cancel?.().catch(()=>{});throw new Error('888API output could not be retrieved.');}
    return readBounded(r,maxBytes);
  }
  throw new Error('888API output redirected too often.');
};
// Video downloads are idempotent GET requests. An upstream status result may
// contain an expired link while the official authenticated /content endpoint
// still works, so use the latter as a bounded fallback. Never retry a paid POST.
Api888Client.prototype.videoContent=async function(id,url){
  if(!/^[A-Za-z0-9_-]{5,191}$/.test(String(id)))throw new Error('Invalid 888API video job.');
  const validMp4=bytes=>Buffer.isBuffer(bytes)&&bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp';
  let directError=null;
  if(url){
    try{
      const result=await this.download(url,VIDEO_LIMIT,{allowPublicIp:true});
      if(validMp4(result))return {data:result,mimeType:'video/mp4'};
      throw new Error('Provider URL did not return an MP4 file.');
    }catch(error){directError=error;}
  }
  try{
    const path='/v1/videos/'+encodeURIComponent(id)+'/content';
    const response=await this.fetch(ORIGIN+path,{headers:{authorization:'Bearer '+this.apiKey},
      redirect:'manual',signal:AbortSignal.timeout(180000)});
    let data;
    if(response.status>=300&&response.status<400&&response.headers.get('location')){
      const location=response.headers.get('location');
      await response.body?.cancel?.().catch(()=>{});
      data=await this.download(publicMediaUrl(location,ORIGIN+path,true),VIDEO_LIMIT,{allowPublicIp:true});
    }else{
      if(!response.ok){
        await response.body?.cancel?.().catch(()=>{});
        throw Object.assign(new Error('Authenticated 888API content endpoint returned HTTP '+response.status+'.'),
          {providerStatus:response.status});
      }
      data=await readBounded(response,VIDEO_LIMIT);
    }
    if(!validMp4(data))throw new Error('Authenticated 888API content endpoint did not return MP4 video.');
    return {data,mimeType:'video/mp4'};
  }catch(contentError){
    const parts=[];
    if(directError)parts.push('Provider URL: '+safeProviderError({message:directError.message}));
    parts.push('Content endpoint: '+safeProviderError({message:contentError.message}));
    // Two independently obtained provider links both point to an unsafe
    // HTTP raw-IP/custom-port target. Retrying the same completed task cannot
    // make those locations safe; fail/refund locally rather than show a spinner
    // and misleading "resumes automatically" warning for three hours.
    const unsafeProviderLink=error=>error?.mediaUrlTarget==='ip'&&error?.mediaUrlPort==='custom';
    const permanentlyInaccessible=unsafeProviderLink(directError)&&unsafeProviderLink(contentError);
    throw Object.assign(new Error('888API completed video could not be downloaded using either available GET route.'),{
      statusCode:502,recoveryStage:'video.download',
      providerMessage:parts.join(' | ').slice(0,350),
      providerStatus:contentError.providerStatus||directError?.providerStatus||null,
      networkCode:safeNetworkCode(contentError)||safeNetworkCode(directError),
      // No raw download URL, IP address or port is stored in diagnostics.
      unretrievableOutput:permanentlyInaccessible,
      providerOutputProblem:permanentlyInaccessible?'unsafe_upstream_media_url':null,
    });
  }
};
Api888Client.prototype.generateImage=async function(model,params,refs=[]){
  if(refs.length)throw new Error('888API image editing requires the dedicated multipart adapter; choose text-to-image.');
  const ratio=String(params.aspectRatio||'1:1');
  const size=require('../api888_models.js').api888ImageSize(model.providerModelId,ratio);
  if(!size)throw new Error('Unsupported aspect ratio for this 888API image model.');
  const result=await this.json('/v1/images/generations',{model:model.providerModelId,
    prompt:String(params.prompt||''),n:1,size},180000,API888_IMAGE_JSON_LIMIT);
  const item=result.data?.[0];
  let data;
  if(item?.b64_json){if(item.b64_json.length>Math.ceil(IMAGE_LIMIT*4/3)+8)throw new Error('The generated image exceeds the supported 20 MiB limit.');data=Buffer.from(item.b64_json,'base64');}
  else if(item?.url)data=await this.download(item.url,IMAGE_LIMIT);
  if(!data?.length)throw new Error('888API did not return an image.');
  if(data.length>IMAGE_LIMIT)throw new Error('The generated image exceeds the supported 20 MiB limit.');
  const mimeType=imageMime(data);
  validateCanvas(data,mimeType,ratio);
  return {data,mimeType};
};
module.exports={Api888Client,ORIGIN,publicMediaUrl};



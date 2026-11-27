'use strict';
const {BASE_URL,huiquMediaModels}=require('../huiqu_models');
const {readBounded}=require('./vercel');
const {openPublicVideo}=require('../remote_image');
const {stageVideo}=require('../staged_video');
const {createHash}=require('node:crypto');
const VIDEO_LIMIT=256*1024*1024;
const fingerprint=key=>createHash('sha256').update(key).digest('hex');
const taskId=value=>{const id=String(value||'');if(!/^[a-zA-Z0-9_-]{1,191}$/.test(id))throw new Error('Invalid generation task ID.');return id;};

function payloadFor(model,options,refs){
  const spec=model.huiqu;
  if(!model.adapterSupported||!spec||!['videos','generations'].includes(spec.route))throw new Error('This video route is not ready.');
  const media={image:[],video:[],audio:[]};
  for(const ref of refs){
    const kind=String(ref.mimeType||'').split('/')[0];
    const url=new URL(ref.url);
    if(!media[kind]||!model.referenceCapabilities[kind]?.supported||url.protocol!=='https:'||url.username||url.password||url.href.length>2048)
      throw new Error('Unsupported video reference.');
    media[kind].push(url.href);
  }
  let total=0;
  for(const [kind,urls] of Object.entries(media)){
    const caps=model.referenceCapabilities[kind];total+=urls.length;
    if(urls.length>caps.max||urls.length<caps.min)throw new Error('Invalid reference count.');
  }
  if(total>model.referenceCapabilities.totalMax||(!model.referenceCapabilities.textOnly&&!total))throw new Error('Invalid total reference count.');
  if(media.video.length&&(options.duration<(spec.minVideoDuration||0)||options.duration>(spec.maxVideoDuration||Infinity)))throw new Error('Unsupported duration with video references.');
  const translate=spec.contract!=='reference';
  const prompt=String(options.prompt).replace(/@(image|video|audio)\s*(\d+)/gi,(_,kind,n)=>{
    const k=kind.toLowerCase();
    if(+n<1||+n>media[k].length)throw new Error('Prompt refers to a missing reference file.');
    return translate?'@'+({image:'图片',video:'视频',audio:'音频'}[k])+n:'@'+k+n;
  });
  const payload={model:model.providerModelId,prompt,seconds:options.duration,aspect_ratio:options.aspectRatio};
  const add=(obj,k,v)=>{if(v.length)obj[k]=v;};
  if(spec.contract==='reference'){
    for(const k of Object.keys(media))add(payload,'reference_'+k+'_urls',media[k]);
  }else{
    add(payload,'images',media.image);
    if(spec.contract==='metadata'){
      const metadata={};add(metadata,'video_urls',media.video);add(metadata,'audio_urls',media.audio);
      if(Object.keys(metadata).length)payload.metadata=metadata;
    }else if(spec.contract==='direct'){
      add(payload,'videos',media.video);add(payload,/5-28s$/.test(model.providerModelId)?'audios':'audio_urls',media.audio);
    }else{
      add(payload,'video_urls',media.video);add(payload,'audio_urls',media.audio);
    }
    if(spec.contract==='muse'){delete payload.aspect_ratio;payload.size=options.aspectRatio;payload.duration=options.duration;}
  }
  return payload;
}
class HuiquClient {
  constructor({apiKey='',group=require('../huiqu_models').GROUP,fetchImpl=fetch,fetchMedia=openPublicVideo}={}){this.apiKey=String(apiKey).trim();this.group=group;this.fetch=fetchImpl;this.fetchMedia=fetchMedia;}
  async request(path,{method='GET',body,auth=true,timeoutMs=40000}={}){
    if(auth&&!this.apiKey)throw new Error('Save a Huiqu video-group API key first.');
    let response;
    try{response=await this.fetch(BASE_URL+path,{method,redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{accept:'application/json',...(auth?{authorization:'Bearer '+this.apiKey}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch{throw Object.assign(new Error('Video service connection failed.'),{ambiguous:method==='POST'});}
    if(!response.ok&&!(path.endsWith('/content')&&response.status>=300&&response.status<400)){
      // Only a classification is kept; provider response bodies may contain private data.
      let payment=response.status===402;
      if(method==='POST'&&!payment){
        try{const parsed=JSON.parse((await readBounded(response,65536)).toString('utf8'));payment=/^(insufficient_quota|insufficient_balance|insufficient_credits|payment_required)$/i.test(String(parsed?.error?.code||''))||require('../provider_errors').backendFailureMessage(parsed?.error,'')!=='';}catch{}
      }
      await response.body?.cancel?.().catch(()=>{});
      throw Object.assign(new Error('Video service returned HTTP '+response.status+'.'),{providerStatus:response.status,statusCode:payment?402:502,ambiguous:method==='POST'&&(response.status>=500||response.status===408||response.status>=300&&response.status<400)});
    }
    return response;
  }
  async json(path,options={}){
    const response=await this.request(path,options);
    try{return JSON.parse((await readBounded(response,8*1024*1024)).toString('utf8').replace(/^\uFEFF/,'').trim());}
    catch{throw Object.assign(new Error('Video service returned an unreadable response.'),{ambiguous:options.method==='POST'});}
  }
  async models(){
    if(!this.inFlight)this.inFlight=(async()=>{
      const [pricing,account]=await Promise.all([this.json('/api/pricing',{auth:false}),this.apiKey?this.json('/v1/models'):null]);
      const rows=huiquMediaModels(pricing,account,this.group);
      // Avoid leaking a key or accepting a prior account's inventory.
      for(const row of rows)row.options.huiqu.credential=this.apiKey?fingerprint(this.apiKey):null;
      return rows;
    })().finally(()=>{this.inFlight=null;});
    return this.inFlight;
  }
  async startVideo(model,body){
    const path=model.huiqu.route==='generations'?'/v1/videos/generations':'/v1/videos';
    const result=await this.json(path,{method:'POST',body,timeoutMs:90000});
    try{return {requestId:taskId(result.task_id||result.id||result.data?.task_id||result.data?.id)};}
    catch{throw Object.assign(new Error('Video submission receipt not confirmed.'),{ambiguous:true});}
  }
  async videoStatus(id){
    const result=await this.json('/v1/videos/'+taskId(id));
    const raw=String(result.status||result.data?.status||'').toLowerCase();
    const status=['completed','succeeded','success'].includes(raw)?'completed':['failed','error','cancelled','canceled'].includes(raw)?'failed':'pending';
    return {status,url:result.data?.result_url||result.metadata?.url||result.url||result.video_url||result.content?.video_url||null,
      // Never show raw upstream response content to a customer.
      errorCode:typeof result.error?.code==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(result.error.code)?result.error.code:null};
  }
  async download(id,url){
    let media;
    if(url){
      const parsed=new URL(url);
      if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('Invalid video output URL.');
      media=await this.fetchMedia(parsed.href,{accept:'video/mp4',maxBytes:VIDEO_LIMIT,timeoutMs:300000});
    }else{
      const response=await this.request('/v1/videos/'+taskId(id)+'/content',{timeoutMs:300000});
      if(response.status>=300&&response.status<400){
        const location=response.headers.get('location');await response.body?.cancel?.().catch(()=>{});
        if(!location)throw new Error('Video output redirect has no URL.');
        const target=new URL(location,BASE_URL);
        if(target.protocol!=='https:'||target.username||target.password)throw new Error('Invalid video output redirect.');
        media=await this.fetchMedia(target.href,{accept:'video/mp4',maxBytes:VIDEO_LIMIT,timeoutMs:300000});
      }else media={body:response.body,contentLength:response.headers.get('content-length')};
    }
    return stageVideo(media.body,{contentLength:media.contentLength,maxBytes:VIDEO_LIMIT});
  }
}
// Keep a single public SKU; use the least expensive verified group. A failed
// account read aborts sync rather than silently removing that group's routes.
class HuiquGroupPool {
  constructor(settings,{clientFactory=o=>new HuiquClient(o)}={}){
    this.entries=require('../huiqu_credentials').credentials(settings).map(row=>({...row,client:clientFactory({apiKey:row.apiKey,group:row.group})}));
  }
  forCredential(id,{activeOnly=false}={}){return this.entries.find(e=>e.id===id&&(!activeOnly||e.enabled))?.client||null;}
  async models(){
    const active=this.entries.filter(e=>e.enabled);
    if(!active.length)return new HuiquClient().models();
    const lists=await Promise.all(active.map(e=>e.client.models()));
    const byId=new Map();
    for(const row of lists.flat()){
      const prev=byId.get(row.providerModelId);
      const ready=row.options.adapterSupported,wasReady=prev?.options.adapterSupported;
      if(!prev||(ready&&(!wasReady||row.options.huiqu.price.priceCny<prev.options.huiqu.price.priceCny))||(!ready&&!wasReady&&row.options.huiqu.accessible&&!prev.options.huiqu.accessible))byId.set(row.providerModelId,row);
    }
    return [...byId.values()];
  }
}
module.exports={HuiquClient,HuiquGroupPool,payloadFor,fingerprint};

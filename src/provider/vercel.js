'use strict';

const { validateCanvas } = require('../image_canvas.js');
const { imageDimensions, videoDimensions } = require('../vercel_models.js');
const ORIGIN='https://ai-gateway.vercel.sh';
const IMAGE_LIMIT=20*1024*1024,VIDEO_LIMIT=64*1024*1024;

async function readBounded(response,max) {
  if (Number(response.headers.get('content-length'))>max) throw new Error('The generated file exceeds the supported size limit.');
  const chunks=[];let total=0;
  try {
    for await (const chunk of response.body) {
      total+=chunk.length;
      if(total>max) throw new Error('The generated file exceeds the supported size limit.');
      chunks.push(Buffer.from(chunk));
    }
  } catch(error) { await response.body?.cancel?.().catch(()=>{});throw error; }
  return Buffer.concat(chunks,total);
}

function imageMime(data) {
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';
  if(data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP')return 'image/webp';
  throw new Error('The model returned an unsupported image format.');
}

function checkOutputUrl(value) {
  const u=new URL(value);
  const h=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||
    h==='localhost'||h.endsWith('.local')||h.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(h))
    throw new Error('The model returned an invalid media URL.');
  return u.toString();
}

class VercelGatewayClient {
  constructor({apiKey='',fetchImpl=fetch}={}) {this.apiKey=apiKey;this.fetch=fetchImpl;}
  async request(path,{body,modelId,timeoutMs=20000,maxBytes=2*1024*1024,idempotencyKey}={}) {
    if(!this.apiKey&&!path.startsWith('/v1/models'))throw new Error('Save an AI Gateway API key in Admin first.');
    const headers={'content-type':'application/json'};
    if(this.apiKey)headers.authorization='Bearer '+this.apiKey;
    if(idempotencyKey)headers['idempotency-key']=String(idempotencyKey);
    if(path.startsWith('/v4/ai/'))Object.assign(headers,{'ai-gateway-protocol-version':'0.0.1',
      'ai-gateway-auth-method':'api-key','ai-video-model-specification-version':'4','ai-model-id':modelId});
    let response;
    try {response=await this.fetch(ORIGIN+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,
      signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}
    catch {throw Object.assign(new Error('AI Gateway could not be reached. Please try again later.'),{statusCode:502,retryable:true});}
    if(!response.ok) {
      // Vercel's own explanation, for the activity log (never shown to customers).
      const detail=await readBounded(response,4096).then(b=>b.toString('utf8').replace(/\s+/g,' ').slice(0,300)).catch(()=>'');
      const text=response.status===401||response.status===403?'AI Gateway rejected the API credentials or model access.':
        response.status===402?'AI Gateway has insufficient credits.':
          response.status===429?'AI Gateway rate limit reached. Please try later.':
            'AI Gateway request failed (HTTP '+response.status+').';
      throw Object.assign(new Error(text),{statusCode:502,providerStatus:response.status,providerMessage:detail||undefined,retryable:response.status===429||response.status>=500});
    }
    try {return JSON.parse((await readBounded(response,maxBytes)).toString('utf8'));}
    catch {throw Object.assign(new Error('AI Gateway returned an invalid response.'),{statusCode:502,retryable:true});}
  }
  async catalog() {return this.request('/v1/models'+(this.apiKey?'?include_availability':''),{maxBytes:8*1024*1024});}
  async credits() {return this.request('/v1/credits');}
  async download(url,maxBytes) {
    let current=checkOutputUrl(url);
    for(let hop=0;hop<4;hop++) {
      const r=await this.fetch(current,{signal:AbortSignal.timeout(90000),redirect:'manual'});
      if(r.status>=300&&r.status<400&&r.headers.get('location')) {
        current=checkOutputUrl(new URL(r.headers.get('location'),current).toString());
        await r.body?.cancel?.().catch(()=>{});continue;
      }
      if(!r.ok) {await r.body?.cancel?.().catch(()=>{});throw new Error('The generated media could not be downloaded.');}
      return readBounded(r,maxBytes);
    }
    throw new Error('The generated media redirected too many times.');
  }
  async generateImage(model,params,images=[]) {
    const base={model:model.providerModelId,n:1,prompt:params.prompt};
    let body,path;
    if(model.gatewayType==='language') {
      path='/v1/chat/completions';
      const content=[{type:'text',text:params.prompt},...images.map(image=>({type:'image_url',image_url:{url:image.url}}))];
      body={model:base.model,messages:[{role:'user',content}],modalities:['text','image'],stream:false,
        providerOptions:{google:{responseModalities:['IMAGE'],imageConfig:{aspectRatio:params.aspectRatio,
          ...(params.imageSize?{imageSize:params.imageSize}:{})}}}};
    } else {
      path=images.length?'/v1/images/edits':'/v1/images/generations';
      body={...base,response_format:'b64_json',size:imageDimensions(model,params),
        ...(params.quality?{quality:params.quality}:{}),
        ...(images.length?{images:images.map(i=>({image_url:i.url}))}:{})};
      // Aspect ratio is a gateway extension; size always reflects the selected
      // orientation as well, so no request can accidentally retain square size.
      if(!model.providerModelId.startsWith('openai/'))body.aspect_ratio=params.aspectRatio;
      if(!model.providerModelId.startsWith('openai/'))body.aspectRatio=params.aspectRatio;
      if(model.providerModelId.startsWith('spacexai/')){
        delete body.size;body.providerOptions={xai:{aspectRatio:params.aspectRatio,...(params.quality?{quality:params.quality}:{})}};
      }
    }
    const result=await this.request(path,{body,timeoutMs:300000,maxBytes:32*1024*1024});
    const output=result.data?.[0]||result.choices?.[0]?.message?.images?.[0];
    let data;
    const url=output?.image_url?.url||output?.url;
    if(output?.b64_json) {
      if(output.b64_json.length>Math.ceil(IMAGE_LIMIT*4/3)+8)throw new Error('The generated image is too large.');
      data=Buffer.from(output.b64_json,'base64');
    } else if(url?.startsWith('data:')) {
      const match=url.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/);
      if(!match||match[2].length>Math.ceil(IMAGE_LIMIT*4/3)+8)throw new Error('The model returned an unsupported image.');
      data=Buffer.from(match[2],'base64');
    } else if(url) data=await this.download(url,IMAGE_LIMIT);
    if(!data?.length||data.length>IMAGE_LIMIT)throw new Error('The model did not return a usable image.');
    const mimeType=imageMime(data);validateCanvas(data,mimeType,params.aspectRatio);
    return {data,mimeType,providerJobId:result.id||null};
  }
  async startVideo(model,params,references=[]) {
    const frames=references.filter(r=>r.role==='start_image'||r.role==='end_image');
    const refs=references.filter(r=>r.role!=='start_image'&&r.role!=='end_image');
    if(frames.length&&refs.length)throw new Error('Use either frames or reference files in a single video request.');
    const asFile=r=>({type:'url',url:r.url,mediaType:r.mimeType});
    const body={prompt:params.prompt,n:1,aspectRatio:params.aspectRatio,
      resolution:videoDimensions(params.resolution,params.aspectRatio),duration:params.duration,fps:model.fps||24,
      generateAudio:Boolean(params.generateAudio)};
    if(frames.length===1&&frames[0].role==='start_image')body.image=asFile(frames[0]);
    else if(frames.length)body.frameImages=frames.map(r=>({frameType:r.role==='start_image'?'first_frame':'last_frame',image:asFile(r)}));
    if(refs.length)body.inputReferences=refs.map(asFile);
    if(params.generationMode)body.providerOptions={klingai:{mode:params.generationMode}};
    if(model.providerModelId.startsWith('minimax/'))body.providerOptions={minimax:{resolution:params.resolution.toUpperCase()}};
    if(model.providerModelId.startsWith('alibaba/')&&params.resolution==='480p'&&['16:9','9:16'].includes(params.aspectRatio))body.resolution=params.aspectRatio==='16:9'?'832x480':'480x832';
    const result=await this.request('/v4/ai/video-model/start',{modelId:model.providerModelId,body,timeoutMs:60000,idempotencyKey:params.id});
    if(result.operation===undefined||result.operation===null)throw new Error('AI Gateway did not return a resumable video job.');
    return result;
  }
  async videoStatus(modelId,operation) {
    return this.request('/v4/ai/video-model/status',{modelId,body:{operation},timeoutMs:20000,maxBytes:Math.ceil(VIDEO_LIMIT*4/3)+65536});
  }
  async videoOutput(output) {
    let data;
    if(output?.type==='url')data=await this.download(output.url,VIDEO_LIMIT);
    else if(output?.type==='base64'&&typeof output.data==='string'&&output.data.length<=Math.ceil(VIDEO_LIMIT*4/3)+8)data=Buffer.from(output.data,'base64');
    if(!data?.length||data.length>VIDEO_LIMIT||data.toString('ascii',4,8)!=='ftyp')throw new Error('The model did not return a supported MP4 video.');
    return {data,mimeType:'video/mp4'};
  }
}

module.exports={VercelGatewayClient,readBounded,imageMime,checkOutputUrl,IMAGE_LIMIT,VIDEO_LIMIT};

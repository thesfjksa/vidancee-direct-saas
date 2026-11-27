'use strict';
const {createHash}=require('node:crypto');
const BASE_URL='https://api.bjhuiqu.net';
const MAX_BYTES=4*1024*1024;
const ID=/^[\p{L}\p{N}_. -]{1,190}$/u;
const VIDEO_TYPES=new Set(['video','openai_video','video_generation','text-to-video','image-to-video','reference-to-video']);
const FAMILY=/^(?:grok-(?:api-)?video|kling-|minimax-h3|hailuo-h3|(?:mj-)?sd2(?:[.05-]|$)|video-sd2|doubao-seedance|seedance-|veo-|gemini-omni|omniomni-|wan-?3|magi-?2|muse-)/i;
function discoverVideoModels(response){
  if(response?.success===false||!Array.isArray(response?.data))throw new Error('Huiqu returned an invalid model catalog.');
  const models=new Map();
  for(const row of response.data){
    if(typeof row?.id!=='string'||!ID.test(row.id)||row.available===false||row.enabled===false)continue;
    const types=Array.isArray(row.supported_endpoint_types)?row.supported_endpoint_types:[];
    const explicit=types.some(x=>VIDEO_TYPES.has(String(x).toLowerCase()));
    if(!explicit&&!FAMILY.test(row.id))continue;
    if(types.length&&!explicit)continue;
    models.set(row.id,{providerModelId:row.id,publicModelId:'huiqu_'+createHash('sha256').update(row.id).digest('hex').slice(0,32),
      label:row.id,mediaType:'video',catalogVerified:true,adapterSupported:false,ready:false,pricingVerified:false});
  }
  return [...models.values()];
}
class HuiquDiscoveryClient{
  constructor({apiKey='',fetchImpl=fetch}={}){this.apiKey=String(apiKey).trim();this.fetch=fetchImpl;}
  async get(path,{authenticated=true}={}){
    if(!['/v1/models','/models/metadata','/api/pricing'].includes(path))throw new Error('Invalid Huiqu discovery path.');
    if(authenticated&&!this.apiKey)throw new Error('Configure a Huiqu API key first.');
    let response;
    try{response=await this.fetch(BASE_URL+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{accept:'application/json',...(authenticated?{authorization:'Bearer '+this.apiKey}:{})}});}
    catch{throw new Error('Huiqu discovery connection failed.');}
    if(!response.ok){await response.body?.cancel?.().catch(()=>{});throw new Error('Huiqu discovery returned HTTP '+response.status+'.');}
    const reader=response.body?.getReader();if(!reader)throw new Error('Huiqu discovery returned no body.');
    let total=0;const chunks=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BYTES){await reader.cancel();throw new Error('limit');}chunks.push(Buffer.from(value));}}
    catch{throw new Error('Huiqu discovery response could not be read safely.');}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''));}
    catch{throw new Error('Huiqu discovery returned invalid JSON.');}
  }
  async models(){return discoverVideoModels(await this.get('/v1/models'));}
  async metadata(){return this.get('/models/metadata',{authenticated:false});}
  async pricing(){return this.get('/api/pricing',{authenticated:false});}
}
module.exports={BASE_URL,HuiquDiscoveryClient,discoverVideoModels};

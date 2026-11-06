'use strict';

// Customer model IDs must never collide with 888API's public Seedance IDs.
// Parameters here are conservative defaults; AIVID's live form independently
// validates the current account and supported combinations before charging.
const SPECS = Object.freeze([
  { id:'aivid_seedance_2_0_mini', providerId:'seedance-2.0-mini', name:'Seedance 2.0 (Mini)', maxSeconds:15, resolutions:['480p','720p'], refs:{image:9,video:3,audio:3} },
  { id:'aivid_seedance_2_0', providerId:'seedance-2.0', name:'Seedance 2.0', maxSeconds:15, resolutions:['480p','720p'], refs:{image:9,video:3,audio:3} },
  { id:'aivid_seedance_2_5', providerId:'seedance-2.5', name:'Seedance 2.5', maxSeconds:30, resolutions:['480p','720p'], refs:{image:30,video:10,audio:10} },
]);
const byId=new Map(SPECS.map(m=>[m.id,m]));
const isAividModel = id => byId.has(String(id||''));
const aividModel = id => byId.get(String(id||''))||null;
const DEFAULT_ID = SPECS[0].id;

function capabilities(spec) {
  const kind=(name,role)=>({supported:true,max:spec.refs[name],min:0,roles:[role],requiredRoles:[]});
  return {totalMax:spec.refs.image+spec.refs.video+spec.refs.audio,
    image:kind('image','image_references'),video:kind('video','video_references'),audio:kind('audio','audio_references')};
}
function modelEntry(m){
  const durations=Array.from({length:m.maxSeconds-3},(_,i)=>({seconds:i+4,label:(i+4)+' sec',cost:null}));
  return { id:m.id,label:m.name+' · Premium',premium:true, dynamicCost:true,
    warning:'Public generation: results may be visible to other users of the upstream video service.',
    durations,resolutions:m.resolutions.map(id=>({id,label:id,durations})),
    defaultDuration:5,defaultResolution:'480p',aspectRatios:['16:9','9:16','1:1'],
    defaultAspectRatio:'16:9',promptMaxChars:50000,capabilities:capabilities(m) };
}
function aividReady(config){
  if(!config?.enabled || !(config.maxSourceCredits>0))return false;
  if(config.mode==='rdp'){
    const { publicDevice } = require('./aivid_rdp.js');
    const device=publicDevice(config.rdpDevice||{});
    return Boolean(device.paired && device.online && ['ready','busy'].includes(device.status));
  }
  return Boolean(config.connectUrl && (!config.expiresAt || Date.parse(config.expiresAt)>Date.now()));
}
// Visibility and execution readiness are different states. A stale RDP
// heartbeat, a disabled source, or a zero source-credit limit must not silently
// remove Premium choices from the customer-facing model picker. Paid work is
// still refused in quoteAivid() and by the durable AIVID queue until ready.
function unavailableReason(config) {
  if(!config)return 'AIVID connection status could not be read.';
  if(config.enabled!==true)return 'AIVID Premium is disabled in saved Admin settings. Enable Accept queued AIVID jobs and click Save RDP connection.';
  if(!(config.maxSourceCredits>0))return 'AIVID source-credit limit is zero in Admin.';
  if(config.mode==='rdp')return 'The Windows RDP agent is offline or not ready.';
  return 'The AIVID browser session is missing or expired.';
}
function aividConfigured(config){
  if(!config)return false;
  // Keep the selected provider's models visible after heartbeat loss,
  // credits-ceiling pauses, or a temporary Admin disable. Do not inject
  // AIVID into unrelated installations that never set up this provider.
  return Boolean(config.enabled ||
    (config.mode==='rdp' && config.rdpDevice?.tokenHash && config.rdpDevice?.deviceId) ||
    (config.mode!=='rdp' && config.connectUrl));
}
function customerCatalog(config){
  if(!aividConfigured(config))return [];
  const ready=aividReady(config);
  return SPECS.map(spec=>{
    const entry=modelEntry(spec);
    return {
      ...entry,ready,unavailable:!ready,
      ...(!ready?{
        warning:unavailableReason(config)+' The model is visible, but generation is paused. Refresh Video Studio after the connection is restored. '+entry.warning,
      }:{})
    };
  });
}

function assertOptions(model,body) {
  const duration=Number(body.duration),aspectRatio=String(body.aspectRatio||body.aspect_ratio||'16:9');
  const resolution=String(body.resolution||'480p');
  if(!model || !Number.isInteger(duration) || duration<4 || duration>model.maxSeconds ||
    !model.resolutions.includes(resolution) || !['16:9','9:16','1:1'].includes(aspectRatio))
    throw Object.assign(new Error('Unsupported Premium model, duration, resolution or aspect ratio.'),{statusCode:400});
  return {model:model.id,prompt:String(body.prompt||'Cost estimate').trim()||'Cost estimate',duration,resolution,aspectRatio};
}
// A signed-in AIVID browser reports its own *public-mode* price; we never
// infer that AIVID credits are yuan, or use 888API's yuan conversion.
async function quoteAivid(config,body,{db}={}){
  if(!aividReady(config))throw Object.assign(new Error('Premium video generation requires a connected AIVID agent.'),{statusCode:503});
  const model=aividModel(body.model),value=assertOptions(model,body);
  const {withAividLock}=require('./aivid_queue.js');
  const Client=config.mode==='rdp'?require('./aivid_rdp.js').AividRdpClient:require('./provider/aivid.js').AividBrowserlessClient;
  const result=await withAividLock(db||require('./db.js').getPool(),()=>new Client(config).preflight(value));
  if(!result)throw Object.assign(new Error('Premium price checking is busy; retry shortly.'),{statusCode:409});
  const sourceCredits=Number(result.price);
  if(!Number.isFinite(sourceCredits)||sourceCredits<=0||sourceCredits>config.maxSourceCredits)
    throw Object.assign(new Error('AIVID pricing is unavailable or exceeds the configured source-credit limit.'),{statusCode:503});
  const {aividBaseCredits,aividSourceUsd}=require('./aivid_pricing.js');
  return {cost:aividBaseCredits(sourceCredits),sourceUsd:aividSourceUsd(sourceCredits),isEstimate:body.previewHasReferences===true,
    sourceCredits,modelId:model.id,duration:value.duration,resolution:value.resolution,aspectRatio:value.aspectRatio};
}
module.exports={SPECS,DEFAULT_ID,isAividModel,aividModel,capabilities,customerCatalog,aividReady,aividConfigured,assertOptions,quoteAivid};

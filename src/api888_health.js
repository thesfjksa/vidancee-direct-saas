'use strict';
// 888API reports each model's health in GET /v1/models (health_status:
// available, verifying, no_recent_success or disabled). Customers only see
// models 888API currently marks "available"; the worker refreshes the
// snapshot and the web app reads it from app_settings.
const {getSettingValue,setSettingValue}=require('./settings.js');

const SETTING_KEY='api888_model_health';
const REFRESH_MS=10*60*1000;
const CACHE_MS=30*1000;
const STATUSES=new Set(['available','verifying','no_recent_success','disabled']);

function healthSnapshot(body,now=Date.now()){
  const statuses={};
  for(const model of Array.isArray(body?.data)?body.data:[]){
    if(typeof model?.id!=='string'||model.id.length>=192)continue;
    const status=String(model.health_status||'');
    if(STATUSES.has(status))statuses[model.id]=status;
  }
  return {at:new Date(now).toISOString(),statuses};
}

// No snapshot yet, or 888API sent no health fields at all: fail open, so a
// missing feature upstream cannot silently empty the customer catalog.
function isApi888Available(snapshot,providerModelId){
  const statuses=snapshot?.statuses;
  if(!statuses||!Object.keys(statuses).length)return true;
  return statuses[String(providerModelId||'')]==='available';
}

// Customer catalog entries carry only the public ID (api888_<id with _>).
const publicId=id=>'api888_'+String(id).replace(/[^a-zA-Z0-9]/g,'_');
function isApi888PublicAvailable(snapshot,publicModelId){
  const statuses=snapshot?.statuses;
  if(!statuses||!Object.keys(statuses).length)return true;
  return Object.entries(statuses).some(([id,status])=>status==='available'&&publicId(id)===publicModelId);
}

let cached=null,cachedAt=0;
async function loadApi888Health({getValue=getSettingValue,now=Date.now()}={}){
  if(cached&&now-cachedAt<CACHE_MS)return cached;
  let snapshot=null;
  try{snapshot=JSON.parse(await getValue(SETTING_KEY,'')||'null');}catch{snapshot=null;}
  cached=snapshot;cachedAt=now;
  return snapshot;
}

async function refreshApi888Health({client,setValue=setSettingValue,now=Date.now()}){
  const snapshot=healthSnapshot(await client.models(),now);
  await setValue(SETTING_KEY,JSON.stringify(snapshot));
  cached=snapshot;cachedAt=now;
  return snapshot;
}

function healthSummary(snapshot){
  const counts={};
  for(const status of Object.values(snapshot?.statuses||{}))counts[status]=(counts[status]||0)+1;
  return {at:snapshot?.at||null,counts};
}

module.exports={SETTING_KEY,REFRESH_MS,healthSnapshot,isApi888Available,isApi888PublicAvailable,loadApi888Health,refreshApi888Health,healthSummary};

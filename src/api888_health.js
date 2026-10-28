'use strict';
// 888API reports each model's health (health_status: available, verifying,
// no_recent_success or disabled) in its public GET /api/model-health, which
// drives the pricing-page labels, and documents the same fields for
// GET /v1/models. Customers only see models 888API currently marks
// "available"; the worker refreshes the snapshot and the web app reads it
// from app_settings.
const {getSettingValue,setSettingValue}=require('./settings.js');

const SETTING_KEY='api888_model_health';
const REFRESH_MS=10*60*1000;
const CACHE_MS=30*1000;
const STALE_MS=20*60*1000;
const STATUSES=new Set(['available','verifying','no_recent_success','disabled']);

function healthSnapshot(body,now=Date.now()){
  const statuses={};
  for(const model of Array.isArray(body?.data)?body.data:[]){
    const id=typeof model?.id==='string'?model.id:model?.model_name;
    if(typeof id!=='string'||!id||id.length>=192)continue;
    const status=String(model.health_status||'');
    if(STATUSES.has(status))statuses[id]=status;
  }
  return {at:new Date(now).toISOString(),statuses};
}

// Models a generation just failed on with "please use another model" (or
// similar) stay hidden for DOWN_MS, between two health refreshes.
const DOWN_KEY='api888_model_down';
const DOWN_MS=30*60*1000;
const isDown=(snapshot,providerModelId,now=Date.now())=>Number(snapshot?.down?.[String(providerModelId||'')])>now;

// No snapshot yet, or 888API sent no health fields at all: fail open, so a
// missing feature upstream cannot silently empty the customer catalog.
function isApi888Available(snapshot,providerModelId,now=Date.now()){
  if(isDown(snapshot,providerModelId,now))return false;
  const statuses=snapshot?.statuses;
  if(!statuses||!Object.keys(statuses).length)return true;
  return statuses[String(providerModelId||'')]==='available';
}

// Customer catalog entries carry only the public ID (api888_<id with _>).
const publicId=id=>'api888_'+String(id).replace(/[^a-zA-Z0-9]/g,'_');
function isApi888PublicAvailable(snapshot,publicModelId,now=Date.now()){
  if(Object.keys(snapshot?.down||{}).some(id=>publicId(id)===publicModelId&&isDown(snapshot,id,now)))return false;
  const statuses=snapshot?.statuses;
  if(!statuses||!Object.keys(statuses).length)return true;
  return Object.entries(statuses).some(([id,status])=>status==='available'&&publicId(id)===publicModelId);
}

async function readDown(getValue,now){
  let down={};
  try{down=JSON.parse(await getValue(DOWN_KEY,'')||'{}')||{};}catch{down={};}
  return Object.fromEntries(Object.entries(down).filter(([,until])=>Number(until)>now));
}
async function markApi888ModelDown(providerModelId,{getValue=getSettingValue,setValue=setSettingValue,now=Date.now()}={}){
  const down=await readDown(getValue,now);
  down[String(providerModelId)]=now+DOWN_MS;
  await setValue(DOWN_KEY,JSON.stringify(down));
  if(cached)cached={...cached,down};
  return down;
}

let cached=null,cachedAt=0;
// The web app refreshes the public health list itself when the worker's saved
// snapshot is empty or stale, so hiding never waits on a worker redeploy.
async function loadApi888Health({getValue=getSettingValue,setValue=setSettingValue,client=null,now=Date.now()}={}){
  if(cached&&now-cachedAt<CACHE_MS)return cached;
  let snapshot=null;
  try{snapshot=JSON.parse(await getValue(SETTING_KEY,'')||'null');}catch{snapshot=null;}
  const stale=!snapshot?.statuses||!Object.keys(snapshot.statuses).length||!(now-Date.parse(snapshot.at)<STALE_MS);
  if(stale){
    try{
      const fresh=healthSnapshot(await (client||defaultClient()).modelHealth(),now);
      if(Object.keys(fresh.statuses).length){snapshot=fresh;await setValue(SETTING_KEY,JSON.stringify(fresh)).catch(()=>{});}
    }catch{}
  }
  snapshot={...(snapshot||{}),down:await readDown(getValue,now).catch(()=>({}))};
  cached=snapshot;cachedAt=now;
  return snapshot;
}
function defaultClient(){const {Api888Client}=require('./provider/api888.js');return new Api888Client();}

async function refreshApi888Health({client,setValue=setSettingValue,now=Date.now()}){
  let snapshot=null;
  try{snapshot=healthSnapshot(await client.modelHealth(),now);}catch{snapshot=null;}
  if(!snapshot||!Object.keys(snapshot.statuses).length)snapshot=healthSnapshot(await client.models(),now);
  await setValue(SETTING_KEY,JSON.stringify(snapshot));
  cached={...snapshot,down:cached?.down||{}};cachedAt=now;
  return snapshot;
}

function healthSummary(snapshot){
  const counts={};
  for(const status of Object.values(snapshot?.statuses||{}))counts[status]=(counts[status]||0)+1;
  return {at:snapshot?.at||null,counts};
}

module.exports={SETTING_KEY,DOWN_KEY,DOWN_MS,markApi888ModelDown,REFRESH_MS,healthSnapshot,isApi888Available,isApi888PublicAvailable,loadApi888Health,refreshApi888Health,healthSummary};

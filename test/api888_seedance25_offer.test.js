'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {api888MediaModels,SPECS,OFFERED_API888_MODELS}=require('../src/api888_models.js');
const {isApi888Available,isApi888PublicAvailable,markApi888ModelDown,DOWN_KEY}=require('../src/api888_health.js');

test('every priced Seedance 2.5 model is offered under its own customer name',()=>{
 const ids=Object.keys(SPECS).filter(id=>/2\.5/.test(id)&&/seedance|^s[s2]-/.test(id)&&id!=='seedance2.5-930-1080p');
 const models=api888MediaModels({data:ids.map(id=>({id}))});
 const labels=new Set();
 for(const m of models){
  assert.equal(m.options.adapterSupported,true,m.providerModelId);
  assert.ok(OFFERED_API888_MODELS.includes(m.providerModelId),m.providerModelId);
  assert.match(m.label,/^Seedance 2\.5 [A-Z]/);
  assert.doesNotMatch(m.label,/wool|dola|xin|doubao|888|_|\d{3}-/i,m.label);
  assert.ok(!labels.has(m.label),'duplicate '+m.label);labels.add(m.label);
 }
 assert.equal(models.find(m=>m.providerModelId==='seedance-2.5-g5-v2').label,'Seedance 2.5 Realism');
 assert.equal(api888MediaModels({data:[{id:'seedance2.5-930-1080p'}]})[0].options.adapterSupported,false);
});

test('a model that answered "use another model" is hidden for 30 minutes',async()=>{
 const store={};
 const getValue=async k=>store[k]||'',setValue=async(k,v)=>{store[k]=v;};
 const now=Date.parse('2026-10-28T08:00:00Z');
 const down=await markApi888ModelDown('seedance-2.5-g5-v2',{getValue,setValue,now});
 assert.ok(JSON.parse(store[DOWN_KEY])['seedance-2.5-g5-v2']>now);
 const snapshot={statuses:{'seedance-2.5-g5-v2':'available'},down};
 assert.equal(isApi888Available(snapshot,'seedance-2.5-g5-v2',now),false);
 assert.equal(isApi888PublicAvailable(snapshot,'api888_seedance_2_5_g5_v2',now),false);
 assert.equal(isApi888Available(snapshot,'seedance-2.5-g5-v2',now+31*60*1000),true);
 // No health data at all still hides a model that is down.
 assert.equal(isApi888Available({down},'seedance-2.5-g5-v2',now),false);
});

test('Seedance 2.0 wool models are offered: 4–10 s, 720p, up to 9 images',()=>{
 for(const [id,label] of [['seedance2.0-900-wool','Seedance 2.0 Economy'],['seedance2.0-933-wool','Seedance 2.0 Economy Plus']]){
  const m=api888MediaModels({data:[{id}]})[0];
  assert.equal(m.options.adapterSupported,true);
  assert.equal(m.label,label);
  assert.deepEqual(m.options.durations,[4,5,6,7,8,9,10]);
  assert.equal(m.options.referenceCapabilities.image.max,9);
 }
});

test('models 888API listed as currently available on 28 Oct 2026 are offered',()=>{
 const ids=['sd2.5-G3-特惠-1','seedance2.0-900-wool','seedance2.0-933-economy','seedance2.0-stable-480p',
  'seedance2.5-301010-wool-1080p','wan30-720p','seedance2.0-933-wool','wan30-1080p-fast','seedance2.5-301010-wool',
  'ss-2.5-720p-v3','seedance2.0-933','sd_2.0_mini_special','MC-WAN3-Prime-1080P-30S'];
 for(const m of api888MediaModels({data:ids.map(id=>({id}))})){
  assert.equal(m.options.adapterSupported,true,m.providerModelId);
  assert.ok(m.options.api888.sourceCny>0,m.providerModelId);
  assert.doesNotMatch(m.label,/[㐀-鿿]|_|MC-/,m.label);
 }
});

test('open Seedance 2.5 Full HD jobs are cancelled and refunded once',async()=>{
 const settings=require('../src/settings.js');
 const store={};
 const orig={get:settings.getSettingValue,set:settings.setSettingValue};
 settings.getSettingValue=async k=>store[k]||'';settings.setSettingValue=async(k,v)=>{store[k]=v;};
 try{
  const {cancelFullHdJobsOnce}=require('../src/api888_access.js');
  const refunded=[];let sql='';
  const db={execute:async(q,params)=>{sql=q;assert.deepEqual(params,['api888_seedance2_5_930_1080p']);return [[{id:'a'},{id:'b'}]];}};
  assert.equal(await cancelFullHdJobsOnce(db,async(id,status,message)=>refunded.push({id,status,message})),2);
  assert.match(sql,/refunded_at IS NULL/);
  assert.deepEqual(refunded.map(r=>r.id),['a','b']);
  assert.match(refunded[0].message,/refunded/);
  assert.equal(await cancelFullHdJobsOnce(db,async()=>assert.fail('runs once')),0);
 }finally{settings.getSettingValue=orig.get;settings.setSettingValue=orig.set;}
});

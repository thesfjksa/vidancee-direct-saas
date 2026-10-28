'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {api888MediaModels,SPECS,OFFERED_API888_MODELS}=require('../src/api888_models.js');
const {isApi888Available,isApi888PublicAvailable,markApi888ModelDown,DOWN_KEY}=require('../src/api888_health.js');

test('every priced Seedance 2.5 model is offered under its own customer name',()=>{
 const ids=Object.keys(SPECS).filter(id=>/2\.5/.test(id)&&/seedance|^s[s2]-/.test(id));
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
 assert.equal(models.find(m=>m.providerModelId==='seedance2.5-930-1080p').label,'Seedance 2.5 Full HD');
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

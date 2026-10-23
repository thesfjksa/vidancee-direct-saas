'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {api888MediaModels,VIDEO_IDS,IMAGE_IDS}=require('../src/api888_models.js');
const {Api888Client}=require('../src/provider/api888.js');
test('bundled 888API media catalog imports distinct IDs, but cannot bill customers',()=>{
  const models=api888MediaModels();
  assert.ok(models.length>=80);
  assert.equal(models.length,VIDEO_IDS.length+IMAGE_IDS.length);
  assert.equal(new Set(models.map(m=>m.publicModelId)).size,models.length);
  assert.ok(models.some(m=>m.options.adapterSupported===true));
  assert.ok(models.some(m=>m.options.adapterSupported===false));
});
test('live model import retains extra account-visible models as disabled rows',()=>{
  const models=api888MediaModels({data:[{id:'seedance2.5-900-wool'},{id:'brand-new-video-v2'},{id:'new-image-model'}]});
  assert.equal(models.length,3);
  assert.deepEqual(models.map(x=>x.mediaType),['video','video','image']);
  assert.equal(models[1].options.adapterSupported,false);
  assert.equal(models[2].options.adapterSupported,false);
});
test('a partial or empty catalog never replaces saved models',()=>{
  assert.throws(()=>api888MediaModels({data:[]}),/no recognized/i);
  assert.throws(()=>api888MediaModels({object:'list'}),/no model list/i);
});
test('authenticated catalog fetch never requires a paid generation',async()=>{
  let called=0;
  const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,options)=>{
    called++;
    assert.equal(url,'https://888api.xin/v1/models');
    assert.equal(options.method,'GET');
    assert.equal(options.headers.authorization,'Bearer sk-test');
    return new Response(JSON.stringify({data:[{id:'seedance2.5-900-wool'}]}),{status:200});
  }});
  assert.equal((await client.models()).data.length,1);
  assert.equal(called,1);
});
test('key rejection exposes no API token',async()=>{
  const client=new Api888Client({apiKey:'sk-private',fetchImpl:async()=>new Response('bad',{status:401})});
  await assert.rejects(client.models(),e=>!e.message.includes('sk-private'));
});

test('fixed price does not rise with video duration',()=>{
 const {quoteApi888}=require('../src/api888_models.js');
 const row=api888MediaModels({data:[{id:'seedance2.5-900-wool'}]})[0];
 const model={...row.options,providerModelId:row.providerModelId,mediaType:'video',provider:'api888',ready:true,priceOverride:null,...row.options};
 const a=quoteApi888(model,{duration:5},200),b=quoteApi888(model,{duration:25},200);
 assert.equal(a.cost,b.cost);
 assert.equal(a.sourceCny,1.1);
});

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


const {quoteApi888,API888_CUSTOMER_MULTIPLIER}=require('../src/api888_models.js');
const {CREDITS_PER_USD}=require('../src/billing.js');
function modelById(id){
 const item=api888MediaModels({data:[{id}]})[0];
 return {...item.options,providerModelId:item.providerModelId,mediaType:item.mediaType,provider:'api888',ready:true,priceOverride:null};
}
const fx=6.6702;
test('888API job prices normalize CNY to USD, then multiply customer credits by 3.5',()=>{
 const model=modelById('seedance2.5-900-wool');
 const a=quoteApi888(model,{duration:5},fx),b=quoteApi888(model,{duration:25},fx);
 assert.equal(API888_CUSTOMER_MULTIPLIER,3.5);
 assert.equal(a.sourceCny,1.1);
 assert.equal(a.sourceUsd,1.1/fx);
 assert.equal(a.cost,Math.ceil(1.1/fx*CREDITS_PER_USD*3.5));
 assert.equal(a.cost,b.cost);
 assert.equal(a.sourceUsd,b.sourceUsd);
 assert.equal(a.isEstimate,false);
});
test('888API per-second billing converts actual duration to USD',()=>{
 const model=modelById('wan3.0-video');
 model.adapterSupported=true; // isolate price math from provider workflow readiness
 const q=quoteApi888(model,{duration:10},fx);
 assert.equal(q.sourceCny,2.2);
 assert.equal(q.cost,Math.ceil(2.2/fx*CREDITS_PER_USD*3.5));
});
test('888API image generation uses the same isolated 3.5x USD markup',()=>{
 const q=quoteApi888(modelById('gpt-image-2.5-1k'),{},fx);
 assert.equal(q.sourceCny,0.06);
 assert.equal(q.sourceUsd,0.06/fx);
 assert.equal(q.cost,Math.ceil(0.06/fx*CREDITS_PER_USD*3.5));
});
test('888API rejects unsafe exchange rates and inaccessible models',()=>{
 const m=modelById('seedance2.5-900-wool');
 assert.throws(()=>quoteApi888(m,{},0),/USD\/CNY/);
 assert.throws(()=>quoteApi888(m,{},-5),/USD\/CNY/);
 assert.throws(()=>quoteApi888({...m,adapterSupported:false}, {},fx),/requires additional setup|model/i);
});
test('888API video response accepts task IDs and preserves result URLs',async()=>{
 let count=0;
 const c=new Api888Client({apiKey:'sk-test',fetchImpl:async(u,o)=>{
   count++;
   if(u.endsWith('/v1/videos')&&o.method==='POST'){
     assert.equal(JSON.parse(o.body).duration,10);
     return new Response(JSON.stringify({task_id:'task_987654321'}),{status:200});
   }
   if(u.endsWith('/v1/videos/task_987654321'))
     return new Response(JSON.stringify({status:'completed',task_result:{videos:[{url:'/v1/videos/task_987654321/content'}]}}),{status:200});
   throw Error('Unexpected request '+u);
 }});
 const m=modelById('seedance2.5-900-wool');
 const id=await c.startVideo(m,{prompt:'Hello',duration:10,resolution:'720p',aspectRatio:'16:9'});
 assert.equal(id,'task_987654321');
 assert.equal((await c.videoStatus(id)).url,'/v1/videos/task_987654321/content');
 assert.equal(count,2);
});

test('current 888API Seedance offerings become runnable after account-scoped sync',()=>{
  const ids=['ss-2.5-720p-v1','s2-2.5-480p-v2','s2-2.5-720p-v3',
    's2-2.5-720p-v4','seedance2.5-930-1080p'];
  const expected=[5,5,8,7,5];
  const records=api888MediaModels({data:ids.map(id=>({id}))});
  assert.equal(records.length,ids.length);
  for(const [i,m] of records.entries()){
    assert.equal(m.mediaType,'video',m.providerModelId);
    assert.equal(m.options.adapterSupported,true,m.providerModelId);
    assert.equal(m.options.api888.billing,'job');
    assert.equal(m.options.api888.sourceCny,expected[i]);
    assert.ok(m.options.durations.includes(5));
    assert.ok(m.options.durations.includes(15));
    assert.equal(m.options.durations.includes(30),false);
    const quote=quoteApi888({...m.options,providerModelId:m.providerModelId,mediaType:'video',provider:'api888'},
      {duration:10,resolution:m.options.defaultResolution,aspectRatio:'16:9'},6.6702);
    assert.equal(quote.sourceCny,expected[i]);
    assert.equal(quote.cost,Math.ceil(expected[i]/6.6702*6720*3.5));
  }
});
test('unknown account models are imported to Admin but never offered as paid generations',()=>{
  const [row]=api888MediaModels({data:[{id:'upcoming-video-unknown'}]});
  assert.equal(row.options.adapterSupported,false);
  assert.equal(row.options.api888.sourceCny,undefined);
});

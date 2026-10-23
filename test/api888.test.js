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


const {quoteApi888}=require('../src/api888_models.js');
const {roundYuanCredits,roundCredits}=require('../src/billing.js');
function modelById(id){
 const item=api888MediaModels({data:[{id}]})[0];
 return {...item.options,providerModelId:item.providerModelId,mediaType:item.mediaType,provider:'api888',ready:true,priceOverride:null};
}
test('888API flat-priced videos charge exactly one customer credit per CNY',()=>{
 const model=modelById('seedance2.5-900-wool');
 const a=quoteApi888(model,{duration:5}),b=quoteApi888(model,{duration:25});
 assert.equal(a.sourceCny,1.1);
 assert.equal(a.cost,1.1);
 assert.equal(a.pricingMode,'per_request');
 assert.equal(a.cost,b.cost);
 assert.equal(a.isEstimate,false);
});
test('888API dynamic billing charges exact CNY rate multiplied by duration',()=>{
 const model=modelById('wan3.0-video');
 const q=quoteApi888(model,{duration:10});
 assert.equal(q.sourceCny,2.2);
 assert.equal(q.cost,2.2);
 assert.equal(q.pricingMode,'per_second');
});
test('888API fractional yuan rates preserve 4 decimal credits',()=>{
 const q=quoteApi888(modelById('minimax-h3-480p-t'),{duration:5});
 assert.equal(q.cost,0.325);
 assert.equal(q.sourceCny,0.325);
 assert.equal(roundYuanCredits(0.325),0.325);
 assert.equal(roundCredits(0.325),0.33); // other provider rules remain at 2 decimals
});
test('888API image models charge exactly their published yuan price',()=>{
 const q=quoteApi888(modelById('gpt-image-2.5-1k'),{});
 assert.equal(q.cost,0.06);
 assert.equal(q.sourceCny,0.06);
 assert.equal(q.pricingMode,'per_request');
});
test('888API model without supported adapter or price cannot be billed',()=>{
 const m=modelById('seedance2.5-900-wool');
 assert.throws(()=>quoteApi888({...m,adapterSupported:false},{}),/additional setup/i);
 assert.throws(()=>quoteApi888({...m,api888:{billing:'job',sourceCny:0}},{}),/verified source price/i);
});
test('flat price of five yuan is five credits at every allowed duration',()=>{
 const m=modelById('ss-2.5-720p-v1');
 assert.equal(quoteApi888(m,{duration:5}).cost,5);
 assert.equal(quoteApi888(m,{duration:15}).cost,5);
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
      {duration:10,resolution:m.options.defaultResolution,aspectRatio:'16:9'});
    assert.equal(quote.sourceCny,expected[i]);
    assert.equal(quote.cost,expected[i]);
  }
});
test('unknown account models are imported to Admin but never offered as paid generations',()=>{
  const [row]=api888MediaModels({data:[{id:'upcoming-video-unknown'}]});
  assert.equal(row.options.adapterSupported,false);
  assert.equal(row.options.api888.sourceCny,undefined);
});


test('non-Seedance video families import as runnable video models with verified CNY prices',()=>{
  const fixtures=[
    ['wan30-720p',0.25,4,30],
    ['wan30-1080p-fast',0.4,4,30],
    ['wan3.0-video',0.22,2,30],
    ['wan3.0-video-prime',0.25,2,30],
    ['wan3.0-image',0.22,2,30],
    ['wan3.0-image-prime',0.25,2,30],
    ['minimax-h3-480p-t',0.065,5,15],
    ['minimax-h3-768p-t',0.07,5,15],
    ['seedance2.0-480p',0.5,4,15],
    ['seedance2.0-720p',0.75,4,15],
    ['seedance2.0-stable-480p',0.4,4,15],
    ['seedance2.0-stable-720p',0.63,4,15],
  ];
  for(const [id,rate,min,max] of fixtures){
    const [item]=api888MediaModels({data:[{id}]});
    assert.equal(item.mediaType,'video',id);
    assert.equal(item.options.adapterSupported,true,id);
    assert.equal(item.options.api888.billing,'second',id);
    assert.equal(item.options.api888.secondsField,'seconds',id);
    assert.equal(item.options.api888.sourceCny,rate,id);
    assert.equal(item.options.defaultDuration,min,id);
    assert.ok(item.options.durations.includes(max),id);
    const model={...item.options,providerModelId:id,mediaType:'video',provider:'api888'};
    const quote=quoteApi888(model,{duration:max});
    assert.equal(Math.round(quote.sourceCny*10000),Math.round(max*rate*10000),id);
    assert.equal(quote.cost,roundYuanCredits(max*rate),id);
  }
});
test('image-to-video Wan and discounted MiniMax H3 require an actual reference image',()=>{
  for(const id of ['wan3.0-image','wan3.0-image-prime','minimax-h3-480p-t','minimax-h3-768p-t']){
    const m=api888MediaModels({data:[{id}]})[0];
    assert.equal(m.mediaType,'video',id);
    assert.equal(m.options.referenceCapabilities.textOnly,false,id);
    assert.equal(m.options.referenceCapabilities.image.min,1,id);
  }
  const textToVideo=api888MediaModels({data:[{id:'wan3.0-video'}]})[0];
  assert.equal(textToVideo.options.referenceCapabilities.textOnly,true);
});
test('888API video adapter uses seconds for per-second Wan and MiniMax models',()=>{
  const client=new Api888Client({apiKey:'sk-test'});
  for(const id of ['wan3.0-video','wan30-720p','minimax-h3-480p-t']){
    const item=api888MediaModels({data:[{id}]})[0];
    const model={...item.options,providerModelId:item.providerModelId};
    const body=client.videoBody(model,{prompt:'Scene',duration:10,aspectRatio:'16:9',resolution:model.defaultResolution},
      id.startsWith('minimax')?[{mimeType:'image/png',url:'https://images.example.test/test.png'}]:[]);
    assert.equal(body.seconds,10,id);
    assert.equal(body.duration,undefined,id);
    assert.equal(body.model,id);
  }
});
test('Sora 2 remains a video model charged a fixed cost per generation',()=>{
  const item=api888MediaModels({data:[{id:'sora2-480p'}]})[0];
  assert.equal(item.mediaType,'video');
  assert.equal(item.options.adapterSupported,true);
  assert.equal(item.options.referenceCapabilities.image.max,0);
  const model={...item.options,providerModelId:item.providerModelId,mediaType:'video',provider:'api888'};
  const short=quoteApi888(model,{duration:5});
  const long=quoteApi888(model,{duration:15});
  assert.equal(short.cost,long.cost);
});

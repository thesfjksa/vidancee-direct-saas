'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const pricing=require('./fixtures/api888_seedance_2026_11_17.json');
const {api888MediaModels,quoteApi888,CURRENT_SEEDANCE_IDS,OFFERED_API888_MODELS}=require('../src/api888_models');
const {Api888Client}=require('../src/provider/api888');
const {serializeProviderModel}=require('../src/provider_models');
const discover=(ids=CURRENT_SEEDANCE_IDS,p=pricing)=>api888MediaModels({data:ids.map(id=>({id})),pricing:p});
const asModel=r=>({...r.options,provider:'api888',providerModelId:r.providerModelId,mediaType:r.mediaType});

test('all 33 currently published Seedance models have reviewed adapters and distinct customer labels',()=>{
 const records=discover(pricing.data.map(r=>r.model_name));
 assert.equal(records.length,33);
 const labels=new Set();
 for(const r of records){
  assert.equal(r.options.adapterSupported,true,r.providerModelId);
  assert.equal(r.mediaType,'video');
  assert.ok(OFFERED_API888_MODELS.includes(r.providerModelId));
  assert.match(r.label,/^Seedance 2\.[05] /);
  assert.ok(!labels.has(r.label),r.label);labels.add(r.label);
 }
});

test('new models preserve exact IDs, correct fixed/second quotes, string seconds and image limits',()=>{
 const client=new Api888Client();
 for(const r of discover()){
  const m=asModel(r),row=pricing.data.find(p=>p.model_name===r.providerModelId);
  for(const duration of [m.durations[0],m.durations.at(-1)]){
   const quote=quoteApi888(m,{duration});
   assert.equal(quote.sourceCny,Math.round(row.model_price*(m.api888.billing==='second'?duration:1)*10000)/10000,r.providerModelId);
   const ref={mimeType:'image/png',url:'https://media.example.test/reference.png'};
   const body=client.videoBody(m,{prompt:'A river',duration,aspectRatio:m.aspectRatios.at(-1)},[ref]);
   assert.equal(body.model,r.providerModelId);assert.equal(body.seconds,String(duration));
   assert.equal(body.duration,undefined);assert.deepEqual(body.images,[ref.url]);
   assert.throws(()=>client.videoBody(m,{duration},Array(m.referenceCapabilities.image.max+1).fill(ref)),/at most/);
   assert.throws(()=>client.videoBody(m,{duration},[{mimeType:'video/mp4',url:'https://media.example.test/reference.mp4'}]),/at most 0/);
  }
  assert.throws(()=>quoteApi888(m,{duration:31}));
  assert.throws(()=>quoteApi888(m,{duration:3}));
 }
});

test('live import remains account-scoped and rejects unknown, missing or ambiguous prices',async()=>{
 let reads=0;
 const client=new Api888Client({apiKey:'test-key',fetchImpl:async(url,options)=>{
  assert.equal(options.method,'GET');reads++;
  return Response.json(url.endsWith('/v1/models')?{data:[{id:CURRENT_SEEDANCE_IDS[0]}]}:pricing);
 }});
 const live=api888MediaModels(await client.catalog());
 assert.equal(reads,2);assert.equal(live.length,1);assert.equal(live[0].options.adapterSupported,true);
 for(const id of CURRENT_SEEDANCE_IDS){
  const row=pricing.data.find(r=>r.model_name===id);
  for(const data of [[],[row,row],[{...row,model_price:0}],[{...row,enable_groups:['vip']}],[{...row,enable_groups:{}}],[{...row,billing_expr:'unreviewed(seconds)'}]]){
   const r=discover([id],{...pricing,data})[0];
   assert.equal(r.options.adapterSupported,false,id);assert.equal(r.options.api888.sourceCny,null,id);
  }
 }
 assert.equal(discover(['seedance2.5-unknown'])[0].options.adapterSupported,false);
});

test('saved imported models retain prices, enablement, account availability and mapped input limits',()=>{
 for(const r of discover()){
  const m=serializeProviderModel({id:1,provider:'api888',provider_model_id:r.providerModelId,public_model_id:r.publicModelId,
   label:r.label,media_type:'video',enabled:0,available:0,options_json:JSON.stringify(r.options)});
  assert.equal(m.enabled,false);assert.equal(m.available,false);
  assert.equal(m.api888.sourceCny,r.options.api888.sourceCny);
  assert.equal(m.api888.secondsField,'seconds');
  assert.equal(m.referenceCapabilities.image.max,r.options.referenceCapabilities.image.max);
 }
 const full=asModel(discover(['seedance2.5-301010-full'])[0]);
 assert.equal(full.inputLimits.text.max_chars,45000);
 const reference=asModel(discover(['seedance2.0-903'])[0]);
 assert.equal(reference.inputLimits.text.max_chars,10000);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {api888MediaModels,quoteApi888,RECENT_SEEDANCE25_IDS}=require('../src/api888_models.js');
const {Api888Client}=require('../src/provider/api888.js');
const {isApi888Available,healthSnapshot}=require('../src/api888_health.js');
const contracts=[
 ['seedance2.5-301010-face','Seedance 2.5 Face',7.5,5],
 ['sd2.5-720p-full','Seedance 2.5 Full',6,5],
 ['tt-sd2.5-720p-v1','Seedance 2.5 TT',7,4],
 ['seedance2.5-fullparam-limited','Seedance 2.5 Limited',8,15],
];
const price=(id,rate)=>({model_name:id,quota_type:1,model_price:rate,enable_groups:['default']});
const pricing={success:true,group_ratio:{default:1},data:contracts.map(([id,,rate])=>price(id,rate))};
const records=()=>api888MediaModels({data:contracts.map(([id])=>({id})),pricing});
const model=r=>({...r.options,providerModelId:r.providerModelId,publicModelId:r.publicModelId,mediaType:'video',provider:'api888'});

test('new account-visible Seedance IDs have distinct supported contracts and current fixed prices',()=>{
 const rows=records();assert.equal(rows.length,4);
 for(const [id,label,rate,min] of contracts){
  const r=rows.find(r=>r.providerModelId===id),m=model(r);
  assert.equal(r.label,label);assert.equal(r.mediaType,'video');assert.equal(m.adapterSupported,true);
  assert.equal(m.defaultResolution,'720p');assert.equal(m.defaultDuration,min);
  assert.equal(m.api888.billing,'job');assert.equal(m.api888.sourceCny,rate);
  assert.equal(quoteApi888(m,{duration:min}).sourceCny,rate);
  assert.equal(quoteApi888(m,{duration:30}).sourceCny,rate);
  assert.equal(m.referenceCapabilities.image.max,30);
  assert.equal(m.referenceCapabilities.video.max,0);assert.equal(m.referenceCapabilities.audio.max,0);
  const c=new Api888Client();
  const body=c.videoBody(m,{prompt:'A river',duration:30,aspectRatio:'16:9'},[{mimeType:'image/png',url:'https://media.example.test/ref.png'}]);
  assert.deepEqual(body,{model:id,prompt:'A river',duration:30,resolution:'720p',ratio:'16:9',images:['https://media.example.test/ref.png']});
  assert.throws(()=>c.videoBody(m,{prompt:'A river',duration:30},[{mimeType:'video/mp4',url:'https://media.example.test/ref.mp4'}]),/at most 0/);
 }
});

test('Limited accepts only its two published lengths and wide ratios; Face stays restricted',()=>{
 const limited=model(records().find(r=>r.providerModelId==='seedance2.5-fullparam-limited'));
 assert.deepEqual(limited.durations,[15,30]);assert.ok(limited.aspectRatios.includes('21:9'));
 for(const duration of [4,10,16,29])assert.throws(()=>quoteApi888(limited,{duration}));
 const face=model(records()[0]);assert.deepEqual(face.aspectRatios,['16:9','9:16','1:1']);
});

test('new request-priced models use live prices without enabling unknown IDs or inventing prices',async()=>{
 const id=RECENT_SEEDANCE25_IDS[0];let priceCalls=0;
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,options)=>{
  assert.equal(options.method,'GET');
  if(url.endsWith('/v1/models'))return Response.json({data:[{id}]});
  priceCalls++;assert.equal(options.headers.authorization,undefined);
  return Response.json({...pricing,data:[price(id,6.25)]});
 }});
 const fresh=api888MediaModels(await client.catalog());
 assert.equal(fresh.length,1);assert.equal(fresh[0].options.api888.sourceCny,6.25);assert.equal(priceCalls,1);
 for(const rows of [[],[price(id,7.5),price(id,7.5)],[{...price(id,7.5),billing_expr:'unknown'}]]){
  const r=api888MediaModels({data:[{id}],pricing:{...pricing,data:rows}})[0];
  assert.equal(r.options.adapterSupported,false);assert.equal(r.options.api888.sourceCny,null);
 }
 assert.equal(api888MediaModels({data:[{id:'unknown-seedance-channel'}],pricing})[0].options.adapterSupported,false);
});

test('import does not bypass provider health: new available models show, verifying or unvalidated ones stay hidden',()=>{
 const snapshot=healthSnapshot({data:[...contracts.map(([id])=>({id,health_status:id.endsWith('limited')?'verifying':'available'})),
  {id:'seedance2.5-480p-plus',health_status:'no_recent_success'}]});
 const visible=records().filter(r=>r.options.adapterSupported&&isApi888Available(snapshot,r.providerModelId));
 assert.deepEqual(visible.map(r=>r.label),['Seedance 2.5 Face','Seedance 2.5 Full','Seedance 2.5 TT']);
 assert.equal(isApi888Available(snapshot,'seedance2.5-480p-plus'),false);
});

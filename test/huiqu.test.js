'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {huiquMediaModels,GROUP,isHuiquModel,priceFor}=require('../src/huiqu_models');
const {HuiquClient,payloadFor,fingerprint}=require('../src/provider/huiqu');
const {HuiquQueue}=require('../src/huiqu_queue');
const {quoteGateway,validateReferences}=require('../src/vercel_models');
const {serializeProviderModel,publicVideoModel}=require('../src/provider_models');
const {CREDITS_PER_CNY,CREDITS_PER_USD}=require('../src/billing');
const pricing=require('./fixtures/huiqu-pricing.json');
const account={data:pricing.data.map(r=>({id:r.model_name}))};
const rows=huiquMediaModels(pricing,account);
const full=id=>{
  const r=rows.find(x=>x.providerModelId===id);
  return serializeProviderModel({id:1,provider:'huiqu',provider_model_id:r.providerModelId,public_model_id:r.publicModelId,label:r.label,media_type:'video',enabled:1,available:1,options_json:JSON.stringify({...r.options,huiqu:{...r.options.huiqu,credential:fingerprint('test-key')}})});
};
const ref=kind=>({mimeType:kind==='image'?'image/png':kind==='video'?'video/mp4':'audio/wav',url:'https://example.com/'+kind});

test('all 70 public video entries imported; 58 fixed/second-priced routes eligible subject to account access',()=>{
  assert.equal(rows.length,70);
  assert.equal(new Set(rows.map(r=>r.publicModelId)).size,70);
  assert.equal(rows.filter(r=>r.options.adapterSupported).length,58);
  assert.equal(rows.filter(r=>r.options.setupReason.includes('Token-billed')).length,5);
  assert.equal(rows.filter(r=>r.options.setupReason.includes('deprecated')).length,7);
  for(const r of rows){
    assert.ok(isHuiquModel(r.publicModelId));
    const m=full(r.providerModelId);
    assert.equal(m.ready,r.options.adapterSupported,r.providerModelId);
    if(m.ready)assert.ok(quoteGateway(m,{}).cost>0);
  }
  assert.equal(huiquMediaModels(pricing).filter(r=>r.options.adapterSupported).length,0);
  assert.equal(huiquMediaModels(pricing,{data:[account.data.find(r=>r.id==='sd2-pro-max')]}).filter(r=>r.options.adapterSupported).length,1);
  assert.throws(()=>huiquMediaModels({success:true,data:[]},account),/inventory unchanged/);
  assert.throws(()=>huiquMediaModels(pricing,{}),/Account model list unavailable/);
});
test('only explicit 1x fixed-clip and second billing forms can become ready',()=>{
  const fixed=full('sd2-pro-max'),second=full('wan-3.0-video-10.5.5-720p');
  assert.equal(quoteGateway(fixed,{duration:5},CREDITS_PER_USD).cost,3.5*CREDITS_PER_CNY);
  assert.equal(quoteGateway(fixed,{duration:15},CREDITS_PER_USD).cost,3.5*CREDITS_PER_CNY);
  assert.equal(quoteGateway(second,{duration:10},CREDITS_PER_USD).cost,3.5*CREDITS_PER_CNY);
  assert.equal(publicVideoModel(fixed).billingMode,'per_request');
  assert.equal(publicVideoModel(second).billingMode,'per_second');
  assert.equal(priceFor({enable_groups:[GROUP],billing_expr:'tier("base", u("seconds")*0.5+1)'},1),null);
  assert.equal(priceFor({enable_groups:[GROUP],billing_expr:'tier("base", u("seconds")*0.5)'},2),null);
});
test('family-specific multimodal payloads are exact and unsupported video references fail before a POST',()=>{
  const options={prompt:'@image1 and @video1 and @audio1',duration:10,aspectRatio:'16:9'};
  const references=['image','video','audio'].map(ref);
  const h3=payloadFor(full('MiniMax-H3-933-1080p-10s'),options,references);
  assert.deepEqual(h3.metadata,{video_urls:['https://example.com/video'],audio_urls:['https://example.com/audio']});
  assert.equal(h3.prompt,'@图片1 and @视频1 and @音频1');
  const sd=payloadFor(full('sd2-pro-max'),options,references);
  assert.equal(sd.model,'sd2-pro-max');assert.deepEqual(sd.reference_video_urls,['https://example.com/video']);
  assert.equal(sd.prompt,options.prompt);
  const wan=payloadFor(full('wan-3.0-video-10.5.5-720p'),options,references);
  assert.deepEqual(wan.video_urls,['https://example.com/video']);
  assert.throws(()=>payloadFor(full('wan3.0-video-10.5.0-720p'),options,references),/Unsupported video reference/);
  assert.throws(()=>payloadFor(full('wan-3.0-ali-10.5.5-720p-5-30s'),{...options,duration:16},references),/Unsupported duration/);
  assert.throws(()=>payloadFor(full('Muse-Video-720p-900-2-10s'),{...options,prompt:'plain'},[]),/Invalid reference count/);
  assert.throws(()=>validateReferences(full('wan-3.0-video-10.5.5-720p'),{duration:2,videos:[{data:Buffer.alloc(20),mimeType:'video/mp4'}]}),/duration/);
});
test('public pricing GET has no credential and account GET, single POST, and polling are scoped to provider',async()=>{
  const requests=[];
  const client=new HuiquClient({apiKey:'test-key',fetchImpl:async(url,opts)=>{
    requests.push({url,opts});
    if(url.endsWith('/api/pricing'))return Response.json(pricing);
    if(url.endsWith('/v1/models'))return Response.json(account);
    if(opts.method==='POST')return Response.json({task_id:'task_123'});
    return Response.json({status:'completed',data:{result_url:'https://example.com/out.mp4'}});
  }});
  const models=await client.models();
  assert.equal(models.length,70);
  assert.equal(models[0].options.huiqu.credential,fingerprint('test-key'));
  assert.equal(requests[0].opts.headers.authorization,undefined);
  assert.equal(requests[1].opts.headers.authorization,'Bearer test-key');
  const receipt=await client.startVideo(full('sd2-pro-max'),{model:'sd2-pro-max',prompt:'Product ad'});
  assert.equal(receipt.requestId,'task_123');
  assert.ok(requests[2].url.endsWith('/v1/videos/generations'));
  assert.deepEqual(await client.videoStatus(receipt.requestId),{status:'completed',url:'https://example.com/out.mp4',errorCode:null});
  const broken=new HuiquClient({apiKey:'test-key',fetchImpl:async()=>{throw new Error('secret');}});
  await assert.rejects(broken.startVideo(full('sd2-pro-max'),{}),e=>e.ambiguous&&!e.message.includes('secret'));
});
test('worker refuses a changed price; an ambiguous paid start is saved and never retried',async()=>{
  const model=full('sd2-pro-max');
  const live=rows.find(r=>r.providerModelId===model.providerModelId);
  let post=0,refund=0;
  const writes=[];
  const db={execute:async(sql,args)=>{writes.push([sql,args]);return [{affectedRows:1}];}};
  const client={apiKey:'test-key',models:async()=>[live],startVideo:async()=>{post++;throw Object.assign(new Error('timeout'),{ambiguous:true});}};
  const queue=new HuiquQueue({getModel:async()=>model,refund:async()=>refund++});
  queue.references=async()=>[];
  queue.log=()=>{};
  const job={id:'sample',model:model.publicModelId,provider_cost:3,provider_operation:null,prompt:'product shot',generation_options:JSON.stringify({model,duration:5,resolution:'720p',aspectRatio:'16:9'})};
  await assert.rejects(queue.submit(db,job,client),/price changed/);
  assert.equal(post,0);assert.equal(writes.length,0);
  await queue.submit(db,{...job,provider_cost:3.5},client);
  assert.equal(post,1);
  assert.match(writes[0][0],/provider_operation/);
  assert.match(writes[1][0],/status='submitted'/);
  await queue.pollJob(db,client,{...job,provider_operation:writes[0][1][0]});
  assert.equal(post,1);assert.equal(refund,0);
});

test('all seven screenshot Seedance routes are in the reviewed catalog and become eligible with matching group access',()=>{
 const ids=['sd2.5-30.10.10-480p','sd2.5-30.10.10-720p','sd2.5-deal-10.5.0-720p','sd2.5-flash-10.5.5-480p','sd2.5-flash-10.5.5-720p','sd2.5-hd-30.10.10-480p','sd2.5-hd-30.10.10-720p'];
 for(const id of ids)assert.equal(rows.find(r=>r.providerModelId===id)?.options.adapterSupported,true,id);
});
test('multiple group keys preserve legacy access, union distinct IDs and select lowest verified group price',async()=>{
 const {HuiquGroupPool}=require('../src/provider/huiqu');
 const {credentials,summary,activeCredential,parseExtra}=require('../src/huiqu_credentials');
 const group='9.1-SD2.5系列';
 const modelA='sd2.5-30.10.10-720p',modelB='sd2.5-flash-10.5.5-480p';
 const multiPricing={...pricing,group_ratio:{...pricing.group_ratio,[group]:0.5}};
 const settings={huiquApiKey:'legacy-test',huiquExtraCredentials:parseExtra(JSON.stringify([{apiKey:'extra-test',group},{apiKey:'disabled-test',group,enabled:false}]))};
 assert.equal(credentials(settings,{activeOnly:true}).length,2);
 assert.ok(!JSON.stringify(summary(settings)).includes('extra-test'));
 const pool=new HuiquGroupPool(settings,{clientFactory:({apiKey,group})=>new HuiquClient({apiKey,group,fetchImpl:async(url)=>{
  if(url.endsWith('/api/pricing'))return Response.json(multiPricing);
  return Response.json({data:(apiKey==='legacy-test'?[modelA]:[modelA,modelB]).map(id=>({id}))});
 }})});
 const union=await pool.models();
 assert.equal(union.length,70);
 assert.equal(union.filter(row=>row.options.adapterSupported).length,2);
 const a=union.find(row=>row.providerModelId===modelA);
 assert.equal(a.options.huiqu.price.priceCny,1.75);
 assert.equal(a.options.huiqu.group,group);
 assert.equal(a.options.huiqu.credential,fingerprint('extra-test'));
 assert.equal(pool.forCredential(fingerprint('disabled-test'),{activeOnly:true}),null);
 assert.ok(pool.forCredential(fingerprint('disabled-test')));
 assert.equal(activeCredential(settings,fingerprint('disabled-test')),false);
 assert.equal(priceFor({enable_groups:[group],quota_type:1,tags:'按次计费',model_price:5},undefined,group),null);
});
test('polling a previously submitted job uses the original credential even after another group is selected',async()=>{
 const queue=new HuiquQueue();let polled=0;
 const original={apiKey:'old',videoStatus:async id=>{assert.equal(id,'task123');polled++;return {status:'pending'};}};
 queue.markProcessing=async()=>{};
 await queue.pollJob({}, {forCredential:id=>id===fingerprint('old')?original:null}, {id:'job',provider_operation:JSON.stringify({credential:fingerprint('old'),requestId:'task123'})});
 assert.equal(polled,1);
});

test('Seedance 2.5 Flash supports every integer duration from 4 to 30 at the same clip price',()=>{
 for(const [resolution,price] of [['480p',2.5],['720p',2.8]]){
  const model=full('sd2.5-flash-10.5.5-'+resolution);
  const expected=Array.from({length:27},(_,i)=>i+4);
  assert.deepEqual(model.durations,expected);
  const publicModel=publicVideoModel(model);
  assert.deepEqual(publicModel.durations.map(d=>d.seconds),expected);
  assert.equal(publicModel.billingMode,'per_request');
  for(const duration of expected){
   const quote=quoteGateway(model,{duration,resolution},CREDITS_PER_USD);
   assert.equal(quote.duration,duration);
   assert.ok(Math.abs(quote.sourceUsd*require('../src/billing').CNY_PER_USD-price)<1e-8);
   assert.equal(quote.cost,quoteGateway(model,{duration:4,resolution},CREDITS_PER_USD).cost);
  }
  assert.throws(()=>quoteGateway(model,{duration:31,resolution}));
  const payload=payloadFor(model,{prompt:'@video1',duration:30,aspectRatio:'16:9'},[ref('video')]);
  assert.equal(payload.seconds,30);
  assert.deepEqual(payload.videos,['https://example.com/video']);
  assert.equal(model.huiqu.videoClipSeconds,15);
 }
});

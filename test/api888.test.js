'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
// These tests cover the video/audio transport kept for when 888API's
// gateway forwards media references again.
require('../src/api888_models.js').setApi888MediaRefs(true);
const {api888MediaModels,VIDEO_IDS,IMAGE_IDS}=require('../src/api888_models.js');
const {Api888Client}=require('../src/provider/api888.js');
// Smallest complete MP4 for download tests: ftyp + moov + mdat.
function tinyMp4(){
  const box=(type,payload)=>{const h=Buffer.alloc(8);h.writeUInt32BE(8+payload.length);h.write(type,4,'latin1');return Buffer.concat([h,payload]);};
  return Buffer.concat([box('ftyp',Buffer.concat([Buffer.from('isom'),Buffer.alloc(12)])),box('moov',Buffer.alloc(8)),box('mdat',Buffer.alloc(16))]);
}

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
 // A ¥0.065/s rate (the former 888API MiniMax price) on a per-second model.
 const base=modelById('wan30-720p');
 const q=quoteApi888({...base,api888:{...base.api888,sourceCny:0.065}},{duration:5});
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
test('SS 2.5 V1 published fixed price is ¥3.9 at any supported duration',()=>{
 const m=modelById('ss-2.5-720p-v1');
 assert.equal(quoteApi888(m,{duration:5}).cost,3.9);
 assert.equal(quoteApi888(m,{duration:30}).cost,3.9);
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
  const expected=[3.9,5,8,7,5];
  const records=api888MediaModels({data:ids.map(id=>({id}))});
  assert.equal(records.length,ids.length);
  for(const [i,m] of records.entries()){
    assert.equal(m.mediaType,'video',m.providerModelId);
    assert.equal(m.options.adapterSupported,true,m.providerModelId);
    assert.equal(m.options.api888.billing,'job');
    assert.equal(m.options.api888.sourceCny,expected[i]);
    assert.ok(m.options.durations.includes(5));
    assert.ok(m.options.durations.includes(15));
    assert.equal(m.options.durations.includes(30),true);
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
    assert.equal(body.seconds,'10',id);
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

test('H3 discounted model requires an image before the paid HTTP request',async()=>{
  const id='minimax-h3-480p-t';
  const model=modelById(id);
  const client=new Api888Client({apiKey:'sk-test',fetchImpl:async()=>{throw Error('must not reach network');}});
  assert.throws(()=>client.videoBody(model,{prompt:'Scene',duration:5,resolution:'480p',aspectRatio:'16:9'},[]),
    /requires at least 1 reference image/i);
  const request=client.videoBody(model,{prompt:'Scene',duration:5,resolution:'480p',aspectRatio:'16:9'},
    [{mimeType:'image/png',url:'https://cmmtools.site/provider-assets/id/0?sig=stub'}]);
  assert.equal(request.seconds,'5');
  assert.equal(request.images.length,1);
});
test('888API HTTP 400 retains sanitized provider validation details for Activity',async()=>{
  const key='sk-topsecret-1234567890';
  let count=0;
  const client=new Api888Client({apiKey:key,fetchImpl:async(_url,options)=>{
    count++;
    assert.equal(options.method,'POST');
    return new Response(JSON.stringify({
      error:{code:'invalid_reference',message:'Unable to fetch https://cmmtools.site/provider-assets/id/0?sig=abc123&key=secret'},
      request_id:'req_987654321'
    }),{status:400,headers:{'content-type':'application/json'}});
  }});
  await assert.rejects(client.startVideo(modelById('minimax-h3-480p-t'),{
    prompt:'Test',duration:5,resolution:'480p',aspectRatio:'16:9'},[{mimeType:'image/png',url:'https://cmmtools.site/image.png'}]),error=>{
      assert.equal(error.providerStatus,400);
      assert.equal(error.providerRequestId,'req_987654321');
      assert.equal(error.code,'invalid_reference');
      assert.ok(error.providerMessage.includes('[URL redacted]'));
      assert.equal(error.providerMessage.includes('abc123'),false);
      assert.equal(error.providerMessage.includes('secret'),false);
      assert.equal(error.message.includes(key),false);
      const {errorDetails}=require('../src/activity_log.js');
      assert.equal(errorDetails(error).providerRequestId,'req_987654321');
      return true;
    });
  assert.equal(count,1);
});


test('888API 4K base64 image JSON larger than 4 MiB is accepted within the media limit',async()=>{
  const image=Buffer.alloc(5*1024*1024,19);
  Buffer.from('89504e470d0a1a0a','hex').copy(image,0);
  image.write('IHDR',12,'ascii');
  image.writeUInt32BE(4096,16);
  image.writeUInt32BE(4096,20);
  const payload=JSON.stringify({data:[{b64_json:image.toString('base64')}]});
  assert.ok(Buffer.byteLength(payload)>4*1024*1024);
  const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
    assert.equal(url,'https://888api.xin/v1/images/generations');
    assert.equal(opts.method,'POST');
    return new Response(payload,{status:200,headers:{'content-type':'application/json'}});
  }});
  const result=await client.generateImage({providerModelId:'gpt-image-2.5-sunburst-4k'},
    {prompt:'An illustrated castle',aspectRatio:'1:1'});
  assert.equal(result.mimeType,'image/png');
  assert.equal(result.data.length,image.length);
  assert.equal(result.data.compare(image),0);
});

test('888API ordinary metadata/status JSON keeps the 4 MiB limit',async()=>{
  const client=new Api888Client({apiKey:'sk-test',fetchImpl:async()=>new Response('{}',{
    status:200,headers:{'content-length':String(4*1024*1024+1)}
  })});
  await assert.rejects(client.json('/v1/videos/test_123'),/exceeds the supported size limit/);
});

test('888API image JSON cannot exceed the maximum permitted base64 payload',async()=>{
  const maxJson=Math.ceil(20*1024*1024*4/3)+64*1024;
  const client=new Api888Client({apiKey:'sk-test',fetchImpl:async()=>new Response('{}',{
    status:200,headers:{'content-length':String(maxJson+1)}
  })});
  await assert.rejects(client.generateImage({providerModelId:'gpt-image-2.5-sunburst-4k'},
    {prompt:'Scene',aspectRatio:'1:1'}),/exceeds the supported size limit/);
});

test('888API image errors remain bounded to 4 MiB even if image payloads may be larger',async()=>{
  const client=new Api888Client({apiKey:'sk-test',fetchImpl:async()=>new Response('{}',{
    status:400,headers:{'content-length':String(5*1024*1024)}
  })});
  await assert.rejects(client.generateImage({providerModelId:'gpt-image-2.5-sunburst-4k'},
    {prompt:'Scene',aspectRatio:'1:1'}),/exceeds the supported size limit/);
});

test('888API sends seconds as a JSON string in an actual video POST body',async()=>{
 const cases=['minimax-h3-480p-t','wan30-720p','wan3.0-video','seedance2.0-720p'];
 for(const id of cases){
   let sent=0;
   const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,options)=>{
     sent++;
     assert.equal(url,'https://888api.xin/v1/videos');
     assert.equal(options.method,'POST');
     const request=JSON.parse(options.body);
     assert.equal(request.model,id);
     assert.equal(request.seconds,'5');
     assert.equal(typeof request.seconds,'string');
     assert.equal(Object.hasOwn(request,'duration'),false);
     return new Response(JSON.stringify({id:'task_12345678'}),{status:200});
   }});
   const model=modelById(id);
   const refs=model.referenceCapabilities.image.min
      ?[{mimeType:'image/png',url:'https://images.example.test/reference.png'}]:[];
   const task=await client.startVideo(model,{prompt:'A moving scene',duration:5,
     resolution:model.defaultResolution,aspectRatio:'16:9'},refs);
   assert.equal(task,'task_12345678');
   assert.equal(sent,1);
 }
});
test('888API fixed-job models keep numeric duration in video POST body',async()=>{
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
   const body=JSON.parse(opts.body);
   assert.equal(body.duration,10);
   assert.equal(typeof body.duration,'number');
   assert.equal(Object.hasOwn(body,'seconds'),false);
   return new Response(JSON.stringify({id:'task_12345678'}),{status:200});
 }});
 const model=modelById('ss-2.5-720p-v1');
 assert.equal(await client.startVideo(model,{prompt:'A scene',duration:10,
   resolution:'720p',aspectRatio:'16:9'},[]),'task_12345678');
});

test('888API video status safely retries a transient GET without starting a new paid request',async()=>{
 let calls=0;
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,options)=>{
   calls++;
   assert.equal(url,'https://888api.xin/v1/videos/task_12345678');
   assert.equal(options.method,'GET');
   assert.equal(options.body,undefined);
   if(calls===1)throw Object.assign(new Error('socket hung up'),{code:'ECONNRESET'});
   return new Response(JSON.stringify({status:'completed',url:'https://example.test/video.mp4'}),{status:200});
 }});
 assert.equal((await client.videoStatus('task_12345678')).status,'done');
 assert.equal(calls,2);
});
test('888API video status retries transient HTTP 503, not another creation request',async()=>{
 let calls=0;
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(_url,options)=>{
   calls++;
   assert.equal(options.method,'GET');
   if(calls===1)return new Response(JSON.stringify({error:{message:'Temporarily unavailable'}}),{status:503});
   return new Response(JSON.stringify({status:'processing'}),{status:200});
 }});
 assert.equal((await client.videoStatus('task_12345678')).status,'pending');
 assert.equal(calls,2);
});
test('888API interrupted status reads retain nonsecret diagnostics after safe retry',async()=>{
 let calls=0;
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(_url,options)=>{
   calls++;
   assert.equal(options.method,'GET');
   throw Object.assign(new Error('do not log sensitive origin or token'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});
 }});
 await assert.rejects(client.videoStatus('task_12345678'),error=>{
   assert.equal(error.statusCode,502);
   assert.equal(error.retryable,true);
   assert.equal(error.requestMethod,'GET');
   assert.equal(error.failureType,'connection');
   assert.equal(error.networkCode,'UND_ERR_CONNECT_TIMEOUT');
   assert.equal(error.timeoutMs,60000);
   assert.equal(error.attempts,2);
   const details=require('../src/activity_log.js').errorDetails(error);
   assert.equal(details.networkCode,'UND_ERR_CONNECT_TIMEOUT');
   assert.equal(JSON.stringify(details).includes('sensitive origin'),false);
   return true;
 });
 assert.equal(calls,2);
});
test('888API paid POST creation is never retried after an ambiguous interruption',async()=>{
 let calls=0;
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(_url,options)=>{
   calls++;
   assert.equal(options.method,'POST');
   throw Object.assign(new Error('network down'),{code:'ECONNRESET'});
 }});
 await assert.rejects(client.startVideo(modelById('ss-2.5-720p-v1'),
   {prompt:'A scene',duration:10,resolution:'720p',aspectRatio:'16:9'}),error=>{
     assert.equal(error.retryable,false);
     assert.equal(error.requestMethod,'POST');
     assert.equal(error.attempts,1);
     assert.match(error.message,/Paid operations are not retried automatically/);
     return true;
   });
 assert.equal(calls,1);
});
test('888API queue clears stale transient video polling warning on successful poll',async()=>{
 const {Api888Queue}=require('../src/api888_queue.js');
 const queue=new Api888Queue();
 let executed;
 const db={execute:async(sql,args)=>{executed={sql,args};return [{affectedRows:1}];}};
 await queue.markProcessing(db,{id:'c2ebddd1-ab9b-4d25-805e-3f8d2c9c9627'});
 assert.match(executed.sql,/error_message=NULL/);
 assert.match(executed.sql,/status='processing'/);
 assert.equal(executed.args[0],'c2ebddd1-ab9b-4d25-805e-3f8d2c9c9627');
});


test('888API live task check reads provider progress without exposing output URLs',async()=>{
 let requests=0;
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
   requests++;assert.equal(url,'https://888api.xin/v1/videos/task_67890123');
   assert.equal(opts.method,'GET');
   return new Response(JSON.stringify({id:'task_67890123',status:'processing',task_status:'RUNNING',progress:42,
      url:'https://signed-private.example.test/?sig=SECRET'}),{status:200});
 }});
 const state=await client.videoStatus('task_67890123');
 assert.equal(state.status,'pending');
 assert.equal(state.providerStatus,'processing');
 assert.equal(state.progress,42);
 assert.equal(Object.hasOwn(state,'url'),false);
 assert.equal(requests,1);
});

test('888API fallback task_status reports succeeded and failed safely',async()=>{
 const statuses=[
   [{task_status:'SUCCESS',progress:100,url:'https://example.test/clip.mp4'},'done'],
   [{task_status:'FAILURE',error:{message:'job rejected'},progress:0},'failed'],
   [{task_status:'SUBMITTED',progress:0},'pending'],
 ];
 for(const [response,expected] of statuses){
   const client=new Api888Client({apiKey:'sk-test',fetchImpl:async()=>new Response(JSON.stringify(response),{status:200})});
   const state=await client.videoStatus('task_67890123');
   assert.equal(state.status,expected);
   if(expected==='failed')assert.equal(state.error,'job rejected');
 }
});
test('888API unknown task status no longer silently looks like pending forever',async()=>{
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async()=>new Response(JSON.stringify({status:'unexpected',task_status:'UNKNOWN'}),
   {status:200})});
 await assert.rejects(client.videoStatus('task_67890123'),/unrecognized video task status/);
});

test('888API falls back to authenticated content GET when completed video link has expired',async()=>{
 const mp4=tinyMp4();
 let calls=0;
 const c=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
   calls++;assert.equal(opts.method||'GET','GET');
   if(url==='https://signed.example.test/video.mp4'){
     assert.equal(opts.headers?.authorization,undefined);
     return new Response('Link expired',{status:403});
   }
   if(url==='https://888api.xin/v1/videos/task_12345678/content'){
     assert.equal(opts.headers.authorization,'Bearer sk-test');
     return new Response(mp4,{status:200});
   }
   throw Error('Unexpected request '+url);
 }});
 const output=await c.videoContent('task_12345678','https://signed.example.test/video.mp4');
 assert.equal(calls,2);
 assert.equal(output.mimeType,'video/mp4');
 assert.deepEqual(output.data,mp4);
});
test('888API falls back when provider URL returns HTML instead of MP4',async()=>{
 const mp4=tinyMp4();
 const c=new Api888Client({apiKey:'sk-test',fetchImpl:async url=>
   new Response(url.includes('signed.example.test')?'<html>temporary download error</html>':mp4,{status:200})});
 const output=await c.videoContent('task_12345678','https://signed.example.test/video.mp4');
 assert.equal(output.data.toString('ascii',4,8),'ftyp');
});
test('888API reports safe per-route diagnostics when both completed-video GET routes fail',async()=>{
 const c=new Api888Client({apiKey:'sk-test',fetchImpl:async url=>
   new Response('fail',{status:url.includes('888api.xin')?404:403})});
 await assert.rejects(c.videoContent('task_12345678','https://signed.example.test/video.mp4?sig=SECRET'),error=>{
   assert.equal(error.recoveryStage,'video.download');
   assert.equal(error.providerStatus,404);
   assert.match(error.providerMessage,/Content endpoint:.*404/);
   assert.equal(error.providerMessage.includes('SECRET'),false);
   return true;
 });
});

test('888API video download resolves provider-relative completed URLs without losing auth',async()=>{
 const mp4=tinyMp4();
 const {publicMediaUrl}=require('../src/provider/api888.js');
 assert.equal(publicMediaUrl('/v1/videos/task_12345678/content'),
   'https://888api.xin/v1/videos/task_12345678/content');
 assert.equal(publicMediaUrl('v1/videos/task_12345678/content?sig=123'),
   'https://888api.xin/v1/videos/task_12345678/content?sig=123');
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
   assert.equal(url,'https://888api.xin/v1/videos/task_12345678/content');
   assert.equal(opts.headers.authorization,'Bearer sk-test');
   return new Response(mp4,{status:200});
 }});
 assert.deepEqual((await client.videoContent('task_12345678','/v1/videos/task_12345678/content')).data,mp4);
});
test('888API HTTP public media link is upgraded to HTTPS without leaking Bearer credentials',async()=>{
 const mp4=tinyMp4();
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
   assert.equal(url,'https://media.example.test/output.mp4?sig=private');
   assert.equal(opts.headers?.authorization,undefined);
   return new Response(mp4,{status:200});
 }});
 const result=await client.videoContent('task_12345678','http://media.example.test/output.mp4?sig=private');
 assert.deepEqual(result.data,mp4);
});
test('888API authenticated content route accepts provider HTTP CDN redirect as HTTPS',async()=>{
 const mp4=tinyMp4();
 let calls=0;
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
   calls++;
   if(url==='https://888api.xin/v1/videos/task_12345678/content'){
     assert.equal(opts.headers.authorization,'Bearer sk-test');
     return new Response(null,{status:302,headers:{location:'http://cdn.example.test/result.mp4?sig=secret'}});
   }
   assert.equal(url,'https://cdn.example.test/result.mp4?sig=secret');
   assert.equal(opts.headers?.authorization,undefined);
   return new Response(mp4,{status:200});
 }});
 const result=await client.videoContent('task_12345678',null);
 assert.deepEqual(result.data,mp4);
 assert.equal(calls,2);
});
test('888API rejects unsafe video media targets without leaking signed URLs',()=>{
 const {publicMediaUrl}=require('../src/provider/api888.js');
 const unsafe=['http://127.0.0.1/secret','http://localhost/secret',
  'https://192.168.1.10/video.mp4','ftp://cdn.example.test/video.mp4',
  'data:video/mp4;base64,AA==','https://example.test:8080/movie.mp4',
  'https://user:password@example.test/movie.mp4'];
 for(const url of unsafe){
   assert.throws(()=>publicMediaUrl(url),error=>{
     assert.match(error.message,/unsupported video download URL/i);
     assert.equal(error.message.includes('secret'),false);
     assert.equal(error.message.includes('password'),false);
     assert.equal(error.mediaUrlPort===undefined,false);
     return true;
   },url);
 }
});

test('888API marks both raw-IP/custom-port video links as permanently inaccessible without fetching the unsafe hosts',async()=>{
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
   assert.equal(url,'https://888api.xin/v1/videos/task_12345678/content');
   assert.equal(opts.headers.authorization,'Bearer sk-test');
   return new Response(null,{status:302,
     headers:{location:'http://10.0.0.2:19876/video.mp4'}});
 }});
 await assert.rejects(client.videoContent('task_12345678','http://10.0.0.2:19876/video.mp4'),error=>{
   assert.equal(error.unretrievableOutput,true);
   assert.equal(error.providerOutputProblem,'unsafe_upstream_media_url');
   assert.equal(error.recoveryStage,'video.download');
   assert.ok(!error.message.includes('10.0.0.2'));
   assert.ok(!error.providerMessage.includes('10.0.0.2'));
   return true;
 });
});
test('888API does not permanently fail when an expired signed URL and HTTP 503 content route may recover',async()=>{
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url)=>{
   return new Response('unavailable',{status:url.includes('/content')?503:403});
 }});
 await assert.rejects(client.videoContent('task_12345678','https://cdn.example.test/expired.mp4'),error=>{
   assert.equal(error.unretrievableOutput,false);
   return true;
 });
});


test('888API completed video accepts public IPv4 HTTP custom-port output without credentials',async()=>{
 const mp4=tinyMp4();
 const url='http://8.8.8.8:19876/video.mp4?sig=private';
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(target,opts)=>{
   assert.equal(target,url);assert.equal(opts.redirect,'manual');
   assert.equal(opts.headers.authorization,undefined);
   assert.equal(opts.method||'GET','GET');return new Response(mp4);
 }});
 assert.deepEqual((await client.videoContent('task_12345678',url)).data,mp4);
 // Image/general downloads do not gain this exception.
 await assert.rejects(client.download(url),/unsupported video download URL/);
});
test('888API content endpoint can redirect to public IPv4 and strips provider authorization',async()=>{
 const mp4=tinyMp4();
 let calls=0;
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async(url,opts)=>{
   calls++;
   if(calls===1){assert.equal(opts.headers.authorization,'Bearer sk-test');
     return new Response(null,{status:302,headers:{location:'http://8.8.8.8:19876/output.mp4'}});}
   assert.equal(url,'http://8.8.8.8:19876/output.mp4');
   assert.equal(opts.headers.authorization,undefined);return new Response(mp4);
 }});
 assert.deepEqual((await client.videoContent('task_12345678',null)).data,mp4);
 assert.equal(calls,2);
});
test('888API video exception blocks private, special-use, encoded loopback and credential URLs',()=>{
 const {publicMediaUrl}=require('../src/provider/api888.js');
 const hosts=['0.0.0.0','10.1.2.3','100.64.0.1','100.127.255.254','127.1',
 '2130706433','0x7f000001','169.254.169.254','172.16.0.1','172.31.255.255',
 '192.168.0.1','192.0.0.8','192.0.2.1','192.88.99.1','198.18.0.1',
 '198.19.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',
 '168.63.129.16','[::1]','[::ffff:127.0.0.1]','user:secret@8.8.8.8'];
 for(const host of hosts)for(const scheme of ['http','https']){
   assert.throws(()=>publicMediaUrl(`${scheme}://${host}:19876/video.mp4`,undefined,true),
     /unsupported video download URL/,host);
 }
});
test('888API public IPv4 redirects cannot reach metadata or private addresses',async()=>{
 for(const destination of ['http://169.254.169.254/latest/meta-data',
   'http://127.0.0.1:19876/video.mp4','https://192.168.0.1/video.mp4']){
   let calls=0;
   const client=new Api888Client({fetchImpl:async(url)=>{
     calls++;assert.equal(url,'http://8.8.8.8:19876/video.mp4');
     return new Response(null,{status:302,headers:{location:destination}});
   }});
   await assert.rejects(client.download('http://8.8.8.8:19876/video.mp4',1024,{allowPublicIp:true}),
     /unsupported video download URL/);
   assert.equal(calls,1);
 }
});
test('888API public IPv4 download retains size and MP4 checks',async()=>{
 const client=new Api888Client({fetchImpl:async()=>new Response('not a video')});
 await assert.rejects(client.videoContent('task_12345678','http://8.8.8.8:19876/video.mp4'),
   /could not be downloaded/);
 const oversized=new Api888Client({fetchImpl:async()=>new Response('data',{
   headers:{'content-length':'67108865'}})});
 await assert.rejects(oversized.download('http://8.8.8.8:19876/video.mp4',67108864,{allowPublicIp:true}),
   /size limit/);
});

test('888API exposes reference video, audio and image upload controls only for verified multimodal models',()=>{
  const refs=[
    ['ss-2.5-720p-v1',30,10,10],
    ['s2-2.5-480p-v2',30,0,10],
    ['s2-2.5-720p-v3',30,10,10],
    ['s2-2.5-720p-v4',30,10,10],
    ['dola-seedance-2.5-301010',30,10,10],
    ['seedance2.5-930-1080p',9,0,3],
    ['wan30-720p',10,5,5],
    ['wan30-1080p-fast',10,5,5],
    ['wan3.0-video',10,10,0],
    ['wan3.0-video-prime',10,10,0],
    ['wan3.0-image',10,0,0],
    ['seedance2.5-900-wool',9,0,0],
  ];
  for(const [id,images,videos,audios] of refs){
    const m=modelById(id);
    assert.equal(m.adapterSupported,true,'Adapter missing for '+id);
    const caps=m.referenceCapabilities;
    assert.equal(caps.image.max,images,id);
    assert.equal(caps.video.max,videos,id);
    assert.equal(caps.audio.max,audios,id);
    assert.equal(caps.totalMax,images+videos+audios,id);
    assert.equal(caps.video.supported,videos>0,id);
    assert.equal(caps.audio.supported,audios>0,id);
    assert.equal(m.supportedOperations.includes('reference-to-video'),images+videos+audios>0,id);
  }
});
test('888API generated request carries image, video and audio HTTPS URL arrays and selected ratio',()=>{
  const m=modelById('ss-2.5-720p-v1');
  const refs=[
    {mimeType:'image/jpeg',url:'https://cmmtools.site/provider-media/job/0?sig=1'},
    {mimeType:'video/mp4',url:'https://cmmtools.site/provider-media/job/1?sig=2'},
    {mimeType:'audio/mpeg',url:'https://cmmtools.site/provider-media/job/2?sig=3'},
  ];
  const body=new Api888Client({apiKey:'sk-test'}).videoBody(m,
    {prompt:'Keep the action and music',duration:10,resolution:'720p',aspectRatio:'9:16'},refs);
  assert.deepEqual(body.images,[refs[0].url]);
  assert.deepEqual(body.videos,[refs[1].url]);
  assert.deepEqual(body.audios,[refs[2].url]);
  assert.equal(body.ratio,'9:16');
  assert.equal(body.duration,10);
  assert.equal(body.seconds,undefined);
});
test('888API supports audio-only references on documented s2-480p model, not undocumented video',()=>{
  const m=modelById('s2-2.5-480p-v2');
  const client=new Api888Client({apiKey:'sk-test'});
  const audio={mimeType:'audio/wav',url:'https://cmmtools.site/provider-media/job/0?sig=ok'};
  assert.deepEqual(client.videoBody(m,{duration:5,prompt:'music only'},[audio]).audios,[audio.url]);
  assert.throws(()=>client.videoBody(m,{duration:5},[
    {mimeType:'video/mp4',url:'https://cmmtools.site/provider-media/job/1?sig=ok'},
  ]),/at most 0 video reference/i);
});
test('888API 1080p Seedance uses metadata.audios, not the top-level audios field',()=>{
  const m=modelById('seedance2.5-930-1080p');
  const client=new Api888Client({apiKey:'sk-test'});
  const body=client.videoBody(m,{duration:10,aspectRatio:'21:9'},[
    {mimeType:'audio/mpeg',url:'https://cmmtools.site/provider-media/job/0?sig=1'},
  ]);
  assert.deepEqual(body.metadata,{audios:['https://cmmtools.site/provider-media/job/0?sig=1']});
  assert.equal(body.audios,undefined);
  assert.equal(body.ratio,'21:9');
});
test('888API wide/adaptive aspect ratios use only model-documented values',()=>{
 const client=new Api888Client({apiKey:'sk-test'});
 for(const [id,ratio] of [
   ['wan3.0-video','adaptive'],['wan3.0-video-prime','21:9'],
   ['minimax-h3-480p-t','2:3'],['seedance2.5-930-1080p','21:9'],
   ['seedance2.5-900','4:3']]){
   const m=modelById(id);
   assert.ok(m.aspectRatios.includes(ratio),id);
   const refs=m.referenceCapabilities.image.min
     ?[{mimeType:'image/png',url:'https://cmmtools.site/provider-media/job/0?sig=ok'}]:[];
   assert.equal(client.videoBody(m,{duration:5,aspectRatio:ratio},refs).ratio,ratio,id);
 }
 const wool=modelById('seedance2.5-900-wool');
 assert.deepEqual(wool.aspectRatios,['16:9','9:16','1:1']);
 assert.throws(()=>client.videoBody(wool,{duration:5,aspectRatio:'21:9'}),/Unsupported aspect ratio/);
});
test('888API rejects wrong references, unsafe input URLs and excess mixed media before paid submission',async()=>{
 const client=new Api888Client({apiKey:'sk-test',fetchImpl:async()=>{throw Error('Paid request must not start');}});
 const imageModel=modelById('wan3.0-image');
 const video={mimeType:'video/mp4',url:'https://cmmtools.site/provider-media/job/0?sig=1'};
 const image={mimeType:'image/png',url:'https://cmmtools.site/provider-media/job/1?sig=2'};
 assert.throws(()=>client.videoBody(imageModel,{duration:5},[image,video]),/at most 0 video reference/);
 const m=modelById('s2-2.5-720p-v3');
 assert.throws(()=>client.videoBody(m,{duration:10},[
   {mimeType:'audio/mpeg',url:'http://127.0.0.1:8000/a.mp3'},
 ]),/HTTPS/);
 assert.throws(()=>client.videoBody(m,{duration:10},[
   {mimeType:'application/octet-stream',url:'https://cmmtools.site/blob.bin'},
 ]),/Unsupported.*media type/);
 const files=Array.from({length:11},(_,index)=>({
   mimeType:'video/mp4',url:'https://cmmtools.site/provider-media/job/'+index+'?sig=1',
 }));
 assert.throws(()=>client.videoBody(m,{duration:10},files),/at most 10 video references/);
 await assert.rejects(client.startVideo(imageModel,{duration:5},[image,video]),/at most 0 video reference/);
});

test('888API POST failures keep the redacted upstream reason for the customer and Admin',async()=>{
  const body=JSON.stringify({error:{message:'No available channel for model wan3.0-video-prime under group default sk-abcdef123456 https://x.example/a'}});
  const client=new Api888Client({apiKey:'k',fetchImpl:async()=>new Response(body,{status:503,headers:{'content-type':'application/json'}})});
  await assert.rejects(client.json('/v1/videos',{model:'wan3.0-video-prime'}),error=>{
    assert.match(error.message,/^888API request failed \(HTTP 503\): No available channel for model wan3\.0-video-prime/);
    assert.doesNotMatch(error.message,/sk-abcdef|x\.example/);
    assert.equal(error.providerStatus,503);
    assert.equal(error.retryable,false);
    return true;
  });
  const bare=new Api888Client({apiKey:'k',fetchImpl:async()=>new Response('oops',{status:503})});
  await assert.rejects(bare.json('/v1/videos',{}),e=>e.message==='888API request failed (HTTP 503).');
});

test('888API errors wrapped as JSON inside the message are unwrapped to the readable reason',async()=>{
  const inner=JSON.stringify({error:{code:'model_not_found',message:'No available channel for model sd2-pro-933-480p under group default (distributor)'}});
  const body=JSON.stringify({error:{message:JSON.stringify({error:{message:inner}})}});
  const client=new Api888Client({apiKey:'k',fetchImpl:async()=>new Response(body,{status:503})});
  await assert.rejects(client.json('/v1/videos',{}),e=>
    e.message==='888API request failed (HTTP 503): No available channel for model sd2-pro-933-480p under group default (distributor)');
});

test('a truncated nested 888API error still yields the readable reason',async()=>{
  const body=JSON.stringify({error:{message:'{"error": {"message": "{\\"error\\":{\\"code\\":\\"model_not_found\\",\\"message\\":\\"No available channel for model sd2-pro-933-480p under group default (distributor) (request id: 2026102508'}});
  const client=new Api888Client({apiKey:'k',fetchImpl:async()=>new Response(body,{status:503})});
  await assert.rejects(client.json('/v1/videos',{}),e=>
    e.message.startsWith('888API request failed (HTTP 503): No available channel for model sd2-pro-933-480p under group default')&&!e.message.includes('{'));
});

test('Studio @Video1/@Image1/@Audio1 mentions become 888API @视频1/@图1/@音频1',()=>{
  const {api888Mentions}=require('../src/provider/api888.js');
  assert.equal(api888Mentions('Restyle @Video1 using @Image2 and @audio1, keep @Video 2'),'Restyle @视频1 using @图2 and @音频1, keep @视频2');
  assert.equal(api888Mentions('email me@example.com'),'email me@example.com');
});

test('888API video references kept in cloud storage are sent as presigned bucket links',async()=>{
  const {Api888Queue}=require('../src/api888_queue.js');
  const {blobRef}=require('../src/object_storage.js');
  const queue=new Api888Queue({});
  const id='0b0e0c0a-1111-2222-3333-444455556666';
  const db={execute:async sql=>{
    if(sql.includes('FROM generation_images'))return [[]];
    if(sql.includes('LENGTH(media_data)<512'))return [[{position_index:1,media_data:blobRef('media/'+id+'/abc')}]];
    return [[{position_index:0,media_kind:'image',media_role:'image',mime_type:'image/png'},{position_index:1,media_kind:'video',media_role:'video',mime_type:'video/mp4'}]];
  }};
  const env={APP_URL:process.env.APP_URL,PROVIDER_ASSET_SECRET:process.env.PROVIDER_ASSET_SECRET};
  process.env.APP_URL='https://cmmtools.site';process.env.PROVIDER_ASSET_SECRET='test-secret';
  const objectStorage=require('../src/object_storage.js');
  const original=objectStorage.configuredStorage;
  objectStorage.configuredStorage=async()=>({presign:key=>'https://bucket.example/'+key+'?sig'});
  try{
    const refs=await queue.references(db,{id,media_type:'video'});
    assert.match(refs[0].url,/\/provider-media\//);
    assert.equal(refs[1].url,'https://bucket.example/media/'+id+'/abc?sig');
  }finally{
    objectStorage.configuredStorage=original;
    for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
});

test('a truncated 888API video download is rejected so the next poll fetches it again',async()=>{
  const {isCompleteMp4}=require('../src/mp4_trim.js');
  const full=tinyMp4();
  assert.equal(isCompleteMp4(full),true);
  assert.equal(isCompleteMp4(full.subarray(0,full.length-4)),false);
  const noIndex=Buffer.concat([full.subarray(0,24),full.subarray(40)]);
  assert.equal(isCompleteMp4(noIndex),false);
  const client=new Api888Client({apiKey:'k',fetchImpl:async()=>new Response(full.subarray(0,30),{status:200})});
  await assert.rejects(client.videoContent('task_abcdef','https://cdn.example.com/v.mp4'));
});

test('888API request traces keep host and path of links but drop signatures',()=>{
  const {traceShape}=require('../src/provider/api888.js');
  const out=traceShape({model:'wan30-720p',video_urls:['https://acct.r2.cloudflarestorage.com/cmmtools-media/media/x/y?X-Amz-Signature=secret']});
  assert.deepEqual(out,{model:'wan30-720p',video_urls:['acct.r2.cloudflarestorage.com/cmmtools-media/media/x/y?…']});
});

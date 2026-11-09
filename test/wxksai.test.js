'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { WxksaiClient }=require('../src/provider/wxksai.js');
const { WxksaiQueue }=require('../src/wxksai_queue.js');
const { wxksaiMediaModels, SPECS, publicId, isWxksaiModel, UNVERIFIED_DOPE_VIDEO_CANDIDATE, unverifiedDopeCandidateVisible }=require('../src/wxksai_models.js');
const { quoteGateway, validateReferences }=require('../src/vercel_models.js');
const { CREDITS_PER_USD, CNY_PER_USD }=require('../src/billing.js');

function modelFor(id) {
  const row=wxksaiMediaModels({data:[{id}]})[0];
  return {...row,...row.options,mediaType:'video',pricing:row.options.pricing};
}
test('WXKSAI import is account-scoped and fails closed',()=>{
  assert.equal(wxksaiMediaModels({data:[{id:'another-model'}]}).length,0);
  assert.throws(()=>wxksaiMediaModels({}),/model list/);
  assert.equal(wxksaiMediaModels({data:[{id:'seedance-2.5-special2'}]}).length,1);
  assert.equal(isWxksaiModel(publicId('seedance-2.5-special2')),true);
});
test('Dope SD 2.5 screenshot SKU imports only when present in key-scoped inventory',async()=>{
  const id='sd 2.5掺水板';
  assert.equal(UNVERIFIED_DOPE_VIDEO_CANDIDATE,id);
  assert.equal(Object.hasOwn(SPECS,id),true);
  assert.equal(SPECS[id].priceReviewRequired,true);
  assert.equal(SPECS[id].videoApiVerified,false);
  const live={data:[{id},{id:'seedance-2.5-special2'}]};
  assert.equal(unverifiedDopeCandidateVisible(live),true);
  assert.equal(unverifiedDopeCandidateVisible({data:[{id:'sd 2.5 掺水板'}]}),false);
  assert.equal(unverifiedDopeCandidateVisible({data:[]}),false);
  assert.throws(()=>unverifiedDopeCandidateVisible({}),/model list/);
  const ready=wxksaiMediaModels(live);
  assert.equal(ready.length,2);
  assert.equal(ready[0].providerModelId,id);
  assert.equal(ready[0].options.wxksai.priceReviewRequired,true);
  assert.equal(ready[0].options.wxksai.videoApiVerified,false);
  assert.equal(ready[0].options.wxksai.screenshotTaskPriceCny,1.90);
  assert.equal(ready[0].options.wxksai.priceCny,2.20);
  assert.equal(ready[1].providerModelId,'seedance-2.5-special2');
  assert.equal(isWxksaiModel(publicId(id)),true);
  let requests=0;
  const client=new WxksaiClient({apiKey:'test-key',fetchImpl:async(url,opts)=>{
    requests++;
    assert.ok(url.endsWith('/v1/models'));
    assert.equal(opts.method,'GET');
    assert.equal(opts.body,undefined);
    return Response.json(live);
  }});
  assert.equal(unverifiedDopeCandidateVisible(await client.models()),true);
  assert.equal(requests,1);
});
test('Dope SD 2.5 Value is a flat conservative ¥2.20 clip across 2–30 sec and 480p/720p/1080p',()=>{
  const id=UNVERIFIED_DOPE_VIDEO_CANDIDATE,model=modelFor(id);
  const all=[...model.durations];assert.equal(all.length,29);
  assert.equal(all[0],2);assert.equal(all.at(-1),30);
  assert.deepEqual(model.resolutions,['480p','720p','1080p']);
  assert.equal(publicId(id),'wxksai_sd25_value');
  assert.deepEqual(['image','video','audio'].map(kind=>model.referenceCapabilities[kind].max),[2,0,0]);
  const cost=Math.ceil(2.20/CNY_PER_USD*CREDITS_PER_USD);
  for(const duration of [2,5,15,30])for(const resolution of model.resolutions){
    assert.equal(quoteGateway(model,{duration,resolution,aspectRatio:'16:9'},CREDITS_PER_USD).cost,cost);
  }
  assert.throws(()=>quoteGateway(model,{duration:1,resolution:'720p'}),/Unsupported duration/);
  assert.throws(()=>quoteGateway(model,{duration:31,resolution:'720p'}),/Unsupported duration/);
  assert.throws(()=>quoteGateway(model,{duration:2,resolution:'1440p'}),/Unsupported resolution/);
});
test('Dope SD 2.5 Value submits exact Unicode model ID, two images but no audio/video in a single paid POST',async()=>{
  let submissions=0,last;
  const client=new WxksaiClient({apiKey:'test-key',fetchImpl:async(url,req)=>{
    submissions++;last={url,req};return Response.json({id:'value_task_001'});
  }});
  const id=UNVERIFIED_DOPE_VIDEO_CANDIDATE;
  const opts={model:{providerModelId:id},prompt:'A moving subject',duration:2,resolution:'1080p',aspectRatio:'16:9'};
  const img=(n)=>({kind:'image',mimeType:'image/png',filename:'ref'+n+'.png',data:Buffer.from([137,80,78,71,13,10,26,10,n])});
  const result=await client.startVideo(opts,[img(1),img(2)]);
  assert.equal(result.requestId,'value_task_001');
  assert.equal(submissions,1);
  assert.equal(last.url,'https://api.wxksai.com/v1/videos');
  assert.equal(last.req.method,'POST');
  assert.equal(last.req.headers['content-type'],undefined);
  assert.equal(last.req.body.get('model'),id);
  assert.equal(last.req.body.get('seconds'),'2');
  assert.equal(last.req.body.get('resolution'),'1080p');
  assert.equal(last.req.body.getAll('images').length,2);
  await assert.rejects(client.startVideo(opts,[img(1),img(2),img(3)]),/does not support/);
  await assert.rejects(client.startVideo(opts,[{kind:'audio',mimeType:'audio/wav',filename:'voice.wav',data:Buffer.alloc(128)}]),/does not support/);
  await assert.rejects(client.startVideo(opts,[{kind:'video',mimeType:'video/mp4',filename:'video.mp4',data:Buffer.alloc(128)}]),/does not support/);
  assert.equal(submissions,1);
});
test('WXKSAI fixed 1080p per-clip prices do not depend on seconds',()=>{
  const m=modelFor('seedance-2.5-special2');
  const price=quoteGateway(m,{duration:5,resolution:'1080p',aspectRatio:'16:9'},CREDITS_PER_USD);
  assert.equal(price.cost,Math.ceil(SPECS['seedance-2.5-special2'].priceCny/CNY_PER_USD*CREDITS_PER_USD));
  assert.equal(quoteGateway(m,{duration:30,resolution:'1080p',aspectRatio:'16:9'},CREDITS_PER_USD).cost,price.cost);
  assert.throws(()=>quoteGateway(m,{duration:31}),/Unsupported duration/);
  assert.throws(()=>quoteGateway(m,{resolution:'720p'}),/Unsupported resolution/);
  assert.throws(()=>validateReferences(m,{images:[{mimeType:'image/png'}]}));
});
test('WXKSAI per-second rate scales correctly',()=>{
  const m=modelFor('seedance2.5-buff');
  const cost=n=>quoteGateway(m,{duration:n},CREDITS_PER_USD).cost;
  assert.equal(cost(10),Math.ceil(0.78*10/CNY_PER_USD*CREDITS_PER_USD));
  assert.ok(cost(30)>cost(4));
});
test('WXKSAI Wan 3.0 is priced per second at either 720p or 1080p',()=>{
  const model=modelFor('wan3.0-video');
  for(const resolution of ['720p','1080p']){
    const value=quoteGateway(model,{duration:30,resolution,aspectRatio:'9:16'},CREDITS_PER_USD);
    assert.equal(value.cost,Math.ceil(0.247*30/CNY_PER_USD*CREDITS_PER_USD));
  }
  assert.throws(()=>quoteGateway(model,{duration:31}),/Unsupported duration/);
});
test('WXKSAI Seedance 2.0 900 is fixed at ten seconds and ¥2.1 per clip',()=>{
  const model=modelFor('seedance-2.0-full-720p-900');
  assert.equal(quoteGateway(model,{duration:10,resolution:'720p'},CREDITS_PER_USD).cost,
    Math.ceil(2.1/CNY_PER_USD*CREDITS_PER_USD));
  assert.throws(()=>quoteGateway(model,{duration:15}),/Unsupported duration/);
  assert.throws(()=>quoteGateway(model,{resolution:'1080p'}),/Unsupported resolution/);
});
test('WXKSAI model and task API use one paid POST and exact task status',async()=>{
  const calls=[];
  const client=new WxksaiClient({apiKey:'test-key',fetchImpl:async(url,options)=>{
    calls.push({url,options});
    const payload=url.endsWith('/models')?{data:[{id:'seedance-2.5-special2'}]}:
      options.method==='POST'?{id:'task_abc'}:
      {id:'task_abc',status:'completed'};
    return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
  }});
  assert.equal((await client.models()).data.length,1);
  const op=await client.startVideo({model:{providerModelId:'seedance-2.5-special2'},prompt:'Rain',duration:5,resolution:'1080p',aspectRatio:'16:9'});
  assert.deepEqual(op,{requestId:'task_abc'});
  const post=calls.filter(c=>c.options.method==='POST');
  assert.equal(post.length,1);
  assert.equal(JSON.parse(post[0].options.body).seconds,'5');
  assert.equal(await client.videoStatus(op).then(x=>x.status),'done');
  assert.equal(calls.every(c=>c.options.headers.authorization==='Bearer test-key'),true);
});
test('WXKSAI API failures never auto-submit a second paid request',async()=>{
  let submissions=0;
  const client=new WxksaiClient({apiKey:'test',fetchImpl:async(_url,options)=>{
    if(options.method==='POST'){submissions++;throw new Error('timeout');}
    return new Response('{}',{status:200});
  }});
  await assert.rejects(client.startVideo({model:{providerModelId:'seedance-2.5-special2'},prompt:'P',duration:5,resolution:'1080p',aspectRatio:'16:9'}),/failed or timed out/);
  assert.equal(submissions,1);
});
test('WXKSAI 502 during paid submission is unconfirmed and carries safe diagnostic metadata',async()=>{
  let submissions=0;
  const client=new WxksaiClient({apiKey:'test',fetchImpl:async(_url,options)=>{
    assert.equal(options.method,'POST');
    submissions++;
    return new Response(JSON.stringify({error:'untrusted upstream text'}),{
      status:502,headers:{'x-request-id':'wx-502-abc','content-type':'application/json'},
    });
  }});
  let error;
  try{
    await client.startVideo({model:{providerModelId:'seedance-2.5-full-720p-9img'},prompt:'Cartoon walks',duration:15,resolution:'720p',aspectRatio:'16:9'});
  }catch(e){error=e;}
  assert.equal(submissions,1);
  assert.ok(error);
  assert.equal(error.providerStatus,502);
  assert.equal(error.code,'WXKSAI_UPSTREAM_HTTP');
  assert.equal(error.recoveryStage,'submit');
  assert.equal(error.requestMethod,'POST');
  assert.equal(error.providerRequestId,'wx-502-abc');
  const message=new WxksaiQueue().submitFailureMessage(error);
  assert.match(message,/HTTP 502/);
  assert.match(message,/Task creation is unconfirmed/);
  assert.match(message,/credits were refunded/);
  assert.match(message,/check WXKSAI task history before retrying/);
  assert.doesNotMatch(message,/untrusted upstream text/);
});
test('WXKSAI submission timeouts warn against duplicate paid jobs',()=>{
  const message=new WxksaiQueue().submitFailureMessage({code:'WXKSAI_TIMEOUT'});
  assert.match(message,/did not confirm/);
  assert.match(message,/before retrying/);
});
test('WXKSAI advertises exact per-model reference kinds and does not enable unsupported media',()=>{
  const expected={
    [UNVERIFIED_DOPE_VIDEO_CANDIDATE]:[2,0,0],
    'seedance-2.5-special2':[9,0,3],
    'seedance-2.5-full-720p-9img':[9,0,0],
    'seedance-2.5-full-720p-15-30s':[9,0,0],
    'seedance-2.5-bd-2':[30,10,10],
    'wan3.0-video':[10,5,5],
    'seedance-2.0-full-720p-900':[9,0,0],
    'seedance2.5-buff':[30,1,1], // Conservative pending provider numeric media caps
  };
  for(const [id,limits] of Object.entries(expected)){
    const model=modelFor(id);
    assert.deepEqual(['image','video','audio'].map(kind=>model.referenceCapabilities[kind].max),limits);
    assert.deepEqual(model.referenceCapabilities.video.supported,limits[1]>0);
    assert.deepEqual(model.referenceCapabilities.audio.supported,limits[2]>0);
    assert.ok(model.mediaRoles.includes('image_references'));
    assert.ok(model.supportedOperations.includes('reference-to-video'));
    assert.equal(model.referenceCapabilities.textOnly,true); // text-only still works
  }
});
test('WXKSAI image refs go through multipart images field without JSON content type',async()=>{
  const calls=[];
  const client=new WxksaiClient({apiKey:'test',fetchImpl:async(_url,options)=>{
    calls.push(options);
    return new Response('{"id":"task_img"}',{status:200,headers:{'content-type':'application/json'}});
  }});
  const image=Buffer.from('89504e470d0a1a0a','hex');
  const options={model:{providerModelId:'seedance-2.5-full-720p-9img'},
    prompt:'Keep the subject',duration:15,resolution:'720p',aspectRatio:'16:9'};
  const op=await client.startVideo(options,[{kind:'image',mimeType:'image/png',filename:'subject.png',data:image}]);
  assert.equal(op.requestId,'task_img');
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'POST');
  assert.equal(calls[0].headers['content-type'],undefined);
  assert.equal(calls[0].body instanceof FormData,true);
  assert.equal(calls[0].body.get('model'),'seedance-2.5-full-720p-9img');
  assert.equal(calls[0].body.get('seconds'),'15');
  assert.equal(calls[0].body.getAll('images').length,1);
  assert.equal(calls[0].body.getAll('videos').length,0);
  assert.equal(calls[0].body.getAll('audios').length,0);
  assert.equal(Buffer.from(await calls[0].body.get('images').arrayBuffer()).equals(image),true);
});
test('WXKSAI Special2 sends image/audio but rejects video refs before a paid request',async()=>{
  let posts=0;
  const client=new WxksaiClient({apiKey:'test',fetchImpl:async(_url,options)=>{
    posts++;return new Response('{"id":"task_special"}',{status:200});
  }});
  const options={model:{providerModelId:'seedance-2.5-special2'},prompt:'P',duration:10,resolution:'1080p',aspectRatio:'16:9'};
  const audio=Buffer.alloc(44+16000);
  audio.write('RIFF',0);audio.writeUInt32LE(16036,4);audio.write('WAVE',8);
  audio.write('fmt ',12);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);
  audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(8000,28);
  audio.writeUInt16LE(1,32);audio.writeUInt16LE(8,34);
  audio.write('data',36);audio.writeUInt32LE(16000,40);
  const ref={kind:'audio',filename:'music.wav',mimeType:'audio/wav',data:audio};
  assert.equal((await client.startVideo(options,[ref])).requestId,'task_special');
  assert.equal(posts,1);
  await assert.rejects(client.startVideo(options,[{kind:'video',filename:'clip.mp4',mimeType:'video/mp4',data:Buffer.alloc(48)}]),/does not support/);
  assert.equal(posts,1);
});
test('WXKSAI BD2 supplies real multipart media durations and fails closed before billing',async()=>{
  const posts=[];
  const client=new WxksaiClient({apiKey:'test',fetchImpl:async(_url,options)=>{
    posts.push(options);return new Response('{"id":"task_bd2"}',{status:200});
  }});
  const video=Buffer.alloc(48);video.write('mvhd',4);video.writeUInt32BE(1000,20);video.writeUInt32BE(3000,24);
  const audio=Buffer.alloc(44+16000);
  audio.write('RIFF',0);audio.writeUInt32LE(16036,4);audio.write('WAVE',8);
  audio.write('fmt ',12);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);
  audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(8000,28);
  audio.writeUInt16LE(1,32);audio.writeUInt16LE(8,34);
  audio.write('data',36);audio.writeUInt32LE(16000,40);
  const opts={model:{providerModelId:'seedance-2.5-bd-2'},prompt:'Dance',duration:5,resolution:'720p',aspectRatio:'9:16'};
  const refs=[
    {kind:'video',filename:'motion.mp4',mimeType:'video/mp4',data:video},
    {kind:'audio',filename:'sound.wav',mimeType:'audio/wav',data:audio},
  ];
  await client.startVideo(opts,refs);
  assert.equal(posts.length,1);
  assert.deepEqual(JSON.parse(posts[0].body.get('reference_durations')),{videos:[3],audios:[2]});
  assert.equal(posts[0].body.getAll('videos').length,1);
  assert.equal(posts[0].body.getAll('audios').length,1);
  await assert.rejects(client.startVideo({...opts,duration:4},refs),/at least 5 seconds/);
  await assert.rejects(client.startVideo(opts,[{...refs[0],data:Buffer.alloc(48)}]),/readable duration/);
  assert.equal(posts.length,1); // no paid POST for invalid media
});
test('WXKSAI audio MP3 frame counting determines duration without trusting a client hint',()=>{
  const { mp3Seconds }=require('../src/wxksai_references.js');
  const frame=Buffer.alloc(313);frame.set([0xff,0xfb,0x70,0x00],0);
  const data=Buffer.concat(Array.from({length:120},()=>frame));
  assert.ok(mp3Seconds(data)>3&&mp3Seconds(data)<4);
  assert.equal(mp3Seconds(Buffer.from('not an mp3')),null);
});
test('WXKSAI worker hydrates references from generation storage before submission',async()=>{
  const rows=[{media_kind:'image',media_role:'image_references',filename:'face.png',mime_type:'image/png',media_data:Buffer.from([137,80,78,71])}];
  const q=new WxksaiQueue();
  const files=await q.referenceFiles({execute:async()=>[rows]},{id:'synthetic-generation'});
  assert.equal(files.length,1);
  assert.equal(files[0].kind,'image');
  assert.equal(files[0].filename,'face.png');
  assert.equal(Buffer.isBuffer(files[0].data),true);
});
test('WXKSAI queue is isolated and customer access SQL is scoped',()=>{
  const q=new WxksaiQueue();
  assert.equal(q.provider,'wxksai');
  assert.equal(q.apiKey({wxksaiApiKey:'test'}),'test');
  assert.equal(q.sourceEnabled({wxksaiEnabled:false}),false);
  assert.match(q.queuedSql(),/provider='wxksai'/);
  assert.match(q.queuedSql(),/COALESCE\(a.enabled,0\)/);
});

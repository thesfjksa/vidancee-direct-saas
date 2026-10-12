const test=require('node:test');
const assert=require('node:assert/strict');
const v=require('../src/vercel_models.js');
const {VercelGatewayClient}=require('../src/provider/vercel.js');
const {byteRange,saveVideoOutput,serveVideoOutput,CHUNK_SIZE}=require('../src/video_outputs.js');
const {VercelQueue}=require('../src/vercel_queue.js');
const {EventEmitter}=require('node:events');
const catalog=require('../src/provider/vercel_catalog.json');
const models=v.mediaModels(catalog).map(m=>({...m,...m.options}));
const model=id=>models.find(m=>m.providerModelId===id);
const png=(width=1024,height=1024)=>{const b=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return b;};
const mp4=()=>Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
const drain=()=>new Promise(resolve=>setImmediate(resolve));

test('live media catalog includes multimodal image models and preserves distinct routing',()=>{
  assert.equal(models.length,83);assert.equal(models.filter(m=>m.mediaType==='video').length,39);
  assert.equal(new Set(models.map(m=>m.publicModelId)).size,83);
  assert.equal(model('google/gemini-nano-banana-2.1').mediaType,'image');
  assert.equal(model('topaz/wonder-3.5').adapterSupported,false);
  assert.equal(model('quiverai/arrow-2').adapterSupported,false);
  assert.equal(model('openai/gpt-image-2').adapterSupported,true);
  assert.equal(v.modelReady(model('openai/gpt-image-2')),true);
  assert.equal(v.modelReady(model('bytedance/seedance-2.5')),true);
  assert.equal(model('alibaba/wan-v2.6-t2v').referenceCapabilities.image.max,0);
  assert.throws(()=>v.mediaModels({data:[]}),/previous catalog has been kept/);
});

test('pricing matches resolution/audio/mode tiers, refuses missing rates and separates quality estimates',()=>{
  const veo=model('google/veo-3.0-fast-generate-001');
  const silent=v.quoteGateway(veo,{duration:8,resolution:'720p',generateAudio:false},1000);
  const audio=v.quoteGateway(veo,{duration:8,resolution:'720p',generateAudio:true},1000);
  assert.equal(silent.cost,800);assert.equal(audio.cost,1200);
  const kling=model('klingai/kling-v3.0-i2v');
  assert.equal(v.quoteGateway(kling,{duration:5,generationMode:'std',generateAudio:false},1000).cost,840);
  assert.equal(v.quoteGateway(kling,{duration:5,generationMode:'pro',generateAudio:true},1000).cost,1680);
  const nano=model('google/gemini-nano-banana-2.1');
  assert.equal(v.quoteGateway(nano,{imageSize:'1K'},10000).cost,336);
  assert.equal(v.quoteGateway(nano,{imageSize:'4K'},10000).cost,1134);
  const gpt={...model('openai/gpt-image-2'),priceOverride:{low:0.01,medium:0.03,high:0.1}};
  assert.equal(v.quoteGateway(gpt,{quality:'medium',aspectRatio:'4:5'},1000).cost,38);
  assert.equal(v.quoteGateway(gpt,{quality:'high',aspectRatio:'4:5'},1000).cost,125);
  assert.equal(v.quoteGateway(gpt,{quality:'high'},1000).isEstimate,true);
  assert.throws(()=>v.quoteGateway({...gpt,providerModelId:'openai/unlisted-image',priceOverride:null}),/Set a USD price/);
  assert.throws(()=>v.quoteGateway(veo,{duration:7}),/Unsupported duration/);
  assert.throws(()=>v.quoteGateway(gpt,{quality:'ultra'}),/Unsupported image quality/);
  assert.throws(()=>v.quoteGateway(nano,{imageSize:'8K'}),/Unsupported image resolution/);
  assert.throws(()=>v.normalizePriceOverride({perSecond:0},'video'),/positive/);
  assert.throws(()=>v.quoteGateway({...gpt,eligibility:{status:'ineligible'}}),/unavailable/);
});

test('references reject unsupported inputs, empty required files and mixed frames before billing',()=>{
  const wan=model('alibaba/wan-v2.6-i2v'),data=png();
  assert.throws(()=>v.validateReferences(wan,{}),/requires a reference image/);
  assert.throws(()=>v.validateReferences(model('alibaba/wan-v2.6-t2v'),{images:[{data,mimeType:'image/png'}]}),/Unsupported image/);
  const seed={...model('bytedance/seedance-2.5'),priceOverride:{perSecond:0.1}};
  assert.throws(()=>v.validateReferences(seed,{images:[{data,mimeType:'image/png'},{data,mimeType:'image/png'}],referenceOrder:JSON.stringify([{role:'start_image'},{role:'image_references'}])}),/either start\/end frames/);
  assert.doesNotThrow(()=>v.validateReferences(wan,{images:[{data,mimeType:'image/png'}]}));
  assert.throws(()=>v.validateReferences(wan,{reuseImageIds:'[1,2]'}),/too many files/);
});

test('image generation sends exact GPT canvas/quality, parses Gemini and never repeats a failed paid request',async()=>{
  const calls=[],gpt={...model('openai/gpt-image-2'),priceOverride:{medium:0.03}};
  let result=Response.json({data:[{b64_json:png(1024,1280).toString('base64')}]});
  const client=new VercelGatewayClient({apiKey:'secret-only',fetchImpl:async(url,opts)=>{calls.push({url,opts});return result;}});
  await client.generateImage(gpt,{prompt:'portrait',aspectRatio:'4:5',quality:'medium'});
  assert.ok(calls[0].url.endsWith('/v1/images/generations'));
  const body=JSON.parse(calls[0].opts.body);assert.equal(body.size,'1024x1280');assert.equal(body.quality,'medium');
  result=Response.json({data:[{b64_json:png(1280,1024).toString('base64')}]});
  await assert.rejects(client.generateImage(gpt,{prompt:'portrait',aspectRatio:'4:5',quality:'medium'}),/different aspect ratio/);
  assert.equal(calls.length,2);
  result=Response.json({choices:[{message:{images:[{image_url:{url:'data:image/png;base64,'+png().toString('base64')}}]}}]});
  await client.generateImage(model('google/gemini-nano-banana-2.1'),{prompt:'flower',aspectRatio:'1:1',imageSize:'2K'},[{url:'https://app.example/ref.png'}]);
  const google=JSON.parse(calls[2].opts.body);
  assert.ok(calls[2].url.endsWith('/v1/chat/completions'));assert.equal(google.providerOptions.google.imageConfig.imageSize,'2K');assert.equal(google.messages[0].content.length,2);
  result=new Response('secret-only upstream response',{status:402});
  await assert.rejects(client.generateImage(gpt,{prompt:'flower',aspectRatio:'1:1',quality:'medium'}),error=>/insufficient credits/.test(error.message)&&!error.message.includes('secret-only'));
  assert.equal(calls.length,4);
});

test('gateway video transport persists the operation contract and uses a stable idempotency key',async()=>{
  const calls=[],operation={jobId:'gateway-job',token:'opaque-operation'};
  const client=new VercelGatewayClient({apiKey:'secret-only',fetchImpl:async(url,opts)=>{
    calls.push({url,opts});return Response.json(url.endsWith('/start')?{operation}:{status:'completed',videos:[{type:'base64',data:mp4().toString('base64'),mediaType:'video/mp4'}]});
  }});
  const veo=model('google/veo-3.0-fast-generate-001');
  const result=await client.startVideo(veo,{id:'local-generation-uuid',prompt:'flower',duration:8,resolution:'1080p',aspectRatio:'9:16',generateAudio:true},[{role:'start_image',url:'https://app.example/ref.png',mimeType:'image/png'}]);
  assert.deepEqual(result.operation,operation);
  assert.equal(calls[0].opts.headers['idempotency-key'],'local-generation-uuid');
  assert.equal(calls[0].opts.headers['ai-video-model-specification-version'],'4');
  assert.equal(JSON.parse(calls[0].opts.body).resolution,'1080x1920');
  assert.equal(JSON.parse(calls[0].opts.body).image.type,'url');
  const status=await client.videoStatus(veo.providerModelId,operation);
  assert.deepEqual(JSON.parse(calls[1].opts.body),{operation});
  assert.deepEqual((await client.videoOutput(status.videos[0])).data,mp4());
  await assert.rejects(client.startVideo(veo,{},[{role:'start_image'},{role:'image_references'}]),/either frames or reference/);
});

test('media downloads require public HTTPS links and never attach API credentials',async()=>{
  const calls=[];
  const c=new VercelGatewayClient({apiKey:'secret-only',fetchImpl:async(url,opts)=>{calls.push({url,opts});return new Response(mp4());}});
  await c.videoOutput({type:'url',url:'https://cdn.example/video.mp4'});
  assert.equal(calls[0].opts.headers,undefined);
  for(const url of ['http://cdn.example/video.mp4','https://localhost/video.mp4','https://127.0.0.1/video.mp4'])await assert.rejects(c.videoOutput({type:'url',url}),/invalid media URL/);
  assert.equal(calls.length,1);
});

test('video chunks persist atomically and playback returns exact bytes across range boundaries',async()=>{
  const bytes=Buffer.alloc(CHUNK_SIZE+20,42),chunks=new Map();let meta;
  const db={async execute(sql,args){
    if(sql.startsWith('INSERT INTO generation_video_outputs')){meta={mime_type:args[1],byte_length:args[2]};return [{affectedRows:1}];}
    if(sql.startsWith('INSERT INTO generation_video_chunks')){chunks.set(args[1],Buffer.from(args[2]));return [{affectedRows:1}];}
    if(sql.includes('FROM generation_video_outputs'))return [[meta]];
    if(sql.includes('FROM generation_video_chunks'))return [[{video_data:chunks.get(args[1])}]];
    throw new Error(sql);
  }};
  await saveVideoOutput(db,'job',{mimeType:'video/mp4',data:bytes});
  assert.equal(chunks.size,2);
  const res=new EventEmitter();res.out=[];res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.write=b=>{res.out.push(b);return true;};res.end=()=>{};
  await serveVideoOutput(db,{headers:{range:'bytes='+(CHUNK_SIZE-5)+'-'+(CHUNK_SIZE+4)}},res,'job');
  assert.equal(res.status,206);assert.equal(res.headers['content-length'],10);assert.deepEqual(Buffer.concat(res.out),bytes.subarray(CHUNK_SIZE-5,CHUNK_SIZE+5));
  assert.deepEqual(byteRange('bytes=-10',100),{start:90,end:99,partial:true});
  assert.equal(byteRange('bytes=100-',100),null);assert.equal(byteRange('bytes=0-1,5-6',100),null);
});

test('queue recovery refunds interrupted starts without submitting and resumes existing operations after restart',async()=>{
  const refunds=[],writes=[];let starts=0,polls=0;
  const saved={model:model('google/veo-3.0-fast-generate-001'),duration:8,resolution:'720p',aspectRatio:'16:9'};
  const pending={id:'active-video',model:saved.model.publicModelId,media_type:'video',prompt:'flower',status:'submitted',submitted_at:new Date(),generation_options:JSON.stringify(saved),provider_operation:'{"jobId":"kept"}'};
  const db={async query(sql){if(sql.includes("status='submitting'"))return [[{id:'interrupted-start'}]];if(sql.includes('ORDER BY updated_at'))return [[pending]];throw new Error(sql);},
    async execute(sql,args){writes.push({sql,args});return [{affectedRows:1}];}};
  const queue=new VercelQueue({refund:async(...args)=>refunds.push(args),clientFactory:()=>({startVideo:async()=>{starts++;},videoStatus:async(_,op)=>{polls++;assert.equal(op.jobId,'kept');return {status:'pending'};}})});
  await queue.runOnce(db,{vercelApiKey:'test-only',vercelEnabled:false,allowProviderCharges:false});await drain();
  assert.equal(refunds[0][0],'interrupted-start');assert.equal(starts,0);assert.equal(polls,1);
  assert.ok(writes[0].sql.includes("status='processing'"));assert.equal(queue.tasks.size,0);
});

test('a slow image request does not block queue polls; compare-and-swap claims prevent duplicate submission',async()=>{
  const row={id:'slow-image',model:'public-model',media_type:'image',prompt:'flower',generation_options:JSON.stringify({model:model('bfl/flux-kontext-pro'),aspectRatio:'1:1'})};
  const writes=[];let finish,started=0,claimUpdates=0;
  const conn={async query(sql){if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('COUNT'))return [[{total:0}]];if(sql.includes('SELECT g.*')){assert.ok(sql.includes('COALESCE(a.enabled,1)=1'));assert.ok(sql.includes('m.enabled=1'));return [[row]];}return [[]];},
    async execute(){claimUpdates++;return [{affectedRows:claimUpdates===1?1:0}];},release(){}};
  const db={getConnection:async()=>conn,execute:async(sql,args)=>{writes.push({sql,args});return [[]];}};
  const queue=new VercelQueue({getModel:async()=>({ready:true})});
  const client={generateImage:async()=>{started++;return new Promise(resolve=>{finish=resolve;});}};
  await queue.claim(db,2,client);await drain();
  assert.equal(started,1);assert.equal(queue.tasks.size,1);
  await queue.claim(db,2,client);await drain();assert.equal(started,1);
  queue.complete=async()=>{};finish({data:png(),mimeType:'image/png'});await drain();assert.equal(queue.tasks.size,0);
});

test('in-flight gateway requests send a heartbeat and only abandoned claims are recovered',async()=>{
  const {VercelQueue}=require('../src/vercel_queue.js');
  const queue=new VercelQueue({getSettings:async()=>({vercelApiKey:'',vercelEnabled:false,allowProviderCharges:false}),
    refund:async id=>refunded.push(id)});
  const refunded=[],sql=[];
  queue.tasks.add('running-here');
  const db={async query(text,args){sql.push([text,args]);
    if(text.startsWith('UPDATE generations SET updated_at'))return [{affectedRows:1}];
    if(text.includes("status='submitting'"))return [[{id:'running-here'},{id:'abandoned'}]];
    throw new Error(text);}};
  await queue.runOnce(db);
  assert.match(sql[0][0],/^UPDATE generations SET updated_at/);
  assert.deepEqual(sql[0][1],[['running-here']]);
  assert.match(sql[1][0],/media_type='image' AND status='processing' AND updated_at<DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 3 MINUTE\)/);
  assert.deepEqual(refunded,['abandoned']);
});

test('shutdown drain waits for in-flight requests up to its limit',async()=>{
  const {VercelQueue}=require('../src/vercel_queue.js');
  const queue=new VercelQueue();
  queue.tasks.add('a');setTimeout(()=>queue.tasks.delete('a'),300);
  assert.equal(await queue.drain(5000),0);
  queue.tasks.add('b');
  const started=Date.now();
  assert.equal(await queue.drain(200),1);
  assert.ok(Date.now()-started<1500);
});

test('Recraft requests use the fixed sizes Recraft accepts and their outputs pass the canvas check',()=>{
  const {imageDimensions}=require('../src/vercel_models.js');
  const size=(id,ratio)=>imageDimensions({providerModelId:id},{aspectRatio:ratio});
  assert.equal(size('recraft/recraft-v4','3:4'),'896x1216');
  assert.equal(size('recraft/recraft-v4.1','16:9'),'1344x768');
  assert.equal(size('recraft/recraft-v4-pro','3:4'),'1792x2432');
  assert.equal(size('recraft/recraft-v4.1-pro','1:1'),'2048x2048');
  assert.equal(size('recraft/recraft-v2','3:4'),'1024x1365');
  assert.equal(size('recraft/recraft-v3','16:9'),'1820x1024');
  assert.throws(()=>size('recraft/recraft-v4','21:9'),/not available/);
  // Every offered Recraft shape must survive the returned-image aspect check.
  const {validateCanvas}=require('../src/image_canvas.js');
  const png=(w,h)=>{const b=Buffer.alloc(33);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;};
  for(const id of ['recraft/recraft-v2','recraft/recraft-v4','recraft/recraft-v4.1-pro'])
    for(const ratio of ['1:1','16:9','9:16','4:3','3:4','3:2','2:3']){
      const [w,h]=size(id,ratio).split('x').map(Number);
      assert.doesNotThrow(()=>validateCanvas(png(w,h),'image/png',ratio),id+' '+ratio);
    }
  assert.throws(()=>validateCanvas(png(1280,1024),'image/png','4:3'),/different aspect ratio/);
});

test('GPT Image models use OpenAI published per-image prices unless Admin sets one',()=>{
  const usd=(id,input)=>v.quoteGateway(model(id),input,1).sourceUsd;
  for(const id of ['openai/gpt-image-1','openai/gpt-image-1-mini','openai/gpt-image-1.5','openai/gpt-image-2','openai/gpt-image-2.5-flare','openai/gpt-image-2.5-sunburst'])
    assert.equal(v.modelReady(model(id)),true,id);
  assert.equal(usd('openai/gpt-image-1',{quality:'low',aspectRatio:'1:1'}),0.011);
  assert.equal(usd('openai/gpt-image-1',{quality:'high',aspectRatio:'2:3'}),0.25);
  assert.equal(usd('openai/gpt-image-1-mini',{quality:'medium',aspectRatio:'3:2'}),0.015);
  assert.equal(usd('openai/gpt-image-1.5',{quality:'high',aspectRatio:'1:1'}),0.133);
  // GPT Image 2: published sizes are exact; other presets use the highest price for the quality.
  assert.equal(usd('openai/gpt-image-2',{quality:'medium',aspectRatio:'3:2'}),0.041);
  assert.equal(usd('openai/gpt-image-2',{quality:'medium',aspectRatio:'16:9'}),0.053);
  assert.equal(usd('openai/gpt-image-2.5-flare',{quality:'high',aspectRatio:'9:16'}),0.211);
  assert.equal(v.quoteGateway(model('openai/gpt-image-2'),{quality:'high'},1000).cost,211);
  assert.equal(v.quoteGateway(model('openai/gpt-image-1'),{quality:'low'},1000).isEstimate,true);
  // An Admin price still wins over the published table.
  assert.equal(v.quoteGateway({...model('openai/gpt-image-2'),priceOverride:{high:0.1}},{quality:'high'},1000).cost,100);
  assert.deepEqual(v.publishedImageTiers('google/gemini-nano-banana-2.1'),[]);
  assert.equal(v.publishedImageTiers('openai/gpt-image-1').length,9);
  // One picker entry per model name: the direct source keeps GPT Image 2.
  const {addMissingImageModels}=require('../src/provider_models.js');
  const merged=addMissingImageModels([{id:'gpt_image_2_studio',label:'GPT Image 2'}],[{id:'studio_gw_openai_gpt_image_2',label:'GPT Image 2 '},{id:'studio_gw_openai_gpt_image_1',label:'GPT Image 1'}]);
  assert.deepEqual(merged.map(m=>m.id),['gpt_image_2_studio','studio_gw_openai_gpt_image_1']);
});

test('FLUX 3 offers common shapes, priced by resolution class',()=>{
  const flux=model('bfl/flux-3-image');
  assert.deepEqual(flux.aspectRatios,['1:1','16:9','9:16','4:3','3:4','3:2','2:3']);
  assert.equal(v.imageDimensions(flux,{aspectRatio:'1:1',imageSize:'1024x1024'}),'1024x1024');
  assert.equal(v.imageDimensions(flux,{aspectRatio:'16:9',imageSize:'1024x1024'}),'1360x768');
  assert.equal(v.imageDimensions(flux,{aspectRatio:'2:3',imageSize:'1536x1536'}),'1248x1888');
  assert.equal(v.imageDimensions(flux,{aspectRatio:'16:9',imageSize:'4096x4096'}),'4096x2304');
  assert.equal(v.quoteGateway(flux,{aspectRatio:'16:9',imageSize:'1024x1024'},1).sourceUsd,0.024);
  assert.equal(v.quoteGateway(flux,{aspectRatio:'9:16',imageSize:'4096x4096'},1).sourceUsd,0.3035);
  assert.throws(()=>v.quoteGateway(flux,{aspectRatio:'21:9',imageSize:'1024x1024'},1),/Unsupported aspect ratio/);
  // Rows saved by an earlier sync still get the shapes.
  assert.deepEqual(v.applyModelFixups({...flux,aspectRatios:['1:1']}).aspectRatios.length,7);
});

test('Seedance 2.x is priced from video tokens, including reference clips',()=>{
  const seed=model('bytedance/seedance-2.5');
  // 1280x720 at 24 fps = 21,600 tokens per second; 10 s at 10.7 USD per million tokens.
  assert.equal(v.quoteGateway(seed,{duration:10,resolution:'720p',aspectRatio:'16:9'},1).sourceUsd.toFixed(4),'2.3112');
  assert.equal(v.quoteGateway(seed,{duration:10,resolution:'720p',aspectRatio:'16:9'},1).isEstimate,true);
  assert.equal(v.quoteGateway(seed,{duration:5,resolution:'1080p',aspectRatio:'16:9'},1).sourceUsd.toFixed(4),(1920*1080*24/1024*5*11.7/1e6).toFixed(4));
  // A 4 s reference clip: input and output tokens at the reduced 6.4 rate.
  const mvhd=Buffer.alloc(40);mvhd.write('mvhd',4);mvhd.writeUInt32BE(1000,20);mvhd.writeUInt32BE(4000,24);
  const clip=Buffer.concat([Buffer.from('000000186674797069736f6d','hex'),mvhd]);
  assert.equal(v.mp4Seconds(clip),4);
  assert.equal(v.mp4Seconds(Buffer.from('not a video')),null);
  assert.equal(v.quoteGateway(seed,{duration:10,resolution:'720p',aspectRatio:'16:9',videos:[{data:clip}]},1).sourceUsd.toFixed(4),(21600*14*6.4/1e6).toFixed(4));
  // Unreadable clip: billed as the longest allowed input (30 s).
  assert.equal(v.quoteGateway(seed,{duration:10,resolution:'720p',aspectRatio:'16:9',videos:[{data:Buffer.from('x')}]},1).sourceUsd.toFixed(4),(21600*40*6.4/1e6).toFixed(4));
  assert.equal(v.modelReady(model('bytedance/seedance-2.0-mini')),true);
});

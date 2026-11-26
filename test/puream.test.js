'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {pureamMediaModels,BASE_URL}=require('../src/puream_models.js');
const {quoteGateway,validateReferences}=require('../src/vercel_models.js');
const {publicVideoModel,serializeProviderModel}=require('../src/provider_models.js');
const {PureamClient,payloadFor}=require('../src/provider/puream.js');
const {PureamQueue}=require('../src/puream_queue.js');
const {pureamPerformance}=require('../src/puream_performance.js');
const {CREDITS_PER_USD}=require('../src/billing.js');
const crypto=require('node:crypto');

// Synthetic catalog mirrors the documented and observed schema, including
// different duration ranges and price per resolution. No account credentials.
const raw={id:'puream-sd25-abcdef123456',name:'Seedance 2.5 · ABC123',family:'seedance25',available:true,
  resolutions:['480p','720p'],durations_by_resolution:{'480p':[15,18,30],'720p':[18,30]},
  pricing_by_resolution:{'480p':{billing_unit:'successful_video',price_yuan:4.485},'720p':{billing_unit:'successful_video',price_yuan:5.25}},
  aspect_ratios:['16:9','9:16'],max_images:30,max_videos:10,max_audios:10,max_prompt_characters:5000,
  requires_reference:false,generation_modes:['reference'],reference_limits:{max_total_media_files:30,max_video_seconds_total:30,max_audio_seconds_total:30,audio_requires_visual:false}};
const catalog={data:[raw]};
const row=pureamMediaModels(catalog)[0];
const model={...row.options,provider:'puream',providerModelId:row.providerModelId,publicModelId:row.publicModelId,label:row.label,mediaType:'video',ready:true};
const options={model,prompt:'Follow @Video1 and @Image1',duration:30,resolution:'720p',aspectRatio:'9:16',generationMode:'reference'};
const refs=[{url:'https://example.com/image.jpg',mimeType:'image/jpeg'},{url:'https://example.com/video.mp4',mimeType:'video/mp4'}];

test('live catalog preserves per-resolution durations, reference counts and price in cents',()=>{
  assert.equal(model.referenceCapabilities.totalMax,30);assert.equal(model.referenceCapabilities.video.max,10);
  assert.equal(model.defaultDuration,30);
  assert.throws(()=>quoteGateway(model,{resolution:'720p',duration:15},CREDITS_PER_USD),/Unsupported duration/);
  assert.equal(quoteGateway(model,{resolution:'720p',duration:18},CREDITS_PER_USD).cost,5040);
  assert.equal(quoteGateway(model,{resolution:'720p',duration:30},CREDITS_PER_USD).cost,5040);
  assert.equal(quoteGateway(model,{resolution:'480p',duration:15},CREDITS_PER_USD).cost,4311); // ¥4.49 * 960 rounded up
  const p=publicVideoModel(model);assert.equal(p.billingMode,'per_request');assert.deepEqual(p.resolutions[1].durations.map(d=>d.seconds),[18,30]);
  const m=serializeProviderModel({id:1,provider:'puream',provider_model_id:row.providerModelId,public_model_id:row.publicModelId,label:row.label,media_type:'video',enabled:1,available:1,options_json:JSON.stringify(row.options)});
  assert.equal(m.ready,true);assert.equal(m.puream.tiers['720p'].priceCny,5.25);
  assert.throws(()=>pureamMediaModels({data:[{...raw,available:false}]}),/No available/);
  assert.throws(()=>pureamMediaModels({...catalog,catalog_sync:{confirmed:false}}),/confirmed model catalog/);
  const perSecond=pureamMediaModels({data:[{...raw,pricing_by_resolution:{'480p':{billing_unit:'second',price_yuan:0.135},'720p':{billing_unit:'second',price_yuan:0.25}}} ]})[0];
  const m2={...model,...perSecond.options};assert.equal(publicVideoModel(m2).billingMode,'per_second');
  assert.equal(quoteGateway(m2,{resolution:'720p',duration:30},CREDITS_PER_USD).cost,7200);
});

test('reject over-limit references, map English mention labels and use stable JSON fields',()=>{
  const input={...options,images:[],videos:[],audios:[],reuseImageIds:[]};
  assert.throws(()=>payloadFor(options,refs.slice(0,1)),/not supplied/);
  assert.throws(()=>payloadFor(options,[...refs,{url:'http://example.com/a.jpg',mimeType:'image/jpeg'}]),/HTTPS/);
  const payload=payloadFor(options,refs);
  assert.deepEqual(payload,{model:raw.id,prompt:'Follow @视频1 and @图片1',seconds:30,resolution:'720p',aspect_ratio:'9:16',generation_mode:'reference',reference_images:[refs[0].url],reference_videos:[refs[1].url]});
  assert.doesNotThrow(()=>validateReferences(model,input,{forQuote:true}));
  const image={data:Buffer.from('a'),mimeType:'image/jpeg'};
  assert.throws(()=>validateReferences(model,{...input,images:Array(30).fill(image),audios:[{data:Buffer.from('a'),mimeType:'audio/mpeg'}]}),/Too many/);
});

test('client authenticates against documented origin, sends a single idempotent request and polls same task',async()=>{
  const requests=[];
  const client=new PureamClient({apiKey:'test-secret',fetchImpl:async(url,request)=>{
    requests.push([url,request]);
    if(url.endsWith('/models'))return Response.json(catalog);
    if(url.endsWith('/videos'))return Response.json({id:'yv_abc',quoted_charge_yuan:5.25},{status:202});
    return Response.json({id:'yv_abc',status:'failed',billing_status:'not_charged',charge_yuan:0,error:{code:'UPSTREAM_SUBMISSION_REJECTED',message:'ignored'}});
  }});
  await client.models();const payload=payloadFor(options,refs);
  assert.deepEqual(await client.startVideo(payload,'cmm-job1'),{requestId:'yv_abc',quotedCny:5.25});
  const result=await client.videoStatus('yv_abc');assert.equal(result.billingStatus,'not_charged');assert.equal(result.errorCode,'UPSTREAM_SUBMISSION_REJECTED');
  assert.deepEqual(requests.map(([url])=>url),[BASE_URL+'/models',BASE_URL+'/videos',BASE_URL+'/videos/yv_abc']);
  assert.equal(requests[1][1].headers.authorization,'Bearer test-secret');assert.equal(requests[1][1].headers['Idempotency-Key'],'cmm-job1');
  assert.deepEqual(JSON.parse(requests[1][1].body),payload);
  await assert.rejects(new PureamClient({apiKey:'x',fetchImpl:async()=>new Response('',{status:402})}).startVideo(payload,'cmm-job'),e=>e.statusCode===402&&!e.ambiguous);
});

test('ambiguous submission resumes the exact persisted payload and refunds only confirmed failure',async()=>{
  const changes=[],requests=[],refunds=[];
  const db={execute:async(sql,params)=>{changes.push([sql,params]);return [{affectedRows:1}];}};
  let tries=0;
  const client={apiKey:'test-secret',models:async()=>catalog,startVideo:async(payload,key)=>{requests.push({payload,key});if(!tries++)throw Object.assign(new Error('timeout'),{ambiguous:true});return {requestId:'yv_abc',quotedCny:5.25};}};
  const q=new PureamQueue({getModel:async()=>model,refund:async(...args)=>refunds.push(args)});
  q.log=()=>{};q.references=async()=>refs;q.sourceReady=true;
  const job={id:'test-job',model:row.publicModelId,prompt:options.prompt,provider_cost:5.25,generation_options:JSON.stringify(options)};
  await q.submit(db,job,client);assert.equal(requests.length,1);
  const prepared=JSON.parse(changes[0][1][0]);assert.equal(prepared.key,'cmm-test-job');assert.equal(prepared.credential,crypto.createHash('sha256').update(client.apiKey).digest('hex'));
  assert.equal(JSON.stringify(prepared).includes('test-secret'),false);
  await q.pollJob(db,client,{...job,provider_operation:JSON.stringify(prepared)});
  assert.deepEqual(requests[0],requests[1]);
  const op=JSON.parse(changes.at(-1)[1][0]);assert.equal(op.requestId,'yv_abc');
  client.videoStatus=async()=>({status:'failed',billingStatus:'pending'});await q.pollJob(db,client,{...job,provider_operation:JSON.stringify(op)});assert.equal(refunds.length,0);
  client.videoStatus=async()=>({status:'failed',billingStatus:'not_charged',errorCode:'UPSTREAM_SUBMISSION_REJECTED'});await q.pollJob(db,client,{...job,provider_operation:JSON.stringify(op)});assert.equal(refunds.length,1);
});

test('local performance is computed from actual generation outcomes',async()=>{
  const p=await pureamPerformance({query:async()=>[[{model:row.publicModelId,samples:4,successes:3,averageLatencyMs:1234}]]});
  assert.deepEqual(p.models[row.publicModelId],{successRate:75,averageLatencyMs:1234,samples:4});
});

test('completed task downloads the same task, does not forward the key to the CDN, and cleans staged output',async()=>{
  const records=[],writes=[];
  const box=(type,data=Buffer.alloc(0))=>{const header=Buffer.alloc(8);header.writeUInt32BE(8+data.length);header.write(type,4);return Buffer.concat([header,data]);};
  const mp4=Buffer.concat([box('ftyp',Buffer.from('isom0000')),box('moov'),box('mdat',Buffer.from('synthetic'))]);
  const client=new PureamClient({apiKey:'test-secret',fetchImpl:async(url,options)=>{
    records.push({url,options});
    if(url.endsWith('/content'))return new Response(null,{status:302,headers:{location:'https://cdn.example.com/video.mp4'}});
    return Response.json({id:'yv_abc',status:'completed',billing_status:'charged',charge_yuan:5.25});
  },fetchMedia:async(url,options)=>{
    records.push({url,options});
    return {body:new Response(mp4).body,contentLength:mp4.length};
  }});
  const db={execute:async(sql,params)=>{writes.push([sql,params]);return [{affectedRows:1}];}};
  const q=new PureamQueue();
  let staged;
  q.complete=async(_db,job,output)=>{assert.equal(job.id,'test-job');assert.deepEqual(await output.readChunk(0,output.size),mp4);staged=output;};
  const job={id:'test-job',provider_operation:JSON.stringify({requestId:'yv_abc',credential:crypto.createHash('sha256').update(client.apiKey).digest('hex')})};
  await q.pollJob(db,client,job);
  assert.equal(writes[0][1][0],5.25);
  assert.deepEqual(records.map(r=>r.url),[BASE_URL+'/videos/yv_abc',BASE_URL+'/videos/yv_abc/content','https://cdn.example.com/video.mp4']);
  assert.equal(records[1].options.headers.authorization,'Bearer test-secret');
  assert.equal(JSON.stringify(records[2].options).includes('test-secret'),false);
  await assert.rejects(staged.readChunk(0,8));
});

test('catalog retries transient network errors once without exposing credentials or retrying submissions',async()=>{
  let count=0;
  const client=new PureamClient({apiKey:'test-secret',fetchImpl:async()=>{
    if(++count===1)throw Object.assign(new Error('private token test-secret'),{cause:{code:'ECONNRESET'}});
    return Response.json(catalog);
  }});
  assert.deepEqual(await client.models(),catalog);assert.equal(count,2);
  count=0;
  const failing=new PureamClient({apiKey:'test-secret',fetchImpl:async()=>{
    count++;throw Object.assign(new Error('private token test-secret'),{cause:{code:'ECONNRESET'}});
  }});
  await assert.rejects(failing.models(),e=>e.transportReason==='ECONNRESET'&&!e.message.includes('test-secret'));assert.equal(count,2);
  count=0;
  await assert.rejects(failing.startVideo(payloadFor(options,refs),'cmm-job'),e=>e.ambiguous===true);assert.equal(count,1);
  count=0;
  const auth=new PureamClient({apiKey:'test-secret',fetchImpl:async()=>{count++;return new Response('',{status:401});}});
  await assert.rejects(auth.models(),e=>e.providerStatus===401);assert.equal(count,1);
  const timeout=new PureamClient({apiKey:'test-secret',fetchImpl:async()=>{throw Object.assign(new Error('secret'),{name:'TimeoutError'});}});
  await assert.rejects(timeout.models(),e=>e.transportReason==='TIMEOUT'&&!e.message.includes('secret'));
});

test('catalog separates HTML, malformed JSON, empty and truncated responses; never exposes raw response or repeats a paid POST',async()=>{
  let calls=0;
  const html=new PureamClient({apiKey:'secret',fetchImpl:async()=>{calls++;return new Response('<html>secret</html>',{headers:{'content-type':'text/html'}});}});
  await assert.rejects(html.models(),e=>e.responseReason==='HTML_OR_XML_RESPONSE'&&!e.message.includes('secret'));assert.equal(calls,1);
  calls=0;
  const malformed=new PureamClient({apiKey:'secret',fetchImpl:async()=>{calls++;return new Response('invalid secret');}});
  await assert.rejects(malformed.models(),e=>e.responseReason==='MALFORMED_JSON'&&!e.message.includes('secret'));assert.equal(calls,1);
  calls=0;
  const recovered=new PureamClient({apiKey:'secret',fetchImpl:async(_url,options)=>{
    assert.equal(options.headers['accept-encoding'],'identity');
    return ++calls===1?new Response('partial',{headers:{'content-length':'100'}}):Response.json(catalog);
  }});
  assert.deepEqual(await recovered.models(),catalog);assert.equal(calls,2);
  calls=0;
  const empty=new PureamClient({apiKey:'secret',fetchImpl:async()=>{calls++;return new Response('');}});
  await assert.rejects(empty.models(),e=>e.responseReason==='EMPTY_BODY');assert.equal(calls,2);
  calls=0;
  await assert.rejects(empty.startVideo(payloadFor(options,refs),'cmm-job'),e=>e.ambiguous===true&&e.responseReason==='EMPTY_BODY');assert.equal(calls,1);
  const bom=new PureamClient({apiKey:'secret',fetchImpl:async()=>new Response('\uFEFF'+JSON.stringify(catalog))});
  assert.deepEqual(await bom.models(),catalog);
});

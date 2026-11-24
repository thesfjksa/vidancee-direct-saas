const test = require('node:test');
const assert = require('node:assert/strict');
const { VgenvClient } = require('../src/provider/vgenv.js');
const { quoteLongH3Video } = require('../src/vgenv_long_video.js');
const { GenerationWorker } = require('../src/worker_admin_settings.js');
const { quoteVideoTool } = require('../src/vgenv_video_tools.js');
const { cnyToCredits } = require('../src/billing.js');

test('long video capabilities, quote, create and poll use the dedicated resource', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options={}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({url,body,headers:options.headers});
    if (url.endsWith('/capabilities')) return Response.json({materialsEnabled:true});
    if (url.endsWith('/quote')) return Response.json({price:{currency:'CNY',amount_micros:900000}});
    if (url.endsWith('/long-videos')) return Response.json({id:'long_job',status:'preparing',price:{currency:'CNY',amount_micros:900000}}, {status:202});
    if (url.endsWith('/long_job')) return Response.json({id:'long_job',status:'succeeded',output:{url:'https://example.com/final.mp4'}});
    throw Error('Unexpected request: '+url);
  });
  const client = new VgenvClient({apiKey:'test-key'});
  const input = {model:'minimax_h3_origin',duration:30,resolution:'768p',aspectRatio:'16:9'};
  const inputs = [{asset_id:'asset_1',role:'reference',position:0}];
  const q = await quoteLongH3Video(client,input,{inputs});
  assert.deepEqual(q,{cost:cnyToCredits(0.9),sourcePrice:0.9,sourceUnit:'cny',resolution:'768p',isEstimate:false});
  assert.deepEqual(calls[1].body,{model:'origin',tier:'fast',duration:30,resolution:'768p',aspect_ratio:'16:9',inputs});
  const result = await client.generateVideo({...input,model:'origin',tier:'fast',prompt:'A walk in a garden',inputs,idempotencyKey:'stable-123'});
  assert.equal(result.id,'long_job');
  assert.deepEqual(calls[2].body,{...calls[1].body,prompt:'A walk in a garden'});
  assert.equal(calls[2].headers['Idempotency-Key'],'stable-123');
  assert.equal((await client.getVideo(result.id,{long:true})).outputUrl,'https://example.com/final.mp4');
  assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/v3/long-videos/capabilities','/v3/long-videos/quote','/v3/long-videos','/v3/long-videos/long_job']);
});

test('reference restrictions and invalid long-video lengths fail before paid submission', async () => {
  let quotes=0;
  const client = {longVideoCapabilities:async()=>({materialsEnabled:false}),quoteLongVideo:async()=>{quotes++;}};
  const input={model:'minimax_h3',duration:30,resolution:'768p',aspectRatio:'9:16'};
  await assert.rejects(quoteLongH3Video(client,{...input,previewHasReferences:true}),/reference files are currently unavailable/);
  await assert.rejects(quoteLongH3Video(client,{...input,duration:31}),/not enabled/);
  assert.equal(quotes,0);
  assert.throws(()=>quoteVideoTool({tool:'character-swap',duration:30}),/4 to 15/);
});

test('long video worker persists reference assets and preflight, replays without re-quoting, and polls the right resource', async t => {
  const worker = new GenerationWorker();
  t.after(()=>worker.stop());
  let operations=[],sent=[],quotes=[],uploads=0,capabilities=0;
  const row = {id:'local-long',user_id:1,model:'minimax_beast',duration:30,resolution:'480p',aspect_ratio:'9:16',prompt:'A scene',mode:'image-to-video',provider_cost:0.3,provider_cost_unit:'usd'};
  worker.vgenv = {
    longVideoCapabilities:async()=>{capabilities++;return {materialsEnabled:true};},
    uploadAsset:async()=> 'asset_'+(++uploads),
    quoteLongVideo:async p=>{quotes.push(p);return {price:0.3,currency:'USD'};},
    generateVideo:async p=>{sent.push(p);return {id:'long_remote',price:0.3,currency:'USD'};},
    getVideo:async (id,options)=>{assert.equal(id,'long_remote');assert.equal(options.long,true);return {status:'succeeded',outputUrl:'https://example.com/long.mp4',price:0.3,currency:'USD'};},
  };
  const writes=[];
  const db = {execute:async (sql,args)=>{
    if (sql.includes('FROM generation_images')) return [[{position_index:0,filename:'i.png',mime_type:'image/png',image_data:Buffer.from('image')}]];
    if (sql.includes('FROM generation_media')) return [[{position_index:1,media_kind:'audio',filename:'a.wav',mime_type:'audio/wav',media_data:Buffer.from('audio')},{position_index:2,media_kind:'video',filename:'v.mp4',mime_type:'video/mp4',media_data:Buffer.from('video')}]];
    if(sql.startsWith('UPDATE generations SET provider_operation'))operations.push(JSON.parse(args[0]));
    writes.push([sql,args]);
    return [{affectedRows:1}];
  },query:async()=>[[{...row,provider_job_id:'long_remote'}]]};
  await worker.submitVgenv(db,row,1);
  assert.deepEqual(sent[0].inputs,[{asset_id:'asset_1',role:'reference',position:0},{asset_id:'asset_2',role:'reference_audio',position:0},{asset_id:'asset_3',role:'reference_video',position:0}]);
  assert.deepEqual(quotes[0].inputs,sent[0].inputs);
  assert.equal(sent[0].tier,'quality');
  assert.ok(operations.at(-1).longQuoteApprovedAt);
  await worker.submitVgenv(db,{...row,provider_operation:JSON.stringify(operations.at(-1))},1);
  assert.deepEqual(sent[1],sent[0]);
  assert.equal(uploads,3);
  assert.equal(quotes.length,1);
  assert.equal(capabilities,1);
  await worker.syncVgenv(db);
  assert.ok(writes.at(-1)[0].includes("status='completed'"));
});

test('increased provider quote prevents a long-video paid request',async t=>{
  const worker = new GenerationWorker();
  t.after(()=>worker.stop());
  worker.vgenv={longVideoCapabilities:async()=>({materialsEnabled:true}),quoteLongVideo:async()=>({price:0.2,currency:'USD'}),generateVideo:async()=>assert.fail('Paid request must not be sent')};
  await assert.rejects(worker.submitVgenv({execute:async()=>assert.fail('No provider operation should be approved')},
    {id:'x',model:'minimax_h3',mode:'text-to-video',duration:30,resolution:'768p',aspect_ratio:'16:9',prompt:'A scene',provider_cost:0.1,provider_cost_unit:'usd'},0),/price changed/);
});

test('a timed-out long creation stays eligible for same-key reconciliation',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw Object.assign(new Error('deadline'),{name:'TimeoutError'});});
  const client=new VgenvClient({apiKey:'test-key'});
  await assert.rejects(client.generateVideo({duration:30,aspectRatio:'16:9',prompt:'A landscape',idempotencyKey:'stable'}),{longVideoSubmissionUncertain:true});
});

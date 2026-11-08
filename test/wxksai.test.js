'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { WxksaiClient }=require('../src/provider/wxksai.js');
const { WxksaiQueue }=require('../src/wxksai_queue.js');
const { wxksaiMediaModels, SPECS, publicId, isWxksaiModel }=require('../src/wxksai_models.js');
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
test('WXKSAI queue is isolated and customer access SQL is scoped',()=>{
  const q=new WxksaiQueue();
  assert.equal(q.provider,'wxksai');
  assert.equal(q.apiKey({wxksaiApiKey:'test'}),'test');
  assert.equal(q.sourceEnabled({wxksaiEnabled:false}),false);
  assert.match(q.queuedSql(),/provider='wxksai'/);
  assert.match(q.queuedSql(),/COALESCE\(a.enabled,1\)/);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Api888Client}=require('../src/provider/api888.js');
const {api888MediaModels,quoteApi888,seedance25LiveRate}=require('../src/api888_models.js');
const {serializeProviderModel}=require('../src/provider_models.js');
const {cnyToCredits}=require('../src/billing.js');
const id='seedance2.5-480p-plus';
const checked='2026-11-06T10:00:00.000Z';
const row=(name=id,rate=0.5)=>({model_name:name,quota_type:1,model_price:rate,
  enable_groups:['default'],billing_mode:'tiered_expr',billing_expr:`tier("base",(u("seconds") * ${rate}))`});
const prices=(rows=[row()])=>({success:true,group_ratio:{default:1},data:rows});
const discover=(pricing=prices(),ids=[id])=>api888MediaModels({data:ids.map(id=>({id})),pricing,pricingCheckedAt:checked});
function savedRow(record){return {id:1,provider:'api888',provider_model_id:record.providerModelId,
  public_model_id:record.publicModelId,label:record.label,media_type:record.mediaType,enabled:1,available:1,
  options_json:JSON.stringify(record.options)};}
function stored(record){return serializeProviderModel(savedRow(record),{includeInternal:true});}
async function studioView(record){
  const db=require('../src/db.js'),original=db.getPool;
  db.getPool=()=>({query:async()=>[[savedRow(record)]]});
  delete require.cache[require.resolve('../src/provider_models.js')];
  try{return (await require('../src/provider_models.js').publicProviderCatalog('api888')).video[0];}
  finally{db.getPool=original;delete require.cache[require.resolve('../src/provider_models.js')];}
}

test('live rate drives saved quotes, Studio rate labels and string-seconds request bodies',async()=>{
  for(const [name,rate,resolution] of [[id,0.5,'480p'],['seedance2.5-720p-plus',0.75,'720p'],
    ['seedance2.5-1080p-plus',0.9,'1080p'],['seedance2.5-480p-pro',0.5,'480p'],['seedance2.5-720p-pro',0.75,'720p']]){
    const record=discover(prices([row(name,rate)]),[name])[0],m=stored(record);
    assert.equal(m.ready,true,name);assert.equal(m.api888.sourceCny,rate);
    assert.equal(m.api888.priceCheckedAt,checked);assert.equal(m.api888.priceSource,'888api-public-default');
    for(const duration of [4,10,15]){
      const quote=quoteApi888(m,{duration,resolution});
      assert.equal(quote.sourceCny,rate*duration);assert.equal(quote.cost,cnyToCredits(rate*duration));
      assert.equal(quote.pricingMode,'per_second');
      const body=new Api888Client().videoBody(m,{prompt:'A river',duration,resolution,aspectRatio:'16:9'});
      assert.equal(body.seconds,String(duration));assert.equal(body.model,name);
      assert.equal(body.duration,undefined);
    }
    const view=await studioView(record);
    assert.equal(view.billingMode,'per_second');assert.equal(view.billingRateCredits,cnyToCredits(rate));
    assert.equal(view.dynamicCost,true);
  }
});

test('rate refresh updates existing models while retaining enabled/available flags and exact account IDs',()=>{
  const a=stored(discover(prices([row(id,0.6)]))[0]);
  const b=stored(discover(prices([row(id,0.4),row('seedance2.5-1080p-plus',0.9)]))[0]);
  assert.equal(quoteApi888(a,{duration:10}).sourceCny,6);
  assert.equal(quoteApi888(b,{duration:10}).sourceCny,4);
  assert.equal(a.enabled,b.enabled);assert.equal(a.available,b.available);
  const disabled=serializeProviderModel({...savedRow(discover()[0]),enabled:0,available:0});
  assert.equal(disabled.enabled,false);assert.equal(disabled.available,false);
  assert.equal(discover(prices([row(),row('seedance2.5-1080p-plus',0.9)])).length,1);
});

test('missing, duplicated, mismatched and unsupported live expressions cannot fall back to an old rate',()=>{
  const bad=[prices([]),prices([row(),row()]),prices([{...row(),model_price:0.9}]),
    prices([{...row(),model_price:0}]),prices([{...row(),billing_mode:'per_request'}]),
    prices([{...row(),billing_expr:'tier("base",5)'}]),prices([{...row(),billing_expr:'globalThis.compromised=true'}]),
    prices([{...row(),enable_groups:['vip']}]),prices([{...row(),enable_groups:'default'}]),{...prices(),group_ratio:{default:2}},
    prices([{...row(),billing_expr:'tier("base",(u("seconds") * 0))'}])];
  for(const pricing of bad){
    assert.equal(seedance25LiveRate(pricing,id),null);
    const m=stored(discover(pricing)[0]);
    assert.equal(m.api888.sourceCny,null);assert.equal(m.ready,false);assert.equal(m.adapterSupported,false);
    assert.throws(()=>quoteApi888(m,{duration:10}),/verified live Seedance/);
  }
});

test('fixed-price billing and unknown-model gates are unaffected by dynamic price imports',()=>{
  const models=discover(prices(),['seedance2.5-301010-max','unknown-seedance-video']);
  const flat=stored(models[0]);
  assert.equal(quoteApi888(flat,{duration:4}).sourceCny,7);
  assert.equal(quoteApi888(flat,{duration:30}).sourceCny,7);
  assert.equal(models[1].options.adapterSupported,false);
});

test('catalog reads token-visible availability and public pricing without sending credentials to pricing',async()=>{
  const seen=[];
  const client=new Api888Client({apiKey:'sk-secret-test',fetchImpl:async(url,options)=>{
    seen.push({url,options});
    if(url.endsWith('/v1/models')){assert.equal(options.headers.authorization,'Bearer sk-secret-test');return Response.json({data:[{id}]});}
    assert.equal(url,'https://888api.xin/api/pricing');assert.equal(options.method,'GET');
    assert.equal(options.headers.authorization,undefined);assert.equal(options.redirect,'error');
    return Response.json(prices());
  }});
  const catalog=await client.catalog();
  assert.equal(catalog.data.length,1);assert.equal(discover(catalog.pricing)[0].options.api888.sourceCny,0.5);
  assert.equal(seen.length,2);assert.ok(Number.isFinite(Date.parse(catalog.pricingCheckedAt)));
});

test('pricing outages and malformed payloads abort before catalog can be passed to database sync',async()=>{
  for(const response of [new Response('private upstream data',{status:503}),Response.json({success:false,data:[row()]}),
    Response.json({success:true,data:[]}),new Response('not json'),new Response('x'.repeat(4*1024*1024+1))]){
    const client=new Api888Client({apiKey:'sk-private',fetchImpl:async url=>url.endsWith('/v1/models')?Response.json({data:[{id}]}):response});
    await assert.rejects(client.catalog(),error=>{
      assert.match(error.message,/Existing models were preserved/);assert.doesNotMatch(error.message,/sk-private|private upstream data/);return true;
    });
  }
});

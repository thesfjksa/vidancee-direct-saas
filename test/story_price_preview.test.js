'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {previewTierQuotes}=require('../src/story_tiers');
const {createStoryStudio}=require('../src/story_studio');
test('unconfigured or unimported services still have numeric previews matching normal generation prices',async()=>{
 const {getCost}=require('../src/pricing'),{api888MediaModels,quoteApi888}=require('../src/api888_models');
 const {applyPriceRate,sourceToCustomerCredits,priceRate}=require('../src/billing');
 const descriptor=api888MediaModels().find(m=>m.publicModelId==='api888_gpt_image_2_1k');
 for(const accountRate of [1,1.5]){
  const rate=priceRate({price_rate:accountRate});
  const tiers=await previewTierQuotes({getRate:async()=>rate,getImageModel:async()=>null});
  const video=applyPriceRate(getCost('minimax_h3_cinematic',15,'768p'),rate);
  const image=applyPriceRate(quoteApi888({...descriptor.options,mediaType:'image',providerModelId:descriptor.providerModelId},{aspectRatio:'1:1'}).cost,rate);
  const voice=applyPriceRate(sourceToCustomerCredits(500),rate);
  assert.deepEqual(tiers.map(t=>t.credits),[8,12,20].map(n=>Math.round((n*(video+voice)+3*image)*100)/100));
  assert.ok(tiers.every(t=>t.priceBasis==='reviewed-catalog-rate'));
 }
});
test('preview prefers the saved exact GPT rate and never substitutes an unknown image SKU',async()=>{
 const getRate=async()=>1.05;
 const normal=await previewTierQuotes({getRate});
 const saved=await previewTierQuotes({getRate,getImageModel:async()=>({provider:'api888',providerModelId:'gpt-image-2-1k',api888:{billing:'image',sourceCny:0.1}})});
 assert.ok(saved[0].credits>normal[0].credits);assert.ok(saved.every(t=>t.priceBasis==='saved-model-rate'));
 const mismatch=await previewTierQuotes({getRate,getImageModel:async()=>({provider:'api888',providerModelId:'gpt-image-other',api888:{billing:'image',sourceCny:9}})});
 assert.equal(mismatch[0].credits,normal[0].credits);
 const unreadable=await previewTierQuotes({getRate,getImageModel:async()=>{throw Error('Catalog read unavailable');}});assert.equal(unreadable[0].credits,normal[0].credits);
 await assert.rejects(previewTierQuotes({getRate,imageModel:'api888_unknown_gpt'}),/no reviewed price/);
 await assert.rejects(previewTierQuotes({getRate:async()=>NaN}),/Account pricing/);
});
test('disabled Story Studio config returns tier credits while creation stays blocked',async()=>{
 const old=process.env.STORY_STUDIO_ENABLED;process.env.STORY_STUDIO_ENABLED='false';let body,submitted=0;
 try{
  const d={requireUser:async()=>({id:5}),settings:async()=>({}),access:async()=>({}),tierQuotes:()=>previewTierQuotes({getRate:async()=>1.05}),json:(r,status,b)=>{assert.equal(status,200);body=b;},readJson:async()=>{submitted++;return {};}};
  const studio=createStoryStudio(d);await studio.handle({method:'GET',headers:{}},{},null,'/api/stories/config');
  assert.equal(body.ready,false);assert.equal(body.tiers.length,3);assert.ok(body.tiers.every(t=>t.credits>0));assert.match(body.error,/configured/);
  await assert.rejects(studio.handle({method:'POST',headers:{'x-cmm-story':'1'}},{},null,'/api/stories'),e=>e.statusCode===503);assert.equal(submitted,0);
 }finally{if(old===undefined)delete process.env.STORY_STUDIO_ENABLED;else process.env.STORY_STUDIO_ENABLED=old;}
});
test('page shows returned credit consumption even when readiness is false',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const html=fs.readFileSync(path.join(__dirname,'../public/story.html'),'utf8');
 const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,addEventListener:()=>{}});return nodes.get(id);};
 const tiers=await previewTierQuotes({getRate:async()=>1.05});
 const context={document:{getElementById:node},setInterval:()=>{},fetch:async url=>{assert.equal(url,'/api/stories/config');return {ok:true,json:async()=>({ok:true,ready:false,tiers,error:'English voice needs setup.'})};}};
 vm.runInNewContext(script,context);await new Promise(setImmediate);
 for(const t of tiers)assert.equal(node('price_'+t.id).textContent,t.credits.toLocaleString(undefined,{maximumFractionDigits:2})+' credits · estimated');
 assert.equal(node('create').disabled,true);assert.match(node('message').textContent,/English voice needs setup/);
});

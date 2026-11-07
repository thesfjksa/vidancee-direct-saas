'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {aividBaseCredits,aividSourceUsd}=require('../src/aivid_pricing.js');
const {quoteAivid}=require('../src/aivid_models.js');
const {AividRdpClient}=require('../src/aivid_rdp.js');
const {applyPriceRate,priceRate}=require('../src/billing.js');

test('AIVID quote uses current Public source credits at $0.12, never the old Admin 480 factor',async()=>{
  const original=AividRdpClient.prototype.preflight;
  let requested;
  AividRdpClient.prototype.preflight=async function(data){requested=data;return {price:2,ready:true,submitted:false,
    modelId:data.model,duration:data.duration,resolution:data.resolution,aspectRatio:data.aspectRatio}};
  const db={getConnection:async()=>({query:async sql=>[[{acquired:1}]],release(){}})};
  const config={mode:'rdp',enabled:true,maxSourceCredits:10,customerCreditsPerSourceCredit:480,store:{},
    rdpDevice:{deviceId:'test',tokenHash:'hash',seenAt:new Date().toISOString(),status:'ready'}};
  try{
    const result=await quoteAivid(config,{model:'aivid_seedance_2_0_mini',duration:5,aspectRatio:'16:9',resolution:'480p'},{db});
    assert.equal(requested.model,'aivid_seedance_2_0_mini');
    assert.equal(result.sourceCredits,2);
    assert.equal(result.sourceUsd,0.24);
    assert.equal(result.cost,1612.8);
    assert.equal(applyPriceRate(result.cost,priceRate(null)),1693.44);
    const boosted=priceRate({price_rate:60000/42000});
    assert.equal(applyPriceRate(result.cost,boosted),2419.2);
    assert.equal(aividBaseCredits(2),result.cost);
    assert.equal(aividSourceUsd(2),result.sourceUsd);
    await assert.rejects(quoteAivid({...config,maxSourceCredits:1},{model:'aivid_seedance_2_0_mini',duration:5,aspectRatio:'16:9',resolution:'480p'},{db}),/exceeds/);
    AividRdpClient.prototype.preflight=async()=>({ready:true,submitted:false,price:2,balance:50});
    await assert.rejects(quoteAivid(config,{model:'aivid_seedance_2_5',duration:5,resolution:'480p'},{db}),/did not verify/);
  }finally{AividRdpClient.prototype.preflight=original}
});


test('Premium previews share one verified price per source and setting while submissions check again', async t => {
  let now=Date.now(),calls=0;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(AividRdpClient.prototype,'preflight',async value=>({
    price:++calls,ready:true,submitted:false,modelId:value.model,duration:value.duration,
    resolution:value.resolution,aspectRatio:value.aspectRatio
  }));
  const db={getConnection:async()=>({query:async()=>[[{acquired:1}]],release(){}})};
  const config={mode:'rdp',enabled:true,maxSourceCredits:20,store:{},
    rdpDevice:{deviceId:'preview-fixture',tokenHash:'hash',seenAt:new Date(now).toISOString(),status:'ready'}};
  const body={model:'aivid_seedance_2_0_mini',duration:15,resolution:'480p',aspectRatio:'16:9'};
  const read=(settings=body,connection=config)=>quoteAivid(connection,settings,{db,preview:true});
  const [first,concurrent]=await Promise.all([read(),read({...body,prompt:'edited',previewHasReferences:true})]);
  assert.equal(first.sourceCredits,1);assert.equal(concurrent.sourceCredits,1);
  assert.equal(concurrent.isEstimate,true);assert.equal(calls,1);
  await assert.rejects(read(body,{...config,enabled:false}),/connected AIVID agent/);
  assert.equal((await read({...body,aspectRatio:'9:16'})).sourceCredits,2);
  assert.equal((await read(body,{...config,rdpDevice:{...config.rdpDevice,deviceId:'new-agent'}})).sourceCredits,3);
  now+=61_000;
  config.rdpDevice.seenAt=new Date(now).toISOString();
  assert.equal((await read()).sourceCredits,4);
  assert.equal((await quoteAivid(config,body,{db})).sourceCredits,5);
  assert.equal((await read()).sourceCredits,5);
  assert.equal(calls,5);
});

test('duration verification avoids stepping from the minimum for near-maximum quotes', async () => {
  const {setAividDuration}=require('../src/provider/aivid.js');
  const pressed=[];
  let value=4;
  const slider={
    count:async()=>1,
    evaluate:async()=>({min:4,max:30,step:1,value,labels:[value],ariaNow:null,ariaText:null}),
    inputValue:async()=>String(value),
    press:async key=>{pressed.push(key);value=key==='End'?30:value-1;},
  };
  await setAividDuration(slider,29);
  await setAividDuration(slider,29);
  assert.deepEqual(pressed,['End','ArrowLeft']);
  slider.evaluate=async()=>({min:4,max:30,step:1,value,labels:[4],ariaNow:null,ariaText:null});
  await assert.rejects(setAividDuration(slider,30),/duration display/);
});

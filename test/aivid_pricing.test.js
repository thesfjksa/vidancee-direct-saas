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
  AividRdpClient.prototype.preflight=async function(data){requested=data;return {price:2,ready:true,submitted:false}};
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
  }finally{AividRdpClient.prototype.preflight=original}
});

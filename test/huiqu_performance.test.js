'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHuiquPerformance}=require('../src/huiqu_performance');
const {publicId}=require('../src/huiqu_models');
test('public performance maps exact model IDs, preserves missing latency and genuine failures, caches and marks stale',async()=>{
 let calls=0,time=1000,fail=false;
 const get=createHuiquPerformance({now:()=>time,fetchImpl:async(url,opts)=>{
   calls++;assert.equal(url,'https://api.bjhuiqu.net/api/perf-metrics/summary?hours=24');assert.equal(opts.headers.authorization,undefined);
   if(fail)throw Error('network');
   return Response.json({success:true,data:{models:[
    {model_name:'sd2-pro-max',success_rate:100,avg_latency_ms:2142150},
    {model_name:'sd2-900-15s',success_rate:0,avg_latency_ms:null},
    {model_name:'unrelated',success_rate:100,avg_latency_ms:1}
   ]}});
 }});
 const [a,b]=await Promise.all([get(),get()]);assert.equal(calls,1);assert.deepEqual(a,b);
 assert.deepEqual(a.models[publicId('sd2-pro-max')],{successRate:100,averageLatencyMs:2142150,source:'provider'});
 assert.equal(a.models[publicId('sd2-900-15s')].averageLatencyMs,null);assert.equal(a.models[publicId('sd2-900-15s')].successRate,0);
 assert.equal(Object.keys(a.models).length,2);await get();assert.equal(calls,1);
 time+=600000;fail=true;const c=await get();assert.equal(c.stale,true);assert.deepEqual(c.models,a.models);
});

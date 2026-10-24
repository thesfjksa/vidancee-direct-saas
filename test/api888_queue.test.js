'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Api888Queue}=require('../src/api888_queue.js');

const job={id:'c2ebddd1-ab9b-4d25-805e-3f8d2c9c9627',
  provider_operation:JSON.stringify({requestId:'task_12345678'})};

test('permanently inaccessible completed 888API media becomes failed/refunded, never left processing',async()=>{
 let refunds=0,completes=0;
 const events=[];
 const queue=new Api888Queue({refund:async(id,status,message)=>{
   refunds++;assert.equal(id,job.id);assert.equal(status,'failed');
   assert.match(message,/Credits were refunded/);
 }});
 queue.log=(_job,event,message,details)=>events.push({event,message,details});
 queue.complete=async()=>{completes++;};
 const client={
   videoStatus:async id=>{assert.equal(id,'task_12345678');return {status:'done',url:'http://10.0.0.2:19876/output.mp4'};},
   videoContent:async()=>{throw Object.assign(new Error('Safe download unavailable.'),{
     unretrievableOutput:true,providerOutputProblem:'unsafe_upstream_media_url',recoveryStage:'video.download',
   });},
 };
 await queue.pollJob({},client,job);
 assert.equal(refunds,1);
 assert.equal(completes,0);
 assert.equal(events.length,1);
 assert.equal(events[0].event,'job.video_output_unavailable');
});

test('temporary 888API media download failures remain retryable without refund',async()=>{
 let refunds=0;
 const queue=new Api888Queue({refund:async()=>{refunds++;}});
 queue.log=()=>{};
 const client={videoStatus:async()=>({status:'done'}),
   videoContent:async()=>{throw new Error('Provider temporary 503');}};
 await assert.rejects(queue.pollJob({},client,job),/temporary 503/);
 assert.equal(refunds,0);
});

test('pending 888API video stays processing and no refund occurs',async()=>{
 let refunds=0,marked=0;
 const queue=new Api888Queue({refund:async()=>{refunds++;}});
 queue.markProcessing=async()=>{marked++;};
 await queue.pollJob({}, {videoStatus:async()=>({status:'pending'})},job);
 assert.equal(marked,1);assert.equal(refunds,0);
});

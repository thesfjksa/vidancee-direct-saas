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

test('failed 888API video keeps the provider reason in Activity and gives customers a plain message',async()=>{
 const refunds=[],events=[];
 const queue=new Api888Queue({refund:async(id,status,message)=>{refunds.push({id,status,message});}});
 queue.log=(_job,event,message,details,level)=>events.push({event,message,details,level});
 await queue.pollJob({}, {videoStatus:async()=>({status:'failed',error:'Content moderation rejected the input image',providerStatus:'failure',progress:40})},job);
 assert.equal(refunds.length,1);
 assert.equal(refunds[0].message,'The safety filter blocked this video. Please change your prompt or images and try again. Credits were refunded.');
 assert.equal(events[0].event,'job.provider_failed');assert.equal(events[0].level,'error');
 assert.equal(events[0].details.reason,'Content moderation rejected the input image');
 // Customers get this through sendJson's hideVendorsInBody: no provider name, even in the reason.
 assert.doesNotMatch(require('../src/vendor_names.js').hideVendors(refunds[0].message.replace('Content','888API content')),/888/);

 refunds.length=0;events.length=0;
 await queue.pollJob({}, {videoStatus:async()=>({status:'failed',error:'888API reported generation failure.'})},job);
 assert.equal(refunds[0].message,'The video could not be completed. Credits were refunded.');
 assert.equal(events[0].details.reason,null);

 // 888API's Chinese safety message (27 Oct 2026, Wan 3.0 text-to-video).
 refunds.length=0;events.length=0;
 await queue.pollJob({}, {videoStatus:async()=>({status:'failed',error:'输入图片触发安全策略，请更换图片后重试'})},job);
 assert.equal(refunds[0].message,'The safety filter blocked this video. Please change your prompt or images and try again. Credits were refunded.');
 assert.equal(events[0].details.reason,'输入图片触发安全策略，请更换图片后重试');

 refunds.length=0;
 await queue.pollJob({}, {videoStatus:async()=>({status:'failed',error:'未知错误'})},job);
 assert.equal(refunds[0].message,'Model under maintenance. Please choose another model. Credits were refunded.');
});

test('a finished 888API video whose download fails is retried for 24 hours, not refunded at 3',async()=>{
 const updates=[];
 const queue=new Api888Queue({refund:async()=>assert.fail('no refund')});
 const db={execute:async(sql,params)=>{updates.push(params);return [{}];}};
 const failing={videoStatus:async()=>({status:'completed',url:'https://cdn.example/v.mp4'}),
  videoContent:async()=>{throw new Error('888API completed video could not be downloaded using either available GET route.');}};
 const pending={...job,provider_operation:JSON.stringify({requestId:'task_abc123'})};
 await assert.rejects(queue.pollJob(db,failing,pending),/could not be downloaded/);
 const saved=JSON.parse(updates[0][0]);
 assert.equal(saved.requestId,'task_abc123');assert.ok(saved.outputReadyAt);
 assert.equal(queue.timeoutFor(pending),3*60*60*1000);
 assert.equal(queue.timeoutFor({provider_operation:updates[0][0]}),24*60*60*1000);
});

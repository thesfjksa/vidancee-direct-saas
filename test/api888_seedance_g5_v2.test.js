'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
// These tests cover the video/audio transport kept for when 888API's
// gateway forwards media references again.
require('../src/api888_models.js').setApi888MediaRefs(true);
const {api888MediaModels,VIDEO_IDS,quoteApi888}=require('../src/api888_models.js');
const {Api888Client}=require('../src/provider/api888.js');

const id='seedance-2.5-g5-v2';
function record() {
 const [row]=api888MediaModels({data:[{id,type:'video'}]});
 assert.equal(row?.providerModelId,id);
 return row;
}
function model() {
 const row=record();
 return {...row.options,providerModelId:id,mediaType:'video',provider:'api888'};
}
const source=(kind,n=0)=>({
 mimeType:{image:'image/png',video:'video/mp4',audio:'audio/mpeg'}[kind],
 url:'https://example.org/test-'+kind+'-'+n
});

test('Seedance 2.5 G5-V2 is a cataloged video model with exact CNY per-job price',()=>{
 const row=record(),m=model();
 assert.ok(VIDEO_IDS.includes(id));
 assert.equal(row.mediaType,'video');
 assert.equal(m.adapterSupported,true);
 assert.equal(m.api888.unit,'CNY');
 assert.equal(m.api888.billing,'job');
 assert.equal(m.api888.sourceCny,7);
 assert.equal(m.api888.secondsField,'duration');
 assert.deepEqual(m.durations,Array.from({length:26},(_,i)=>i+5));
 assert.deepEqual(m.resolutions,['720p']);
 assert.deepEqual(m.aspectRatios,['16:9','9:16','1:1']);
 for(const duration of [5,8,15,30]){
   const q=quoteApi888(m,{duration,aspectRatio:'16:9',resolution:'720p'});
   assert.equal(q.sourceCny,7);
   assert.equal(q.sourceCny,7);
   assert.equal(q.pricingMode,'per_request');
 }
});

test('G5-V2 reference capabilities include all three media types',()=>{
 const caps=model().referenceCapabilities;
 assert.deepEqual([caps.image.max,caps.video.max,caps.audio.max],[30,10,10]);
 assert.equal(caps.totalMax,50);
 assert.equal(caps.image.supported,true);
 assert.equal(caps.video.supported,true);
 assert.equal(caps.audio.supported,true);
 assert.deepEqual(model().supportedOperations,['text-to-video','reference-to-video']);
});

test('G5-V2 formats image/video/audio arrays in a video task without making a paid request',()=>{
 const client=new Api888Client({apiKey:'dummy-not-used'});
 const files=[source('image'),source('video'),source('audio')];
 const body=client.videoBody(model(),{prompt:'Cinematic movement',duration:10,resolution:'720p',aspectRatio:'9:16'},files);
 assert.deepEqual(body,{
  model:id,prompt:'Cinematic movement',duration:10,resolution:'720p',ratio:'9:16',
  images:[files[0].url],videos:[files[1].url],audios:[files[2].url]
 });
 assert.equal(Object.hasOwn(body,'seconds'),false);
});

test('G5-V2 refuses excess inputs and invalid ratio before any paid submission',()=>{
 const client=new Api888Client({apiKey:'dummy-not-used'});
 const options={duration:10,prompt:'X',aspectRatio:'16:9'};
 for(const [kind,count,max] of [['image',31,30],['video',11,10],['audio',11,10]]){
  assert.throws(()=>client.videoBody(model(),options,
    Array.from({length:count},(_,i)=>source(kind,i))),new RegExp('at most '+max+' '+kind));
 }
 assert.throws(()=>client.videoBody(model(),{...options,aspectRatio:'4:3'},[]),/Unsupported aspect ratio/);
});

test('G5-V2 paid submission is never retried automatically after an ambiguous failure',async()=>{
 let calls=0;
 const client=new Api888Client({apiKey:'not-live',fetchImpl:async(url,opts)=>{
  calls++;
  assert.equal(url,'https://888api.xin/v1/videos');
  assert.equal(opts.method,'POST');
  throw new Error('simulated interrupted connection');
 }});
 await assert.rejects(client.startVideo(model(),{prompt:'Scene',duration:5,aspectRatio:'16:9'}),error=>{
  assert.equal(error.retryable,false);
  assert.equal(error.requestMethod,'POST');
  return true;
 });
 assert.equal(calls,1);
});

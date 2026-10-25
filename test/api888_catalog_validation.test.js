'use strict';
// Regression fixtures checked against 888API's published video-contract tables,
// https://888api.xin/docs and https://888api.xin/about (25 October 2026).
// These tests use no provider token and never submit a paid generation.
const test=require('node:test');
const assert=require('node:assert/strict');
const {api888MediaModels,quoteApi888}=require('../src/api888_models.js');
const {Api888Client}=require('../src/provider/api888.js');
const byId=(id)=>{
  const record=api888MediaModels({data:[{id} ]})[0];
  return {...record.options,providerModelId:record.providerModelId,mediaType:'video',provider:'api888'};
};
const reference=(type,n=0)=>({
  mimeType:type==='image'?'image/jpeg':type==='video'?'video/mp4':'audio/mpeg',
  url:'https://reference.example.test/'+type+n
});

test('priced Seedance 2.5 per-second SKUs use exact published rates and string seconds',()=>{
  const expected=[
    ['seedance2.5-480p-value',0.45,'480p'],
    ['seedance2.5-480p-plus',0.6,'480p'],
    ['seedance2.5-480p-pro',0.5,'480p'],
    ['seedance2.5-720p-plus',0.9,'720p'],
    ['seedance2.5-720p-pro',0.75,'720p'],
    ['seedance2.5-1080p-plus',1.25,'1080p'],
    ['seedance2.5-1080p-pro',1.25,'1080p'],
  ];
  const client=new Api888Client({apiKey:'not-used'});
  for(const [id,rate,resolution] of expected){
    const model=byId(id);
    assert.equal(model.adapterSupported,true,id);
    assert.equal(model.api888.billing,'second',id);
    assert.equal(model.api888.sourceCny,rate,id);
    assert.equal(model.defaultResolution,resolution,id);
    assert.deepEqual(model.durations,[...Array(12)].map((_,i)=>i+4),id);
    assert.equal(model.referenceCapabilities.totalMax,0,id);
    const result=quoteApi888(model,{duration:10,resolution,aspectRatio:'16:9'});
    assert.equal(result.cost,Math.round(rate*10*10000)/10000,id);
    const body=client.videoBody(model,{prompt:'Test',duration:10,resolution,aspectRatio:'16:9'});
    assert.equal(body.seconds,'10',id);
    assert.ok(!Object.hasOwn(body,'duration'),id);
    assert.ok(!Object.hasOwn(body,'images'),id);
  }
});

test('multimodal fixed job models enforce global reference count where published',()=>{
 const ids=['seedance2.0-933-economy','pidoi-h3video-2k','seedance2.0-933','xin-seedance-2.0-933'];
 const client=new Api888Client({apiKey:'not-used'});
 for(const id of ids){
   const model=byId(id);
   assert.equal(model.adapterSupported,true,id);
   assert.equal(model.referenceCapabilities.totalMax,12,id);
   const refs=[...Array.from({length:9},(_,i)=>reference('image',i)),
     ...Array.from({length:3},(_,i)=>reference('video',i)),
     ...Array.from({length:1},(_,i)=>reference('audio',i))];
   assert.throws(()=>client.videoBody(model,{prompt:'Scene',duration:model.defaultDuration},refs),
     /Too many reference files/,id);
   const body=client.videoBody(model,{prompt:'Scene',duration:model.defaultDuration},refs.slice(0,12));
   assert.equal(body.images.length,9,id);
   assert.equal(body.videos.length,3,id);
 }
});

test('SS 2.0 fixed-price models expose valid published presets and referenceImages field',()=>{
 const c=new Api888Client({apiKey:'not-used'});
 for(const id of ['seedance2.0-ss','seedance2.0-ss-fast']){
   const m=byId(id);
   assert.equal(m.adapterSupported,true,id);
   assert.deepEqual(m.durations,[6,8,10,12,15],id);
   assert.deepEqual(m.resolutions,['480p','720p'],id);
   assert.ok(m.aspectRatios.includes('2:3'),id);
   assert.ok(m.aspectRatios.includes('3:2'),id);
   const body=c.videoBody(m,{prompt:'Scene',duration:8,resolution:'480p',aspectRatio:'2:3'},
     [reference('image')]);
   assert.deepEqual(body.referenceImages,[reference('image').url],id);
   assert.equal(body.duration,8,id);
   assert.ok(!Object.hasOwn(body,'images'),id);
 }
});

test('Seedance 2.5 standard variants offer 30 seconds at flat published price',()=>{
 const prices={'ss-2.5-720p-v1':3.9,'s2-2.5-480p-v2':5,
   's2-2.5-720p-v3':8,'s2-2.5-720p-v4':7};
 for(const [id,price] of Object.entries(prices)){
   const m=byId(id);
   assert.equal(m.adapterSupported,true,id);
   assert.ok(m.durations.includes(30),id);
   assert.equal(quoteApi888(m,{duration:30,resolution:m.defaultResolution}).cost,price,id);
   assert.equal(quoteApi888(m,{duration:5,resolution:m.defaultResolution}).cost,price,id);
 }
});

test('documented variant-specific duration and resolution limits remain constrained',()=>{
 const durationChecks=[
   ['seedance2.0-933-economy',[15]],
   ['pidoi-h3video-2k',[15]],
   ['seedance2.0-933',[10,15]],
   ['seedance2.0-pro-480p',[15]],
   ['seedance2.0-933-fast',[10,15]],
   ['pidoi-omni-flash-720p',[5,10]],
   ['pidoi-veo31-fast',[4,6,8]],
 ];
 for(const [id,durations] of durationChecks){
   const m=byId(id);
   assert.deepEqual(m.durations,durations,id);
 }
 assert.deepEqual(byId('pidoi-veo31-fast').resolutions,['720p','1080p']);
 assert.deepEqual(byId('seedance2.0-933-mini').resolutions,['480p','720p']);
});

test('unpriced or unknown upstream IDs are never silently allowed to spend credits',()=>{
 const unknown=byId('unknown-provider-888api-model');
 assert.equal(unknown.adapterSupported,false);
 assert.throws(()=>quoteApi888(unknown,{duration:5}),/(additional setup|No verified 888API price)/i);
});

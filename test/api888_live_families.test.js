'use strict';
// These tests cover the whole 888API catalog, not just the models offered.
require('../src/api888_models.js').setApi888OfferAll(true);
const test=require('node:test');
const assert=require('node:assert/strict');
// These tests cover the video/audio transport kept for when 888API's
// gateway forwards media references again.
require('../src/api888_models.js').setApi888MediaRefs(true);
const {api888MediaModels,quoteApi888,SORA_VARIANTS,GROK_VARIANTS}=require('../src/api888_models.js');
const {Api888Client}=require('../src/provider/api888.js');
function model(id,type='video'){
 const item=api888MediaModels({data:[{id,type}]})[0];
 return {...item.options,providerModelId:id,mediaType:type,provider:'api888',ready:true};
}
const client=new Api888Client({apiKey:'unused-in-mock'});
const im={mimeType:'image/jpeg',url:'https://example.org/photo.jpg'};
const vi={mimeType:'video/mp4',url:'https://example.org/ref.mp4'};
const au={mimeType:'audio/mpeg',url:'https://example.org/music.mp3'};

test('all twelve published fixed-price Sora variants are priced and locked to their model IDs',()=>{
 assert.equal(SORA_VARIANTS.length,12);
 for(const id of SORA_VARIANTS){
  const m=model(id);
  assert.equal(m.adapterSupported,true,id);
  const seconds=Number(id.match(/-(\d+)s-/)[1]);
  const ratio=id.endsWith('16x9')?'16:9':'9:16';
  assert.deepEqual(m.durations,[seconds],id);
  assert.deepEqual(m.aspectRatios,[ratio],id);
  assert.equal(quoteApi888(m,{duration:seconds,aspectRatio:ratio}).sourceCny,0.6,id);
  const body=client.videoBody(m,{prompt:'Cinema',duration:seconds,aspectRatio:ratio,resolution:'720p'});
  assert.deepEqual(body,{model:id,prompt:'Cinema'},id);
  assert.throws(()=>client.videoBody(m,{prompt:'X',duration:seconds+1,aspectRatio:ratio}),/fixed by the model ID/i,id);
 }
});
test('Sora 2 uses nested input_reference for exactly one image',()=>{
 const m=model('sora2-pro-12s-9x16');
 const body=client.videoBody(m,{duration:12,aspectRatio:'9:16',prompt:'Move'},[im]);
 assert.deepEqual(body.input_reference,{type:'input_image',image_url:{url:im.url}});
 assert.throws(()=>client.videoBody(m,{duration:12,aspectRatio:'9:16',prompt:'Move'},[im,im]),/at most 1 image/);
});
test('five documented Grok models bill per request and send string seconds, image_url and pixel size',()=>{
 assert.equal(GROK_VARIANTS.length,5);
 for(const id of GROK_VARIANTS){
  const m=model(id);
  assert.equal(m.adapterSupported,true,id);
  assert.equal(quoteApi888(m,{duration:m.defaultDuration}).sourceCny,0.2,id);
  const refs=id==='grok-imagine-video-1.5-preview'?[im]:[];
  const b=client.videoBody(m,{duration:m.defaultDuration,aspectRatio:'9:16',prompt:'Grok'},refs);
  assert.deepEqual(b,{model:id,prompt:'Grok',seconds:String(m.defaultDuration),size:'720x1280',
    ...(refs.length?{image_url:im.url}:{})},id);
  assert.equal(Object.hasOwn(b,'ratio'),false,id);
  assert.equal(Object.hasOwn(b,'resolution'),false,id);
 }
 const preview=model('grok-imagine-video-1.5-preview');
 assert.throws(()=>client.videoBody(preview,{duration:5,aspectRatio:'16:9',prompt:'Grok'},[]),
   /requires at least 1 reference image/);
});
test('documented OpenAI and Gemini models support paid text-to-image at published CNY prices',()=>{
 for(const [id,price] of [['gpt-image-2',0.05],['gpt-image-2pro',0.075],
  ['gemini-3-pro-image-preview',0.12],['gemini-3-pro-image-preview-c',0.075],
  ['gemini-3.1-flash-image-preview',0.1],['gemini-3.1-flash-image-preview-c',0.075],
  ['gpt-image-2-1k',0.04],['gpt-image-2.5-flare',0.05],['gpt-image-2.5-flare-4k',0.09]]){
  const m=model(id,'image');
  assert.equal(m.mediaType,'image');
  assert.equal(m.adapterSupported,true,id);
  assert.equal(quoteApi888(m,{}).sourceCny,price,id);
  assert.deepEqual(m.supportedOperations,['text-to-image'],id);
 }
});
test('Doubao video-reference model requires video_urls and retains per-second CNY cost',()=>{
 const m=model('doubao-seedance-2-0-fast');
 assert.equal(m.adapterSupported,true);
 assert.equal(quoteApi888(m,{duration:8}).sourceCny,4.88);
 assert.throws(()=>client.videoBody(m,{duration:8,prompt:'Reference'},[]),
   /requires at least 1 reference video/);
 const body=client.videoBody(m,{duration:8,prompt:'Reference'},[im,vi,au]);
 assert.deepEqual(body.image_urls,[im.url]);
 assert.deepEqual(body.video_urls,[vi.url]);
 assert.deepEqual(body.audio_urls,[au.url]);
 assert.equal(body.duration,8);
 assert.equal(body.seconds,undefined);
});
test('two Seedance four-image variants transport documented multimodal arrays',()=>{
 for(const [id,price] of [['seedance2.0-full-4img',4],['seedance2.0-fast-4img',3.5]]){
   const m=model(id);
   assert.equal(m.adapterSupported,true,id);
   assert.equal(quoteApi888(m,{duration:8}).sourceCny,price,id);
   const body=client.videoBody(m,{duration:8,prompt:'Reference scene'},[im,vi,au]);
   assert.deepEqual(body.referenceImages,[im.url],id);
   assert.deepEqual(body.referenceVideos,[vi.url],id);
   assert.deepEqual(body.referenceAudios,[au.url],id);
   assert.equal(body.duration,8,id);
 }
});
test('unknown and undocumented IDs remain unrunnable even when upstream lists them',()=>{
 for(const id of ['seedance-2.5-unknown-v3','sora2-unpublished','gpt-image-2-plus']){
  const m=model(id,id.includes('gpt-image')?'image':'video');
  assert.equal(m.adapterSupported,false,id);
 }
});

test('Jimeng fast-vip uses its required functionMode, numeric duration and image URLs',()=>{
 const id='jimeng-video-seedance-2.0-fast-vip',m=model(id);
 assert.equal(m.adapterSupported,true);
 assert.deepEqual(m.durations,[15]);
 assert.equal(m.api888.billing,'job');
 assert.equal(quoteApi888(m,{duration:15}).sourceCny,4.5);
 assert.equal(m.referenceCapabilities.image.max,2);
 const body=client.videoBody(m,{prompt:'Scene',duration:15,aspectRatio:'16:9'},[im]);
 assert.equal(body.functionMode,'first_last_frames');
 assert.equal(body.duration,15);
 assert.equal(Object.hasOwn(body,'seconds'),false);
 assert.deepEqual(body.referenceImages,[im.url]);
 assert.throws(()=>client.videoBody(m,{prompt:'Scene',duration:15},[im,im,im]),/at most 2 image/);
});

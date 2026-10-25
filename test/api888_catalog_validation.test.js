'use strict';
// These tests cover the whole 888API catalog, not just the models offered.
require('../src/api888_models.js').setApi888OfferAll(true);
// Regression fixtures checked against 888API's published video-contract tables,
// https://888api.xin/docs and https://888api.xin/about (25 October 2026).
// These tests use no provider token and never submit a paid generation.
const test=require('node:test');
const assert=require('node:assert/strict');
// These tests cover the video/audio transport kept for when 888API's
// gateway forwards media references again.
require('../src/api888_models.js').setApi888MediaRefs(true);
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
 const ids=['seedance2.0-933-economy','seedance2.0-933','xin-seedance-2.0-933'];
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
   // Documented videos field only for Xin 933; the others use video_urls.
   assert.equal((body.videos||body.video_urls).length,3,id);
   assert.equal(Boolean(body.video_urls),id!=='xin-seedance-2.0-933',id);
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

test('25 Oct catalog cards: corrected fixed prices and wool ratios',()=>{
  for(const [id,price,duration] of [['seedance2.5-301010-wool',7,10],['seedance2.0-933',5,10]]){
    const model=byId(id);
    assert.equal(model.api888.billing,'job',id);
    assert.equal(quoteApi888(model,{duration,resolution:model.defaultResolution,aspectRatio:'16:9'}).cost,price,id);
  }
  assert.deepEqual(byId('seedance2.5-301010-wool').aspectRatios,['16:9','9:16','1:1','4:3','3:4','21:9']);
});

test('docs-verified models enabled 25 Oct use documented fields, limits and prices',()=>{
  const client=new Api888Client({apiKey:'not-used'});
  const mini=byId('doubao-seedance-2.0-mini');
  assert.equal(mini.adapterSupported,true);
  assert.deepEqual(mini.durations,[5,10,15]);
  assert.equal(quoteApi888(mini,{duration:10,resolution:'720p',aspectRatio:'16:9'}).cost,1.6);
  assert.equal(mini.referenceCapabilities.video.supported,false);
  assert.equal(mini.referenceCapabilities.audio.supported,false);
  assert.equal(client.videoBody(mini,{prompt:'P',duration:10,aspectRatio:'9:16'},[reference('image')]).duration,10);

  const ss=byId('ss-2.0-933-720p');
  assert.equal(ss.adapterSupported,true);
  assert.equal(quoteApi888(ss,{duration:8,resolution:'720p',aspectRatio:'16:9'}).cost,1.5);
  const ssBody=client.videoBody(ss,{prompt:'P',duration:8,aspectRatio:'1:1'},[reference('image'),reference('video'),reference('audio')]);
  assert.deepEqual([ssBody.images.length,ssBody.videos.length,ssBody.audios.length],[1,1,1]);

  for(const [id,price,res] of [['seedance2.5-301010-wool',7,'720p'],['seedance2.5-301010-wool-1080p',10,'1080p']]){
    const m=byId(id);
    assert.equal(m.adapterSupported,true,id);
    assert.equal(m.defaultResolution,res,id);
    assert.equal(quoteApi888(m,{duration:30,resolution:res,aspectRatio:'21:9'}).cost,price,id);
    assert.deepEqual([m.referenceCapabilities.image.max,m.referenceCapabilities.video.max,m.referenceCapabilities.audio.max],[30,10,10],id);
  }

  const special=byId('sd_2.0_mini_special');
  assert.equal(special.adapterSupported,true);
  assert.equal(quoteApi888(special,{duration:10,resolution:'720p',aspectRatio:'16:9'}).cost,1.5);
  const body=client.videoBody(special,{prompt:'P',duration:10,aspectRatio:'9:16'},[reference('image'),reference('video'),reference('audio')]);
  assert.equal(body.duration,10);
  assert.ok(!Object.hasOwn(body,'seconds'));
  assert.deepEqual([body.image_urls.length,body.video_urls.length,body.audio_urls.length],[1,1,1]);
  assert.throws(()=>client.videoBody(special,{prompt:'P',duration:10},[reference('audio')]),/image or video with reference audio/);
});

test('888API labels name resolution and reference limits; image models offer three ratios with documented sizes',async()=>{
  const {api888ImageSize,api888MediaModels:all}=require('../src/api888_models.js');
  const label=(id,type='video')=>all({data:[{id,type}]})[0].label;
  assert.equal(label('seedance-2.5-g5-v2'),'Seedance 2.5 G5 Realistic · 720p · 30 img + 10 video + 10 audio');
  assert.equal(label('minimax-h3-480p-t'),'MiniMax H3 · 480p · 1–9 img');
  assert.equal(label('seedance2.5-480p-plus'),'Seedance 2.5 Plus · 480p · Text only');
  assert.equal(label('pidoi-h3video-2k'),'MiniMax H3 Multi-Reference · 2K · 9 img + 3 video + 3 audio');
  assert.equal(label('gpt-image-2.5-flare-4k','image'),'GPT Image 2.5 Flare · 4K');
  assert.equal(label('gpt-image-2','image'),'GPT Image 2 · 2K');
  for(const id of ['gpt-image-2','gpt-image-2-1k','gpt-image-2-4k','gpt-image-2.5-flare','gemini-3-pro-image-preview']){
    const m=all({data:[{id,type:'image'}]})[0].options;
    assert.deepEqual(m.aspectRatios,['1:1','16:9','9:16'],id);
    for(const r of m.aspectRatios){
      const [w,h]=api888ImageSize(id,r).split('x').map(Number);
      assert.ok(w%16===0&&h%16===0,id+' '+r);
      const [rw,rh]=r.split(':').map(Number);
      assert.ok(Math.abs((w/h)/(rw/rh)-1)<0.01,id+' '+r);
    }
  }
  assert.equal(api888ImageSize('gpt-image-2-4k','16:9'),'3840x2160');
  assert.equal(api888ImageSize('gpt-image-2','9:16'),'1152x2048');
  assert.equal(api888ImageSize('gpt-image-2pro','16:9'),null);
  let sent=null;
  const client=new Api888Client({apiKey:'k',fetchImpl:async(url,init)=>{sent=JSON.parse(init.body);return new Response('{}',{status:500});}});
  const model={providerModelId:'gpt-image-2.5-flare-4k'};
  await assert.rejects(client.generateImage(model,{prompt:'P',aspectRatio:'9:16'}));
  assert.equal(sent.size,'2160x3840');
  await assert.rejects(client.generateImage(model,{prompt:'P',aspectRatio:'4:3'}),/Unsupported aspect ratio/);
});

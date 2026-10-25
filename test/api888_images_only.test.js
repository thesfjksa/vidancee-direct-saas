'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {api888MediaModels}=require('../src/api888_models.js');
const {Api888Client}=require('../src/provider/api888.js');

const model=id=>{const m=api888MediaModels({data:[{id}]})[0];return {...m.options,label:m.label,providerModelId:id,mediaType:'video'};};

test('888API models offer image references only while the gateway drops videos and audio',()=>{
  for(const id of ['seedance-2.5-g5-v2','wan30-720p','sd_2.0_mini_special','seedance2.5-301010-wool']){
    const m=model(id);
    assert.equal(m.referenceCapabilities.video.supported,false,id);
    assert.equal(m.referenceCapabilities.audio.supported,false,id);
    assert.ok(m.referenceCapabilities.image.max>0,id);
    assert.doesNotMatch(m.label,/video \+|audio/,id);
  }
  assert.equal(model('seedance-2.5-g5-v2').label,'Seedance 2.5 G5 Realistic · 720p · 30 img');
  const client=new Api888Client({apiKey:'k'});
  assert.throws(()=>client.videoBody(model('wan30-720p'),{prompt:'P',duration:4,aspectRatio:'16:9'},
    [{mimeType:'video/mp4',url:'https://x.example/v.mp4'}]),/at most 0 video/);
});

test('video-reference-only 888API models are unavailable while video references are dropped',()=>{
  assert.equal(model('doubao-seedance-2-0-fast').adapterSupported,false);
});

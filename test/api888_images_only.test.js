'use strict';
// These tests cover the whole 888API catalog, not just the models offered.
require('../src/api888_models.js').setApi888OfferAll(true);
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

test('888API MiniMax models are not offered: MiniMax H3 comes from vgenv',()=>{
  for(const id of ['minimax-h3-480p-t','minimax-h3-768p-t','pidoi-h3video-2k','minimax-h3']){
    const m=model(id);
    assert.equal(m.adapterSupported,false,id);
  }
  assert.match(model('minimax-h3-480p-t').setupReason,/vgenv/);
});

test('only the owner-chosen 888API models are offered, under their new names', () => {
  const m = require('../src/api888_models.js');
  m.setApi888OfferAll(false);
  try {
    const ids = ['seedance-2.5-g5-v2','seedance2.5-301010-wool','seedance2.0-933','wan3.0-video-prime','wan30-720p','sd_2.0_mini_special'];
    const models = m.api888MediaModels({ data: [...ids.map(id => ({ id, type: 'video' })), { id: 'gpt-image-2', type: 'image' }] });
    const offered = Object.fromEntries(models.filter(x => x.options.adapterSupported).map(x => [x.providerModelId, x.label]));
    assert.deepEqual(offered, { 'seedance-2.5-g5-v2': 'Seedance 2.5 Realism', 'seedance2.5-301010-wool': 'Seedance 2.5 Standard',
      'seedance2.0-933': 'Seedance 2.0 Standard', 'wan3.0-video-prime': 'Wan 3.0 Video Prime', 'wan30-720p': 'Wan 3.0 Standard',
      'sd_2.0_mini_special': 'Seedance 2.0 Mini' });
    assert.equal(models.find(x => x.providerModelId === 'gpt-image-2').options.setupReason, 'Not offered on CMM Tools.');
  } finally { m.setApi888OfferAll(true); }
});

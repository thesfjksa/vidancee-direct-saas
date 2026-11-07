'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
// These tests cover the video/audio transport kept for when 888API's
// gateway forwards media references again.
require('../src/api888_models.js').setApi888MediaRefs(true);
const fs=require('node:fs');
const path=require('node:path');
const {trimMp4,readBoxes}=require('../src/mp4_trim.js');
const {trimReferenceVideos,validateAividVideoReferences}=require('../src/reference_trim.js');
const {mp4Seconds}=require('../src/vercel_models.js');
const {api888MediaModels}=require('../src/api888_models.js');

const clip=fs.readFileSync(path.join(__dirname,'fixtures','reference-40s.mp4')); // H.264 (B-frames) + AAC, 40 s

function trackSummary(buf){
  const moov=readBoxes(buf).find(b=>b.type==='moov');
  return moov.children.filter(b=>b.type==='trak').map(trak=>{
    const stbl=['mdia','minf','stbl'].reduce((b,t)=>b.children.find(c=>c.type===t),trak);
    const stsz=stbl.children.find(c=>c.type==='stsz').data,stco=stbl.children.find(c=>c.type==='stco').data;
    const sizes=Array.from({length:stsz.readUInt32BE(8)},(_,i)=>stsz.readUInt32BE(12+i*4));
    const offsets=Array.from({length:stco.readUInt32BE(4)},(_,i)=>stco.readUInt32BE(8+i*4));
    return {sizes,offsets};
  });
}

test('a 40 s MP4 is cut losslessly to 30 s with valid sample offsets',()=>{
  assert.ok(Math.abs(mp4Seconds(clip)-40)<0.2);
  const out=trimMp4(clip,30);
  assert.equal(out.trimmed,true);
  assert.ok(Math.abs(out.seconds-30)<0.2,String(out.seconds));
  assert.ok(Math.abs(mp4Seconds(out.data)-30)<0.2);
  assert.ok(out.data.length<clip.length);
  // Every kept sample points inside the new mdat.
  const mdat=readBoxes(out.data).find(b=>b.type==='mdat');
  for(const t of trackSummary(out.data))t.offsets.forEach((o,i)=>{
    assert.ok(o>=mdat.start+8&&o+t.sizes[i]<=mdat.start+mdat.size);
  });
  assert.equal(trimMp4(clip,45).trimmed,false);
});

test('reference videos are trimmed to the model limit with a notice; short ones are untouched',()=>{
  const videos=[{filename:'long.mp4',data:clip}];
  const notices=trimReferenceVideos(videos,{totalSeconds:30});
  assert.equal(notices.length,1);
  assert.equal(notices[0].fromSeconds,40);
  assert.equal(notices[0].toSeconds,30);
  assert.ok(Math.abs(mp4Seconds(videos[0].data)-30)<0.2);
  const short=[{filename:'s.mp4',data:trimMp4(clip,10).data}];
  assert.deepEqual(trimReferenceVideos(short,{totalSeconds:30}),[]);
  // The total is shared in upload order.
  const two=[{filename:'a.mp4',data:clip},{filename:'b.mp4',data:clip}];
  assert.throws(()=>trimReferenceVideos(two,{totalSeconds:30}),/30 seconds long in total/);
  const perClip=[{filename:'a.mp4',data:clip},{filename:'b.mp4',data:clip}];
  assert.equal(trimReferenceVideos(perClip,{clipSeconds:15}).length,2);
});

test('888API reference-video limits: 15 s for Seedance 2.0, 30 s for Seedance 2.5 and Wan',()=>{
  const limit=id=>api888MediaModels({data:[{id}]})[0].options.referenceCapabilities.video.maxTotalSeconds;
  assert.equal(limit('seedance2.0-933'),15);
  assert.equal(limit('sd_2.0_mini_special'),15);
  assert.equal(limit('seedance-2.5-g5-v2'),30);
  assert.equal(limit('seedance2.5-301010-wool'),30);
  assert.equal(limit('wan30-720p'),30);
});

test('AIVID validates reference duration and dimensions and trims the verified total exactly',()=>{
  const {aividModel,aividReferenceVideoLimit}=require('../src/aivid_models.js');
  const {diagnosticReferences}=require('../src/aivid_probe_assets.js');
  const limit=aividReferenceVideoLimit(aividModel('aivid_seedance_2_0_mini'));
  const good=diagnosticReferences().find(ref=>ref.kind==='video');
  assert.doesNotThrow(()=>validateAividVideoReferences([good],limit));
  assert.throws(()=>validateAividVideoReferences([{data:clip}],limit),/unsupported dimensions/);
  assert.throws(()=>validateAividVideoReferences([{data:trimMp4(good.data,1).data}],limit),/at least 2 seconds/);
  assert.throws(()=>validateAividVideoReferences(Array(6).fill(good),limit),/15 seconds long in total/);
  const long=[{data:clip}];
  trimReferenceVideos(long,limit);
  assert.ok(mp4Seconds(long[0].data)<=15);
  assert.equal(aividReferenceVideoLimit(aividModel('aivid_seedance_2_5')).totalSeconds,30);
});

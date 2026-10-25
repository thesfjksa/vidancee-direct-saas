'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {healthSnapshot,isApi888Available,isApi888PublicAvailable,refreshApi888Health,loadApi888Health,healthSummary,SETTING_KEY}=require('../src/api888_health.js');

const body={data:[
  {id:'wan30-720p',health_status:'available'},
  {id:'wan3.0-video-prime',health_status:'no_recent_success'},
  {id:'seedance2.0-pro-480p',health_status:'verifying'},
  {id:'gpt-image-2',health_status:'disabled'},
  {id:'no-health-field'},
]};

test('only models 888API marks available are customer-visible',()=>{
  const snap=healthSnapshot(body,0);
  assert.deepEqual(snap.statuses,{'wan30-720p':'available','wan3.0-video-prime':'no_recent_success',
    'seedance2.0-pro-480p':'verifying','gpt-image-2':'disabled'});
  assert.equal(isApi888Available(snap,'wan30-720p'),true);
  for(const id of ['wan3.0-video-prime','seedance2.0-pro-480p','gpt-image-2','no-health-field','not-returned'])
    assert.equal(isApi888Available(snap,id),false,id);
  assert.equal(isApi888PublicAvailable(snap,'api888_wan30_720p'),true);
  assert.equal(isApi888PublicAvailable(snap,'api888_wan3_0_video_prime'),false);
  assert.deepEqual(healthSummary(snap).counts,{available:1,no_recent_success:1,verifying:1,disabled:1});
});

test('no snapshot or no health fields upstream fails open instead of emptying the catalog',()=>{
  assert.equal(isApi888Available(null,'x'),true);
  assert.equal(isApi888Available(healthSnapshot({data:[{id:'x'}]}),'x'),true);
  assert.equal(isApi888PublicAvailable(null,'api888_x'),true);
});

test('worker refresh saves the snapshot the web app later loads',async()=>{
  const store=new Map();
  await refreshApi888Health({client:{models:async()=>body},setValue:async(k,v)=>store.set(k,v),now:1});
  assert.ok(store.has(SETTING_KEY));
  const loaded=await loadApi888Health({getValue:async k=>store.get(k),now:10*60*1000});
  assert.equal(loaded.statuses['wan30-720p'],'available');
});

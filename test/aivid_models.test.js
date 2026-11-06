'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SPECS,isAividModel,aividModel,assertOptions,customerCatalog,capabilities}=require('../src/aivid_models.js');
const {validateJob,validateSubmission}=require('../src/provider/aivid.js');

test('Premium models have separate IDs, public labels and guarded limits',()=>{
  const ids=SPECS.map(s=>s.id);
  assert.equal(new Set(ids).size,3);
  assert.ok(ids.every(id=>id.startsWith('aivid_')&&isAividModel(id)));
  assert.equal(aividModel('seedance_2.5'),null);
  const catalog=customerCatalog({enabled:true,maxSourceCredits:30,mode:'rdp',rdpDevice:{
    deviceId:'safe-device',tokenHash:'1234',seenAt:new Date().toISOString(),status:'ready'}});
  assert.equal(catalog.length,3);
  assert.ok(catalog.every(m=>m.label.includes('Premium')&&m.dynamicCost===true));
  for(const m of catalog){
    assert.ok(m.capabilities.image.max>0);
    assert.ok(m.durations.length>=12);
  }
  const offline=customerCatalog({enabled:true,maxSourceCredits:30,mode:'rdp',
    rdpDevice:{deviceId:'safe-device',tokenHash:'1234',seenAt:'2000-01-01T00:00:00.000Z',status:'ready'}});
  assert.equal(offline.length,3);
  assert.ok(offline.every(m=>m.unavailable&&m.ready===false&&/offline/i.test(m.warning)));
  const disabled=customerCatalog({enabled:false,maxSourceCredits:30,mode:'rdp',
    rdpDevice:{deviceId:'safe-device',tokenHash:'1234',seenAt:'2000-01-01T00:00:00.000Z',status:'ready'}});
  assert.equal(disabled.length,3);
  assert.ok(disabled.every(m=>m.unavailable&&/disabled/i.test(m.warning)));
  const unconfigured=customerCatalog(null);
  assert.equal(unconfigured.length,0);
  assert.deepEqual(customerCatalog({enabled:false,maxSourceCredits:0,mode:'browserless',connectUrl:''}),[]);
  assert.equal(catalog.filter(m=>m.unavailable).length,0);
});
test('AIVID validates distinct backend model requests and refuses the wrong model',()=>{
  for(const spec of SPECS){
    const job=validateJob({model:spec.id,prompt:'A sunrise',duration:spec.maxSeconds,resolution:'720p',aspectRatio:'16:9'});
    const payload={model:spec.providerId,prompt:job.prompt,duration:job.duration,resolution:job.resolution,
      aspectRatio:job.aspectRatio,isPublic:true,references:[]};
    assert.doesNotThrow(()=>validateSubmission(payload,job));
    assert.throws(()=>validateSubmission({...payload,model:'seedance-2.0-mini'===spec.providerId?'seedance-2.5':'seedance-2.0-mini'},job));
    assert.throws(()=>validateSubmission({...payload,isPublic:false},job));
    assert.throws(()=>validateSubmission({...payload,visibility:'private'},job));
    assert.throws(()=>validateSubmission({...payload,visibility:'public',isPrivate:true},job));
  }
});
test('bad premium settings, durations and reference limits fail before submission',()=>{
  assert.throws(()=>assertOptions(aividModel('aivid_seedance_2_5'),{duration:31,resolution:'480p'}),/Unsupported/);
  assert.throws(()=>validateJob({model:'aivid_seedance_2_0',prompt:'ok',duration:16,resolution:'480p'}),/duration/);
  assert.throws(()=>validateJob({model:'aivid_seedance_2_5',prompt:'ok',duration:5,resolution:'4K'}),/resolution/);
  assert.equal(capabilities(SPECS[2]).image.max,30);
});

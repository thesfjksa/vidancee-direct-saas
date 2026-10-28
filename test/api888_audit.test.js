'use strict';
// These tests cover the whole 888API catalog, not just the models offered.
require('../src/api888_models.js').setApi888OfferAll(true);

const test=require('node:test');
const assert=require('node:assert/strict');
const {auditApi888Import}=require('../src/api888_audit.js');

function row(providerModelId,{type='video',available=true,enabled=true,supported=true,ready=true}={}){
  return {providerModelId,mediaType:type,available,enabled,adapterSupported:supported,ready,
    setupReason:ready?'':'Unverified upstream request contract.'};
}

test('read-only audit distinguishes imported history from current live access',()=>{
  const live={data:[
    {id:'wan30-720p'},
    {id:'gpt-image-2.5-1k',type:'image'},
    {id:'some-new-text-model',type:'text'},
  ]};
  const saved=[
    row('wan30-720p'),
    row('gpt-image-2.5-1k',{type:'image'}),
    row('old-video-model',{available:false}),
  ];
  const result=auditApi888Import(live,saved);
  assert.equal(result.ok,false);
  assert.equal(result.summary.upstreamReturned,3);
  assert.equal(result.summary.storedTotal,3);
  assert.equal(result.summary.previouslyImportedNotInLive,1);
  assert.deepEqual(result.stale,['old-video-model']);
  assert.deepEqual(result.missing,['some-new-text-model']);
  assert.equal(result.summary.enabledReadyForCustomerCatalog,2);
  assert.equal(result.summary.enabledReadyVideo,1);
  assert.equal(result.summary.enabledReadyImage,1);
  assert.equal(result.summary.upstreamKnownAdapterCount,2);
  assert.equal(result.details.find(x=>x.id==='some-new-text-model').adapterSupported,false);
});

test('audit passes when all live 888API model IDs are stored, typed, and marked available',()=>{
 const live={data:[{id:'wan3.0-image'},{id:'gpt-image-2.5-1k',type:'image'}]};
 const saved=[row('wan3.0-image'),row('gpt-image-2.5-1k',{type:'image'}),
   row('outdated-image',{type:'image',available:false})];
 const result=auditApi888Import(live,saved);
 assert.equal(result.ok,true);
 assert.equal(result.summary.upstreamReturned,2);
 assert.equal(result.summary.storedTotal,3);
 assert.equal(result.summary.previouslyImportedNotInLive,1);
 assert.equal(result.summary.enabledReadyForCustomerCatalog,2);
 assert.equal(result.summary.missingFromImport,0);
});

test('audit separates model toggles, incomplete adapter support and import inconsistencies',()=>{
 const live={data:[{id:'minimax-h3-480p-t'},{id:'gpt-image-2.5-1k',type:'image'},
   {id:'wan30-720p'}]};
 const saved=[row('minimax-h3-480p-t',{enabled:false}),
   row('gpt-image-2.5-1k',{type:'video',ready:true}),
   row('wan30-720p',{available:false,ready:false})];
 const result=auditApi888Import(live,saved);
 assert.equal(result.ok,false);
 assert.deepEqual(result.notMarkedAvailable,['wan30-720p']);
 assert.equal(result.mediaTypeMismatches.length,1);
 assert.equal(result.mediaTypeMismatches[0].id,'gpt-image-2.5-1k');
 assert.equal(result.summary.enabledReadyForCustomerCatalog,0);
 assert.match(result.details.find(x=>x.id==='minimax-h3-480p-t').reason,/Disabled/);
});

test('audit counts duplicate upstream model IDs once, does not mutate provider or saved model objects',()=>{
 const live={data:[{id:'minimax-h3-480p-t'},{id:'minimax-h3-480p-t'}]};
 const stored=[row('minimax-h3-480p-t')];
 const before=JSON.stringify({live,stored});
 const result=auditApi888Import(live,stored);
 assert.equal(result.ok,true);
 assert.equal(result.summary.upstreamReturned,1);
 assert.equal(JSON.stringify({live,stored}),before);
});

test('audit refuses upstream responses with no recognized model data rather than claiming import success',()=>{
 assert.throws(()=>auditApi888Import({data:[]},[]),/no recognized media models/i);
 assert.throws(()=>auditApi888Import({data:'invalid'},[]),/no model list/i);
});

test('exact SS and Dola model status distinguishes provider account access from saved model eligibility',()=>{
 const live={data:[
   {id:'s2-2.5-720p-v3'},
   {id:'dola-seedance-2.5-301010'},
   {id:'seedance2.5-vip-30-10-10'},
   {id:'s2-2.5-720p-v4'},
 ]};
 const stored=[
   row('s2-2.5-720p-v3'),
   row('dola-seedance-2.5-301010',{available:false}),
   row('s2-2.5-720p-v4',{enabled:false}),
 ];
 const result=auditApi888Import(live,stored);
 const byId=new Map(result.multimodalSeedance.map(x=>[x.id,x]));
 assert.equal(byId.get('ss-2.5-720p-v1').state,'not_returned_by_888api');
 assert.equal(byId.get('ss-2.5-720p-v1').upstreamReturned,false);
 assert.equal(byId.get('s2-2.5-720p-v3').state,'ready_for_enabled_customer');
 assert.equal(byId.get('dola-seedance-2.5-301010').state,'stale_available_flag');
 assert.equal(byId.get('s2-2.5-720p-v4').state,'disabled_in_admin');
 assert.equal(byId.get('seedance2.5-vip-30-10-10').state,'not_imported_into_cmmtools');
 assert.equal(byId.get('seedance-2.5-G2-V').state,'not_returned_by_888api');
});
test('an upstream-listed but unimplemented Seedance stays Admin-only even when a saved record exists',()=>{
 // No verified price for G2-V, so it is never offered.
 const live={data:[{id:'seedance-2.5-G2-V'}]};
 const stored=[row('seedance-2.5-G2-V',{supported:false,ready:false})];
 const result=auditApi888Import(live,stored);
 const status=result.multimodalSeedance.find(x=>x.id==='seedance-2.5-G2-V');
 assert.equal(status.state,'adapter_not_implemented');
 assert.equal(status.adapterSupported,false);
 assert.match(status.nextAction,/Admin-only/);
});
test('exact Dola Seedance image-only alias is not silently substituted for 301010 three-input version',()=>{
 const live={data:[{id:'dola-seedance-2.5'}]};
 const stored=[row('dola-seedance-2.5',{supported:false,ready:false})];
 const result=auditApi888Import(live,stored);
 assert.equal(result.multimodalSeedance.find(x=>x.id==='dola-seedance-2.5-301010').state,
   'not_returned_by_888api');
 assert.equal(result.multimodalSeedance.find(x=>x.id==='ss-2.5-720p-v1').upstreamReturned,false);
});

'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {auditApi888Import}=require('../src/api888_audit.js');

function row(providerModelId,{type='video',available=true,enabled=true,supported=true,ready=true}={}){
  return {providerModelId,mediaType:type,available,enabled,adapterSupported:supported,ready,
    setupReason:ready?'':'Unverified upstream request contract.'};
}

test('read-only audit distinguishes imported history from current live access',()=>{
  const live={data:[
    {id:'minimax-h3-480p-t'},
    {id:'gpt-image-2.5-1k',type:'image'},
    {id:'some-new-text-model',type:'text'},
  ]};
  const saved=[
    row('minimax-h3-480p-t'),
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

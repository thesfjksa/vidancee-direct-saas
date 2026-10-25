'use strict';
// These tests cover the whole 888API catalog, not just the models offered.
require('../src/api888_models.js').setApi888OfferAll(true);
const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../src/db.js');
const {api888MediaModels}=require('../src/api888_models.js');

test('new 888API adapters require explicit Admin enable after live sync, existing supported stay enabled',async()=>{
 const previous=db.getPool;
 const statements=[];
 const prior=[
   {provider_model_id:'sora2-4s-16x9',options_json:JSON.stringify({adapterSupported:false})},
   {provider_model_id:'wan30-720p',options_json:{adapterSupported:true}},
 ];
 let commits=0;
 const fakeConnection={
   beginTransaction:async()=>{},
   execute:async(sql,args)=>{
     statements.push({sql,args});
     if(sql.startsWith('SELECT provider_model_id'))return [prior];
     return [{affectedRows:1}];
   },
   commit:async()=>{commits++},
   rollback:async()=>{throw Error('Rollback should not happen')},
   release:()=>{},
 };
 db.getPool=()=>({getConnection:async()=>fakeConnection,query:async()=>[[]]});
 delete require.cache[require.resolve('../src/provider_models.js')];
 try{
   const {syncProviderModels}=require('../src/provider_models.js');
   await syncProviderModels('api888',api888MediaModels({data:[
     {id:'sora2-4s-16x9'},{id:'wan30-720p'},{id:'grok-imagine-video'}]}));
   const gated=statements.filter(x=>x.sql.startsWith('UPDATE provider_models SET enabled=0'));
   assert.deepEqual(gated.map(x=>x.args[1]).sort(),['grok-imagine-video','sora2-4s-16x9']);
   assert.equal(commits,1);
 }finally{
   db.getPool=previous;
   delete require.cache[require.resolve('../src/provider_models.js')];
 }
});

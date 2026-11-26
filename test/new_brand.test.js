'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const brand=require('../src/new_brand.js');
const {customerProviderAccess}=require('../src/dope_brand.js');
const {isPureamModel,pureamMediaModels}=require('../src/puream_models.js');
const {publicVideoModel,syncProviderModels}=require('../src/provider_models.js');
const {serializeGeneration}=require('../src/generations.js');
const {normalizeInput,publicJob}=require('../src/customer_api.js');
const {hideVendors,hideVendorsInBody}=require('../src/vendor_names.js');
const {enablePureamForEveryoneOnce}=require('../src/puream_access.js');
const legacy='puream_sd25_abcdef123456',alias='new_sd25_abcdef123456';
const raw={id:'puream-sd25-abcdef123456',name:'Seedance 2.5 · ABC123',family:'seedance25',available:true,resolutions:['480p'],
 durations_by_resolution:{'480p':[2,4]},pricing_by_resolution:{'480p':{billing_unit:'second',price_yuan:0.2475}},
 aspect_ratios:['16:9'],max_images:9,max_videos:5,max_audios:3,requires_reference:false,max_prompt_characters:5000,generation_modes:['reference']};
const row=pureamMediaModels({data:[raw]})[0];

test('public catalog and model lookup use New aliases without altering stored model IDs or reference capabilities',async()=>{
  assert.equal(brand.customerNewModelId(legacy),alias);assert.equal(brand.storedNewModelId(alias),legacy);
  assert.ok(isPureamModel(alias));assert.ok(isPureamModel(legacy));assert.equal(isPureamModel('new_other_abc'),false);
  const publicModel=publicVideoModel({...row.options,provider:'puream',publicModelId:row.publicModelId,label:row.label});
  assert.equal(publicModel.id,alias);assert.match(publicModel.label,/Seedance 2\.5 · New/);
  assert.equal(publicModel.capabilities.video.max,5);assert.doesNotMatch(JSON.stringify(publicModel),/puream/i);
  assert.match(row.label,/Puream/);assert.equal(row.publicModelId,legacy);
  const code=fs.readFileSync(require.resolve('../src/provider_models.js'),'utf8');
  const start=code.indexOf('async function getProviderModelByPublicId('),end=code.indexOf('\nasync function quarantineProviderUtilityModels',start);
  let params;
  const ctx=vm.createContext({getPool:()=>({execute:async(_sql,values)=>{params=values;return [[{valid:true}]];}}),storedNewModelId:brand.storedNewModelId,
    serializeProviderModel:r=>r,isRetiredModel:()=>false});
  vm.runInContext(code.slice(start,end),ctx);
  await ctx.getProviderModelByPublicId('puream',alias,'video');assert.deepEqual(Array.from(params),['puream',legacy,'video']);
});

test('history, developer API, access flags and nested provider failures never expose the upstream brand',()=>{
  const job={id:'job',provider:'puream',model:legacy,media_type:'video',status:'failed',duration:2,credits_cost:10,
    error_message:'Puream returned HTTP 502 from https://www.puream.cn/api/ai/videos; PUREAM_HTTP.',prompt:'A flower',generation_options:'{}'};
  const records=[serializeGeneration(job),publicJob(job,'video')];
  for(const record of records){
    assert.equal(record.model,alias);assert.doesNotMatch(JSON.stringify(record),/puream|pure\s*ream|纯梦/i);
  }
  assert.equal(job.model,legacy);assert.match(job.error_message,/Puream/);
  assert.equal(normalizeInput({model:legacy,prompt:'A flower'}).model,alias);
  const access=customerProviderAccess({puream:true,wxksai:false});
  assert.equal(access.new,true);assert.equal(Object.hasOwn(access,'puream'),false);
  const body={error:'This Pure Ream model failed.',nested:{code:'PUREAM_CONNECTION',message:'纯梦 rejected task puream-sd25-abcdef123456'},
    model:legacy,label:'Seedance 2.5 · Puream',provider:'puream',prompt:'User typed Puream'};
  hideVendorsInBody(body);
  assert.equal(body.model,alias);assert.equal(body.nested.code,'SERVICE_ERROR');assert.equal(body.prompt,'User typed Puream');
  delete body.prompt;assert.doesNotMatch(JSON.stringify(body),/puream|pure\s*ream|纯梦/i);
  assert.match(hideVendors('Puream changed the price. Please try again.'),/generation service/i);
});

test('admin custom label override is migrated logically and cannot reintroduce the source name',()=>{
  const server=fs.readFileSync(require.resolve('../server.js'),'utf8');
  const start=server.indexOf('function applyModelNames('),end=server.indexOf('\nasync function customerMediaCatalog(',start);
  const ctx=vm.createContext({storedNewModelId:brand.storedNewModelId,customerNewLabel:brand.customerNewLabel});
  vm.runInContext(server.slice(start,end),ctx);
  const m={id:alias,label:'Seedance 2.5 · New'};
  const result=ctx.applyModelNames('video',[m],{['video:'+legacy]:'Pure Ream Creative'});
  assert.equal(result[0].label,'New Creative');
  const override=ctx.applyModelNames('video',[m],{['video:'+alias]:'Custom Puream name'});
  assert.equal(override[0].label,'Custom New name');
});

test('one-time rollout turns on all customers, models and global visibility atomically without touching charge or secret settings',async()=>{
  let marker='pending',calls=[],commits=0;
  const conn={beginTransaction:async()=>{},commit:async()=>{commits++;},rollback:async()=>{},release(){},
    execute:async(sql,params)=>{calls.push({sql,params});
      if(sql.includes('SELECT setting_value'))return [[{setting_value:marker}]];
      if(sql.startsWith('UPDATE app_settings SET'))marker='done';
      return [{affectedRows:1}];
    }};
  const db={getConnection:async()=>conn};
  assert.equal(await enablePureamForEveryoneOnce(db),true);
  assert.ok(calls.some(x=>/DELETE FROM user_provider_access WHERE provider='puream' AND enabled=0/.test(x.sql)));
  assert.ok(calls.some(x=>/UPDATE provider_models SET enabled=1/.test(x.sql)));
  assert.ok(calls.some(x=>x.sql.includes("'puream_enabled','true'")&&x.sql.includes("'puream_models_visible','true'")));
  assert.ok(!calls.some(x=>/allow_provider_charges|puream_api_key/.test(x.sql)));
  calls=[];assert.equal(await enablePureamForEveryoneOnce(db),false);
  assert.equal(calls.length,2);assert.equal(commits,2);
});

test('newly discovered variants are inserted enabled while future manual switch-offs are respected',async()=>{
  const inserts=[];
  const conn={query:async()=>[[]],execute:async(sql,params)=>{if(sql.includes('INSERT INTO provider_models'))inserts.push({sql,params});return [[]];}};
  await syncProviderModels('puream',[row],conn);
  assert.equal(inserts.length,1);assert.equal(inserts[0].params[8],1);
  assert.doesNotMatch(inserts[0].sql.split('ON DUPLICATE KEY UPDATE')[1],/enabled\s*=/);
});

test('public performance uses aliases, filters disabled models and customer assets contain no upstream brand',async()=>{
  const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
  const start=source.indexOf("    if (req.method==='GET' && routePath==='/api/new-performance')");
  const end=source.indexOf("    if (req.method==='GET' && routePath==='/api/api888-performance')",start);
  let result;
  const ctx=vm.createContext({req:{method:'GET'},routePath:'/api/new-performance',res:{},requireDatabase(){},
    requireUser:async()=>({id:1}),getVisibleUserProviderAccess:async()=>({puream:true}),getProviderSettings:async()=>({pureamEnabled:true,pureamApiKey:'fixture'}),
    getPool(){},require:()=>({pureamPerformance:async()=>({models:{[legacy]:{samples:1},puream_wan3_abcdef:{samples:2}}})}),
    publicProviderCatalog:async()=>({video:[{id:alias}]}),customerNewModelId:brand.customerNewModelId,
    sendJson:(_res,_status,value)=>{result=value;}});
  vm.runInContext('async function check(){'+source.slice(start,end)+'}',ctx);
  await ctx.check();assert.deepEqual(Object.keys(result.models),[alias]);
  assert.doesNotMatch(JSON.stringify(result),/puream/i);
  for(const file of ['../public/index.html','../public/dope-performance.js']){
    assert.doesNotMatch(fs.readFileSync(require.resolve(file),'utf8'),/puream|pure\s*ream/i);
  }
});

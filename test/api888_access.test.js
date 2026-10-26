'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {disableApi888ForUsersOnce}=require('../src/api888_access.js');
function fakeDb(fail=false){
 const state={marker:null,global:'true',access:[{provider:'api888',enabled:1},{provider:'higgsfield',enabled:1}]};
 let snapshot;
 const conn={
  beginTransaction:async()=>{snapshot=structuredClone(state);},
  commit:async()=>{},rollback:async()=>Object.assign(state,snapshot),release:()=>{},
  execute:async(sql,args)=>{
   if(sql.startsWith('INSERT IGNORE')){state.marker??='pending';return [{}];}
   if(sql.startsWith('SELECT'))return [[{setting_value:state.marker}]];
   if(sql.startsWith('UPDATE user_provider_access')){for(const r of state.access)if(r.provider==='api888')r.enabled=0;return [{}];}
   if(sql.startsWith('INSERT INTO app_settings')){if(fail)throw Error('database unavailable');state.global='false';return [{}];}
   if(sql.startsWith('UPDATE app_settings')){state.marker=args[0];return [{}];}
   throw Error('Unexpected SQL');
  }
 };
 return {state,getConnection:async()=>conn};
}
test('888API one-time reset disables existing users and global source without touching other providers',async()=>{
 const db=fakeDb();assert.equal(await disableApi888ForUsersOnce(db),true);
 assert.equal(db.state.global,'false');assert.equal(db.state.access[0].enabled,0);
 assert.equal(db.state.access[1].enabled,1);
 // Later Admin choices survive web/worker restarts.
 db.state.access[0].enabled=1;db.state.global='true';
 assert.equal(await disableApi888ForUsersOnce(db),false);
 assert.equal(db.state.access[0].enabled,1);assert.equal(db.state.global,'true');
});
test('888API reset rolls back both grants and migration marker if disabling fails',async()=>{
 const db=fakeDb(true);await assert.rejects(disableApi888ForUsersOnce(db),/database unavailable/);
 assert.equal(db.state.marker,null);assert.equal(db.state.access[0].enabled,1);
});
test('customer access defaults allow 888API and respect an Admin switch-off',()=>{
 const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
 const defaults=source.slice(source.indexOf('const CUSTOMER_PROVIDER_KEYS='),source.indexOf('// Voice Studio used'));
 const getter=source.slice(source.indexOf('async function getUserProviderAccess('),source.indexOf('async function setUserProviderAccess('));
 const context={dbConfigured:()=>true,getPool:()=>({execute:async()=>[[]]})};vm.createContext(context);
 vm.runInContext(defaults+getter,context);
 return context.getUserProviderAccess(42).then(async access=>{
  assert.equal(access.api888,true);assert.equal(access.higgsfield,true);
  context.getPool=()=>({execute:async()=>[[{provider:'api888',enabled:0}]]});
  assert.equal((await context.getUserProviderAccess(42)).api888,false);
 });
});
test('worker submits 888API jobs unless the customer\'s 888API access is switched off',()=>{
 const {Api888Queue}=require('../src/api888_queue.js');
 const {VercelQueue}=require('../src/vercel_queue.js');
 assert.match(new Api888Queue().queuedSql(),/COALESCE\(a.enabled,1\)=1/);
});
test('the offered 888API models are switched on once, and a later Admin switch-off survives restarts',async()=>{
 const {enableDefaultApi888ModelsOnce}=require('../src/api888_access.js');
 const state={marker:null,rows:{'seedance-2.5-g5-v2':0,'seedance2.0-933':0,'seedance2.5-301010-wool':0,'wan3.0-video-prime':0,'wan30-720p':0,'wan3.0-video':0}};
 const conn={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},
  execute:async(sql,args)=>{
   if(sql.startsWith('INSERT IGNORE')){state.marker??='pending';return [{}];}
   if(sql.startsWith('SELECT'))return [[{setting_value:state.marker}]];
   if(sql.startsWith('UPDATE provider_models')){for(const id of args)if(id in state.rows)state.rows[id]=1;return [{}];}
   if(sql.startsWith('UPDATE app_settings')){state.marker=args[0];return [{}];}
   throw Error('Unexpected SQL');
  }};
 const db={getConnection:async()=>conn};
 assert.equal(await enableDefaultApi888ModelsOnce(db),true);
 assert.deepEqual(state.rows,{'seedance-2.5-g5-v2':1,'seedance2.0-933':1,'seedance2.5-301010-wool':1,'wan3.0-video-prime':1,'wan30-720p':1,'wan3.0-video':0});
 state.rows['seedance2.0-933']=0;
 assert.equal(await enableDefaultApi888ModelsOnce(db),false);
 assert.equal(state.rows['seedance2.0-933'],0);
 // Sites that already ran the first four-model step get only the model added since.
 state.marker='done';state.rows={'seedance2.0-933':0,'wan30-720p':0};
 assert.equal(await enableDefaultApi888ModelsOnce(db),true);
 assert.deepEqual(state.rows,{'seedance2.0-933':0,'wan30-720p':1});
 assert.equal(await enableDefaultApi888ModelsOnce(db),false);
});
test('888API is switched on for every customer once, including switches turned off after the first pass',async()=>{
 const src=fs.readFileSync(require.resolve('../server.js'),'utf8');
 const fn=src.slice(src.indexOf('async function enableApi888ForCustomersOnce'),src.indexOf('async function getUserProviderAccess'));
 const key=src.match(/const API888_ALL_ON_SETTING='([^']+)'/)[1];
 assert.notEqual(key,'api888_access_all_on_at');
 const store=new Map([['api888_access_all_on_at','2026-10-25T20:10:00Z']]),sql=[],logs=[];
 const run=new Function('getSettingValue','setSettingValue','getPool','logActivity','API888_ALL_ON_SETTING',fn+'; return enableApi888ForCustomersOnce();');
 const deps=[async k=>store.get(k)||'',async(k,v)=>store.set(k,v),()=>({execute:async q=>{sql.push(q);return [{affectedRows:2}];}}),e=>logs.push(e),key];
 assert.equal(await run(...deps),2);
 assert.match(sql[0],/DELETE FROM user_provider_access WHERE provider='api888' AND enabled=0/);
 assert.equal(await run(...deps),0);
 assert.equal(sql.length,1);
 assert.match(logs[0].message,/2 had it off/);
});

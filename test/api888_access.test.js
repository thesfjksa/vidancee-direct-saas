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
test('customer access defaults deny 888API and allow an explicit saved Admin grant',()=>{
 const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
 const defaults=source.slice(source.indexOf('const CUSTOMER_PROVIDER_KEYS='),source.indexOf('// Voice Studio used'));
 const getter=source.slice(source.indexOf('async function getUserProviderAccess('),source.indexOf('async function setUserProviderAccess('));
 const context={dbConfigured:()=>true,getPool:()=>({execute:async()=>[[]]})};vm.createContext(context);
 vm.runInContext(defaults+getter,context);
 return context.getUserProviderAccess(42).then(async access=>{
  assert.equal(access.api888,false);assert.equal(access.higgsfield,true);
  context.getPool=()=>({execute:async()=>[[{provider:'api888',enabled:1}]]});
  assert.equal((await context.getUserProviderAccess(42)).api888,true);
 });
});
test('worker requires explicit customer access before submitting an 888API queued job',()=>{
 const {Api888Queue}=require('../src/api888_queue.js');
 const {VercelQueue}=require('../src/vercel_queue.js');
 assert.match(new Api888Queue().queuedSql(),/COALESCE\(a.enabled,0\)=1/);
});

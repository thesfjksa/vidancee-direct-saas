'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {KEY,DEFAULT,MAX_USERS,normalized,readConfig,verifyAccounts,saveConfig,enabled,allowed,authorized}=require('../src/aivid_windows_settings.js');

test('Windows Studio is database-managed, disabled by default, and unaffected by Hostinger environment toggles',async()=>{
  const prior=process.env.AIVID_WINDOWS_VIEW_ENABLED;
  process.env.AIVID_WINDOWS_VIEW_ENABLED='true';
  try{
    const state=await readConfig(async(k,fallback)=>{assert.equal(k,KEY);return fallback;});
    assert.equal(state.enabled,false);
    assert.equal(enabled(state),false);
    assert.equal(allowed({id:42,email:'someone@example.com'},state),false);
    assert.deepEqual(state.allowedIds,[]);
    assert.deepEqual(state.allowedEmails,[]);
  }finally{
    if(prior===undefined)delete process.env.AIVID_WINDOWS_VIEW_ENABLED;
    else process.env.AIVID_WINDOWS_VIEW_ENABLED=prior;
  }
});

test('Saved settings authorize only explicit active accounts and accepted upstream billing',async()=>{
  const value={enabled:true,allowedIds:['42'],allowedEmails:['Owner@Example.com'],directBillingAcknowledged:true};
  const records=[];
  const db={execute:async(sql,params)=>{
    records.push({sql,params});
    return [[{id:42,status:'active'}]];
  }};
  let savedValue='';
  const saved=await saveConfig(value,{db,write:async(k,v)=>{
    assert.equal(k,KEY);savedValue=v;
  }});
  assert.deepEqual(saved.allowedEmails,['owner@example.com']);
  assert.deepEqual(saved.allowedIds,['42']);
  assert.equal(records.length,2);
  const loaded=await readConfig(async()=>savedValue);
  assert.deepEqual(saved,loaded);
  assert.equal(authorized({id:42},loaded),true);
  assert.equal(allowed({id:55,email:'OWNER@example.com'},loaded),true);
  assert.equal(allowed({id:55,email:'other@example.com'},loaded),false);
  assert.throws(()=>authorized({id:55,email:'other@example.com'},loaded),/not enabled/);
  const switched=await saveConfig({...loaded,enabled:false},{db,write:async(_,v)=>{savedValue=v;}});
  assert.equal(switched.enabled,false);
  assert.equal(allowed({id:42},await readConfig(async()=>savedValue)),false);
});

test('Unsafe or malformed settings remain disabled and invalid saves do not persist',async()=>{
  for(const raw of ['not json','[]','null','{"enabled":true}','{"enabled":"true"}']){
    const state=await readConfig(async()=>raw);
    assert.equal(state.enabled,false);
  }
  let writes=0;
  const write=async()=>{writes++;};
  const db={execute:async()=>[[{id:1,status:'active'}]]};
  const state={enabled:true,allowedIds:[],allowedEmails:[],directBillingAcknowledged:true};
  await assert.rejects(saveConfig(state,{db,write}),/approve a trusted user/i);
  await assert.rejects(saveConfig({...state,allowedEmails:['bad@@email']},{db,write}),/valid CMMTools/);
  await assert.rejects(saveConfig({...state,allowedIds:['42','43','44','45']},{db,write}),/at most three/i);
  await assert.rejects(saveConfig({...state,allowedIds:['42'],directBillingAcknowledged:false},{db,write}),/acknowledge/i);
  await assert.rejects(saveConfig({...state,allowedIds:['42'],directBillingAcknowledged:'true'},{db,write}),/must be provided/);
  assert.equal(writes,0);
  assert.equal(MAX_USERS,3);
});

test('Admin cannot grant Windows Studio to unknown or disabled CMMTools accounts',async()=>{
  let writes=0;
  const input={enabled:true,allowedIds:['42'],allowedEmails:[],directBillingAcknowledged:true};
  await assert.rejects(saveConfig(input,{db:{execute:async()=>[[]]},write:async()=>{writes++;}}),/does not exist or is disabled/);
  await assert.rejects(saveConfig(input,{db:{execute:async()=>[[{id:42,status:'disabled'}]]},write:async()=>{writes++;}}),/does not exist or is disabled/);
  assert.equal(writes,0);
  const emails={...input,allowedIds:[],allowedEmails:['owner@example.com']};
  await assert.rejects(saveConfig(emails,{db:{execute:async()=>[[]]},write:async()=>{writes++;}}),/does not exist or is disabled/);
  assert.equal(writes,0);
  // Revocation must succeed even if an approved customer has been deleted.
  const turnedOff=await saveConfig({...input,enabled:false},{db:{execute:async()=>{throw Error('should not query deleted users');}},write:async()=>{writes++;}});
  assert.equal(turnedOff.enabled,false);
  assert.equal(writes,1);
});

test('Admin UI and API include a feature switch, restricted accounts, billing warning and persistent save',()=>{
  const html=fs.readFileSync(require.resolve('../public/admin.html'),'utf8');
  const javascript=fs.readFileSync(require.resolve('../public/aivid-admin.js'),'utf8');
  const server=fs.readFileSync(require.resolve('../server.js'),'utf8');
  const customer=fs.readFileSync(require.resolve('../src/aivid_windows_live.js'),'utf8');
  for(const id of ['aividWindowsStudioEnabled','aividWindowsStudioEmails','aividWindowsStudioIds',
    'aividWindowsStudioBillingAck','aividWindowsStudioSave','aividWindowsStudioBadge']){
    assert.ok(html.includes('id="'+id+'"'),id);
  }
  assert.match(javascript,/window\.saveWindowsStudioAdmin/);
  assert.match(javascript,/window\.loadWindowsStudioAdmin/);
  assert.match(server,/routePath==='\/admin\/aivid\/windows-studio'/);
  assert.match(server,/adminAuthorized\(req\)/);
  assert.match(customer,/await loadSettings\(\)/);
  assert.doesNotMatch(customer,/process\.env\.AIVID_WINDOWS_VIEW_/);
});

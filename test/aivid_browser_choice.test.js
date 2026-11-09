'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {findBrowser,browserProfile,chromiumArguments}=require('../scripts/aivid-rdp/native.cjs');
const {validateConfig,configFrom,publicConfig}=require('../src/aivid_settings.js');
const {AividRdpService,publicDevice}=require('../src/aivid_rdp.js');
const {aividReady}=require('../src/aivid_models.js');

test('RDP configuration always uses Edge, even with legacy Chrome settings or old Admin requests',()=>{
 const current={mode:'rdp',apiKey:'',endpoint:'https://production-sfo.browserless.io',browser:'chrome'};
 for(const browser of [undefined,'chrome','edge','invalid']){
  const input=browser===undefined?{mode:'rdp'}:{mode:'rdp',browser};
  assert.equal(validateConfig(input,current).browser,'edge');
 }
 assert.equal(configFrom({}, {}, {mode:'rdp',browser:'chrome'}).browser,'edge');
 assert.equal(publicConfig({...current,browser:'chrome'}).browser,'edge');
 assert.equal(configFrom({}, {}, {mode:'rdp',browser:'edge'}).browser,'edge');
});

test('Windows agent discovers only Edge and keeps its isolated private profile',()=>{
 const env={PROGRAMFILES:'C:\\Program Files','PROGRAMFILES(X86)':'C:\\Program Files (x86)'};
 const exists=file=>file.endsWith('msedge.exe');
 assert.match(findBrowser('edge',env,exists),/Microsoft.*Edge.*msedge.exe/);
 assert.throws(()=>findBrowser('chrome',env,exists),/Only Microsoft Edge/);
 assert.throws(()=>browserProfile('C:\\agent','chrome'),/Only Microsoft Edge/);
 assert.match(browserProfile('C:\\agent'),/edge-profile$/);
 assert.deepEqual(chromiumArguments('./profile').filter(x=>x.includes('debug')),[]);
 const source=fs.readFileSync(require.resolve('../scripts/aivid-rdp/login.cjs'),'utf8');
 assert.match(source,/startEdge/);
 assert.doesNotMatch(source,/startChrome|Google Chrome|\/browser/);
});

test('RDP polling rejects old Chrome agents and preserves Edge jobs regardless of saved legacy selection',async()=>{
 const records=new Map();
 const device={deviceId:'device',tokenHash:'private'};
 let claims=0;
 const service=new AividRdpService({
  db:()=>({}),read:async(k,d)=>records.get(k)??d,
  write:async(k,v)=>records.set(k,v),
  getConfig:async()=>({mode:'rdp',browser:'chrome'}),
  store:{claim:async()=>{claims++;return {id:'command',kind:'preflight',payload:{},expiresAt:Date.now()+60000}}}
 });
 const old=await service.poll(device,'ready','chrome');
 assert.equal(old.browser,'edge');assert.equal(old.command,null);assert.equal(claims,0);
 assert.equal(publicDevice(JSON.parse(records.get('aivid_rdp_heartbeat'))).status,'starting');
 const missing=await service.poll(device,'ready');
 assert.equal(missing.command,null);assert.equal(claims,0);
 const active=await service.poll(device,'ready','edge');
 assert.equal(active.command.id,'command');assert.equal(claims,1);
 await assert.rejects(service.poll(device,'ready','firefox'),/Invalid RDP browser/);
});

test('Premium readiness depends on current Edge heartbeat, not old Chrome settings',()=>{
 const device={deviceId:'device',tokenHash:'secret',status:'ready',seenAt:new Date().toISOString(),browser:'chrome'};
 const config={mode:'rdp',browser:'chrome',enabled:true,maxSourceCredits:10,rdpDevice:device};
 assert.equal(aividReady(config),false);
 assert.equal(aividReady({...config,rdpDevice:{...device,browser:'edge'}}),true);
});

test('Admin no longer exposes browser choice or submits a browser override',()=>{
 const admin=fs.readFileSync(require.resolve('../public/admin.html'),'utf8');
 const script=fs.readFileSync(require.resolve('../public/aivid-admin.js'),'utf8');
 assert.doesNotMatch(admin,/id="aividRdpBrowser"/);
 assert.match(admin,/Microsoft Edge only/);
 assert.doesNotMatch(script,/aividRdpBrowser|expectedBrowser/);
 assert.match(script,/saved\.browser!=='edge'/);
});

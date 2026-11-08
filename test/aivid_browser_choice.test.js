'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {findBrowser,browserProfile,chromeArguments}=require('../scripts/aivid-rdp/native.cjs');
const {validateConfig,configFrom,publicConfig}=require('../src/aivid_settings.js');
const {AividRdpService,publicDevice}=require('../src/aivid_rdp.js');
const {aividReady}=require('../src/aivid_models.js');

test('Admin rejects unknown browsers, defaults to Chrome, and exposes the selected browser',()=>{
 const current={mode:'rdp',apiKey:'',endpoint:'https://production-sfo.browserless.io'};
 assert.equal(validateConfig({mode:'rdp'},current).browser,'chrome');
 assert.equal(validateConfig({mode:'rdp',browser:'edge'},current).browser,'edge');
 assert.throws(()=>validateConfig({mode:'rdp',browser:'unknown'},current),/Choose Google Chrome or Microsoft Edge/);
 assert.equal(configFrom({}, {}, {mode:'rdp',browser:'edge'}).browser,'edge');
 assert.equal(publicConfig({...current,browser:'edge'}).browser,'edge');
});
test('Edge binary selection and profile isolation preserve existing Chrome session',()=>{
 const env={PROGRAMFILES:'C:\\Program Files', 'PROGRAMFILES(X86)':'C:\\Program Files (x86)'};
 const seen=[];
 const exists=file=>{seen.push(file);return file.endsWith('msedge.exe')||file.endsWith('chrome.exe')};
 assert.match(findBrowser('edge',env,exists),/Microsoft.*Edge.*msedge.exe/);
 assert.match(findBrowser('chrome',env,exists),/Google.*Chrome.*chrome.exe/);
 assert.notEqual(browserProfile('C:\\agent','chrome'),browserProfile('C:\\agent','edge'));
 assert.match(browserProfile('C:\\agent','edge'),/edge-profile$/);
 assert.throws(()=>findBrowser('unsafe',env,exists),/Unsupported/);
 assert.deepEqual(chromeArguments('./profile').filter(x=>x.includes('debug')),[]);
});
test('RDP polling reports selected browser, blocks stale browser commands, and resumes safely',async()=>{
 const records=new Map();
 const device={deviceId:'device',tokenHash:'private'};
 let selected='edge', claims=0;
 const service=new AividRdpService({
  db:()=>({}), read:async(k,d)=>records.get(k)??d,
  write:async(k,v)=>records.set(k,v),
  getConfig:async()=>({mode:'rdp',browser:selected}),
  store:{claim:async()=>{claims++;return {id:'command',kind:'preflight',payload:{},expiresAt:Date.now()+60000}}}
 });
 const old=await service.poll(device,'ready','chrome');
 assert.equal(old.browser,'edge');assert.equal(old.command,null);assert.equal(claims,0);
 assert.equal(publicDevice(JSON.parse(records.get('aivid_rdp_heartbeat'))).status,'starting');
 const active=await service.poll(device,'ready','edge');
 assert.equal(active.command.id,'command');assert.equal(claims,1);
 selected='chrome';
 const switched=await service.poll(device,'ready','edge');
 assert.equal(switched.command,null);assert.equal(claims,1);
 await assert.rejects(service.poll(device,'ready','firefox'),/Invalid RDP browser/);
});
test('Premium readiness must match current Admin-selected browser',()=>{
 const rdpDevice={deviceId:'device',tokenHash:'secret',status:'ready',seenAt:new Date().toISOString(),browser:'chrome'};
 const config={mode:'rdp',browser:'edge',enabled:true,maxSourceCredits:10,rdpDevice};
 assert.equal(aividReady(config),false);
 assert.equal(aividReady({...config,rdpDevice:{...rdpDevice,browser:'edge'}}),true);
});

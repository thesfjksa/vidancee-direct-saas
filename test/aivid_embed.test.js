'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowed,endpoint,originOk,SCRIPT,start}=require('../src/aivid_embed.js');
test('Pilot is disabled by default and requires matching account allowlist',()=>{
 const user={id:7,email:'customer@example.com'};
 assert.equal(allowed(user,{}),false);
 assert.equal(allowed(user,{AIVID_LIVE_VIEW_ENABLED:'true',AIVID_LIVE_VIEW_ALLOWED_EMAILS:'other@example.com'}),false);
 assert.equal(allowed(user,{AIVID_LIVE_VIEW_ENABLED:'true',AIVID_LIVE_VIEW_ALLOWED_IDS:'7'}),true);
 assert.equal(allowed(user,{AIVID_LIVE_VIEW_ENABLED:'true',AIVID_LIVE_VIEW_ALLOWED_EMAILS:'customer@example.com'}),true);
});
test('Browser endpoint is secure and bound to Browserless host',()=>{
 assert.throws(()=>endpoint({}));
 assert.throws(()=>endpoint({AIVID_LIVE_VIEW_BROWSERLESS_WS:'ws://production-sfo.browserless.io?token=abc'}));
 assert.throws(()=>endpoint({AIVID_LIVE_VIEW_BROWSERLESS_WS:'wss://notbrowserless.io?token=abc'}));
 assert.throws(()=>endpoint({AIVID_LIVE_VIEW_BROWSERLESS_WS:'wss://production-sfo.browserless.io'}));
 assert.equal(endpoint({AIVID_LIVE_VIEW_BROWSERLESS_WS:'wss://production-sfo.browserless.io?token=abc'}),'wss://production-sfo.browserless.io/?token=abc');
});
test('Mutating session requests require the matching web origin',()=>{
 assert.equal(originOk({headers:{origin:'https://cmmtools.site',host:'cmmtools.site'}}),true);
 assert.equal(originOk({headers:{origin:'https://other.site',host:'cmmtools.site'}}),false);
 assert.equal(originOk({headers:{host:'cmmtools.site'}}),false);
});
test('White label script does not change submission or billing',()=>{
 assert.match(SCRIPT,/CMMTools Video Studio/);
 assert.doesNotMatch(SCRIPT,/fetch\(|submit\(|localStorage|cookie/);
});
test('No interactive paid session without explicit direct-billing acknowledgement',async()=>{
 await assert.rejects(start({id:7,email:'customer@example.com'},{env:{AIVID_LIVE_VIEW_ENABLED:'true',AIVID_LIVE_VIEW_ALLOWED_IDS:'7'}}),/Operator must explicitly acknowledge/);
});

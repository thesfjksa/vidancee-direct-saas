'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'../scripts/video-studio-launcher/extension');
test('Chrome proxy permission is required, never optional or requested at runtime',async()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 assert.equal(manifest.version,'1.7.1');assert.ok(manifest.permissions.includes('proxy'));
 for(const forbidden of ['proxy','debugger','declarativeNetRequest','devtools','geolocation','mdns','tts','ttsEngine'])assert.ok(!manifest.optional_permissions.includes(forbidden));
 const elements=Object.fromEntries(['managedEnabled','managedConsent','managedSave','managedStatus'].map(id=>[id,{checked:true,disabled:false,textContent:'',addEventListener(_type,fn){this.click=fn;}}]));
 let requested,saved;
 const chrome={storage:{local:{get:async()=>({managedEnabled:true,managedConsent:true})}},permissions:{request:async request=>{requested=request;assert.ok(!request.permissions.includes('proxy'));return true;}},runtime:{sendMessage(message,cb){saved=message;cb({ok:true});}}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'managed-options.js'),'utf8'),{document:{getElementById:id=>elements[id]},chrome,Promise});
 await new Promise(setImmediate);elements.managedSave.click();await new Promise(setImmediate);
 assert.deepEqual(JSON.parse(JSON.stringify(requested.permissions)),['webRequest','webRequestAuthProvider']);assert.equal(saved.type,'CMMTOOLS_MANAGED_SAVE');assert.equal(saved.enabled,true);assert.match(elements.managedStatus.textContent,/Saved/);
});

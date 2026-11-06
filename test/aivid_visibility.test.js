'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('Premium models are always in the account catalog, even if RDP disconnects',()=>{
  const models=require('../src/aivid_models.js');
  const connected={enabled:true,mode:'rdp',maxSourceCredits:30,rdpDevice:{
    deviceId:'test',tokenHash:'secret',seenAt:new Date().toISOString(),status:'ready'}};
  const ready=models.customerCatalog(connected);
  const stale=models.customerCatalog({...connected,rdpDevice:{...connected.rdpDevice,seenAt:'2020-01-01T00:00:00Z'}});
  assert.deepEqual(stale.map(m=>m.id),ready.map(m=>m.id));
  assert.equal(ready.length,3);
  assert.ok(ready.every(m=>m.unavailable===false));
  assert.ok(stale.every(m=>m.unavailable===true));
  assert.ok(stale.every(m=>m.premium===true));
});
test('Customer UI distinguishes visibility from paid readiness',()=>{
  const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
  assert.match(html,/\$\('generateBtn'\)\.disabled=m\.unavailable===true/);
  assert.match(html,/\$\('cost'\)\.textContent='Unavailable'/);
  assert.match(html,/showModelWarning\('videoModelWarning',m\)/);
});
test('Backend quote stays blocked when the Premium source is offline',async()=>{
  const {quoteAivid}=require('../src/aivid_models.js');
  await assert.rejects(
    quoteAivid({enabled:false,maxSourceCredits:30,mode:'rdp'},
      {model:'aivid_seedance_2_0_mini',duration:5,resolution:'480p',aspectRatio:'16:9'}),
    error=>error.statusCode===503 && /connected/i.test(error.message)
  );
});

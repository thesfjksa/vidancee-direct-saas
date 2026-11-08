'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {saveAividSettings,CONFIG_KEY}=require('../src/aivid_settings.js');
const {aividReady,customerCatalog}=require('../src/aivid_models.js');
const sample=()=>({apiKey:'',endpoint:'https://production-sfo.browserless.io',mode:'rdp',enabled:false,maxSourceCredits:0,ttlDays:1,
  rdpDevice:{deviceId:'test',tokenHash:'hash',seenAt:new Date().toISOString(),status:'ready'}});
test('AIVID Admin save verifies persisted enabled flag and ceiling before reporting success',async()=>{
  const db=new Map();
  const base=sample();
  const saved=await saveAividSettings({mode:'rdp',enabled:true,maxSourceCredits:10},{
    getConfig:async()=>base,write:async(k,v)=>db.set(k,v),read:async(k,d)=>db.get(k)||d
  });
  assert.equal(saved.enabled,true);assert.equal(saved.maxSourceCredits,10);assert.equal(saved.customerModelEnabled,true);
  assert.equal(JSON.parse(db.get(CONFIG_KEY)).enabled,true);
  const effective={...base,...JSON.parse(db.get(CONFIG_KEY))};
  assert.equal(aividReady(effective),true);
  assert.ok(customerCatalog(effective).every(m=>m.unavailable===false));
});
test('Missing or ignored DB write cannot falsely say AIVID is enabled',async()=>{
  await assert.rejects(saveAividSettings({mode:'rdp',enabled:true,maxSourceCredits:10},{
    getConfig:async()=>sample(),write:async()=>{},read:async()=>''
  }),/could not be verified/);
  await assert.rejects(saveAividSettings({mode:'rdp',enabled:true,maxSourceCredits:10},{
    getConfig:async()=>sample(),write:async()=>{},read:async()=>JSON.stringify({mode:'rdp',enabled:false,maxSourceCredits:0})
  }),/could not be verified/);
});
test('Browser admin UI displays saved state distinct from changed checkbox and rechecks after saving',()=>{
  const ui=fs.readFileSync(require.resolve('../public/aivid-admin.js'),'utf8');
  assert.match(ui,/Saved in Admin:/);
  assert.match(ui,/Unsaved changes/);
  assert.match(ui,/const verified=await window\.loadAividAdmin\(\{strict:true\}\)/);
  assert.match(ui,/verified\.enabled!==expectedEnabled/);
});

test('Windows browser is validated, persisted, and returned in public admin configuration',async()=>{
  const {validateConfig,publicConfig,configFrom}=require('../src/aivid_settings.js');
  assert.equal(configFrom({}, {}, null).rdpBrowser,'chrome');
  assert.equal(configFrom({}, {}, {rdpBrowser:'edge'}).rdpBrowser,'edge');
  const current=sample(),db=new Map();
  assert.throws(()=>validateConfig({mode:'rdp',rdpBrowser:'firefox'},current),/Choose Chrome or Microsoft Edge/);
  const saved=await saveAividSettings({mode:'rdp',rdpBrowser:'edge',enabled:true,maxSourceCredits:10},{
    getConfig:async()=>current,write:async(k,v)=>db.set(k,v),read:async(k,d)=>db.get(k)||d
  });
  assert.equal(saved.rdpBrowser,'edge');
  assert.equal(JSON.parse(db.get(CONFIG_KEY)).rdpBrowser,'edge');
  assert.equal(publicConfig({...current,rdpBrowser:'edge'}).rdpBrowser,'edge');
});

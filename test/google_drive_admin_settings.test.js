'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

test('Admin Google OAuth credentials are encrypted and saved atomically, never as plaintext',async()=>{
 const dbModule=require('../src/db.js');
 const originalPool=dbModule.getPool;
 const originalSecret=process.env.SETTINGS_ENCRYPTION_KEY;
 const clientId='860704422614-test.apps.googleusercontent.com';
 const clientSecret='GOCSPX-a-fresh-rotated-secret';
 let commits=0,rollbacks=0;
 const writes=[];
 const conn={
   beginTransaction:async()=>{},
   execute:async(sql,args)=>{writes.push({sql,args});return [{affectedRows:1}]},
   commit:async()=>{commits++},
   rollback:async()=>{rollbacks++},
   release:()=>{},
 };
 const db={query:async(sql)=>{assert.match(sql,/^SELECT setting_key, setting_value, is_secret FROM app_settings LIMIT 0$/);return [[]]},
   getConnection:async()=>conn};
 try{
   process.env.SETTINGS_ENCRYPTION_KEY='unit-test-encryption-key-only';
   dbModule.getPool=()=>db;
   delete require.cache[require.resolve('../src/settings.js')];
   const {saveGoogleDriveOAuthCredentials}=require('../src/settings.js');
   await saveGoogleDriveOAuthCredentials(clientId,clientSecret);
   assert.equal(commits,1);assert.equal(rollbacks,0);
   assert.equal(writes.length,3);
   assert.deepEqual(writes.slice(0,2).map(w=>w.args[0]),['gdrive_oauth_client_id','gdrive_oauth_client_secret']);
   assert.ok(writes.every(w=>!w.args.includes(clientSecret)));
   assert.ok(writes[0].args[1].startsWith('v1:'));
   assert.ok(writes[1].args[1].startsWith('v1:'));
   assert.equal(writes[1].args[1].includes(clientSecret),false);
   assert.match(writes[2].sql,/^DELETE FROM app_settings/);
 }finally{
   dbModule.getPool=originalPool;
   if(originalSecret===undefined)delete process.env.SETTINGS_ENCRYPTION_KEY;
   else process.env.SETTINGS_ENCRYPTION_KEY=originalSecret;
   delete require.cache[require.resolve('../src/settings.js')];
 }
});

test('If saving either Google OAuth credential fails, entire settings transaction rolls back',async()=>{
 const dbModule=require('../src/db.js'),originalPool=dbModule.getPool;
 const originalSecret=process.env.SETTINGS_ENCRYPTION_KEY;
 let commits=0,rollbacks=0,writes=0;
 const db={query:async()=>[[]],getConnection:async()=>({
   beginTransaction:async()=>{},
   execute:async()=>{writes++;if(writes===2)throw new Error('disk full');return [{affectedRows:1}]},
   commit:async()=>{commits++},rollback:async()=>{rollbacks++},release:()=>{},
 })};
 try{
   process.env.SETTINGS_ENCRYPTION_KEY='unit-test-encryption-key-only';
   dbModule.getPool=()=>db;
   delete require.cache[require.resolve('../src/settings.js')];
   const {saveGoogleDriveOAuthCredentials}=require('../src/settings.js');
   await assert.rejects(saveGoogleDriveOAuthCredentials(
     '860704422614-test.apps.googleusercontent.com','GOCSPX-fresh-secret-12345'),/disk full/);
   assert.equal(commits,0);
   assert.equal(rollbacks,1);
 }finally{
   dbModule.getPool=originalPool;
   if(originalSecret===undefined)delete process.env.SETTINGS_ENCRYPTION_KEY;
   else process.env.SETTINGS_ENCRYPTION_KEY=originalSecret;
   delete require.cache[require.resolve('../src/settings.js')];
 }
});

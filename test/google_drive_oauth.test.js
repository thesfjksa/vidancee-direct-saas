'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
  oauthConfig,authUrl,exchangeCode,validateOAuthClient,
  OAUTH_ID_SETTING,OAUTH_SECRET_SETTING,OAUTH_REDIRECT,
}=require('../src/google_drive.js');
const CLIENT='860704422614-jb2ulof98knudim8jb4fcfbnh5i22fn.apps.googleusercontent.com';
const SECRET='GOCSPX-test-new-rotated-secret';

test('Admin-encrypted settings override legacy environment credentials in web and worker',async()=>{
 const reads=[];
 const cfg=await oauthConfig({
   getSetting:async(name,fallback)=>{
     reads.push(name);return name===OAUTH_ID_SETTING?CLIENT:name===OAUTH_SECRET_SETTING?SECRET:fallback;
   },
   env:{GOOGLE_DRIVE_CLIENT_ID:'111111-legacy.apps.googleusercontent.com',
     GOOGLE_DRIVE_CLIENT_SECRET:'legacy-client-secret'},
 });
 assert.equal(cfg.clientId,CLIENT);
 assert.equal(cfg.clientSecret,SECRET);
 assert.equal(cfg.redirectUri,OAUTH_REDIRECT);
 assert.deepEqual(reads,[OAUTH_ID_SETTING,OAUTH_SECRET_SETTING]);
});

test('OAuth still accepts existing Hostinger variables for backwards compatibility',async()=>{
 const cfg=await oauthConfig({
   getSetting:async(_,fallback)=>fallback,
   env:{GOOGLE_DRIVE_CLIENT_ID:CLIENT,GOOGLE_DRIVE_CLIENT_SECRET:SECRET},
 });
 assert.equal(cfg.clientId,CLIENT);
 assert.equal(cfg.clientSecret,SECRET);
});

test('Missing OAuth settings gives actionable Admin Storage instructions',async()=>{
 await assert.rejects(oauthConfig({
   getSetting:async()=>'',env:{},
 }),/Save the Google OAuth Client ID and Client Secret in Admin/i);
});

test('Google OAuth URL contains exact redirect and scope, but never the client secret',async()=>{
 const cfg={clientId:CLIENT,clientSecret:SECRET,redirectUri:OAUTH_REDIRECT};
 const url=new URL(authUrl('nonce-demo-1234',cfg));
 assert.equal(url.origin,'https://accounts.google.com');
 assert.equal(url.searchParams.get('client_id'),CLIENT);
 assert.equal(url.searchParams.get('redirect_uri'),OAUTH_REDIRECT);
 assert.equal(url.searchParams.get('access_type'),'offline');
 assert.match(url.searchParams.get('scope'),/drive\.file/);
 assert.equal(url.searchParams.get('state'),'nonce-demo-1234');
 assert.equal(url.toString().includes(SECRET),false);
});

test('Google OAuth authorization-code exchange uses same saved credentials and redirects',async()=>{
 let calls=0;
 const cfg={clientId:CLIENT,clientSecret:SECRET,redirectUri:OAUTH_REDIRECT};
 const result=await exchangeCode('opaque-google-code',{config:cfg,fetchImpl:async(url,options)=>{
   calls++;assert.equal(url,'https://oauth2.googleapis.com/token');
   assert.equal(options.method,'POST');
   const form=new URLSearchParams(options.body);
   assert.equal(form.get('client_id'),CLIENT);
   assert.equal(form.get('client_secret'),SECRET);
   assert.equal(form.get('redirect_uri'),OAUTH_REDIRECT);
   assert.equal(form.get('code'),'opaque-google-code');
   return new Response(JSON.stringify({refresh_token:'opaque-refresh-token'}),{status:200});
 }});
 assert.equal(result,'opaque-refresh-token');
 assert.equal(calls,1);
});

test('OAuth validation rejects malformed or missing client credentials',()=>{
 for(const badId of ['not a client','http://evil.test','wrong@google.com']){
   assert.throws(()=>validateOAuthClient({clientId:badId,clientSecret:SECRET}),/Client ID/);
 }
 for(const bad of ['', 'bad', 'has spaces and control \n']) {
   assert.throws(()=>validateOAuthClient({clientId:CLIENT,clientSecret:bad}),/secret/i);
 }
 assert.doesNotThrow(()=>validateOAuthClient({clientId:CLIENT,clientSecret:SECRET}));
});

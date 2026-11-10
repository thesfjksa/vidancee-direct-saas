'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const share=require('../src/aivid_tab_share.js');
const ORIGIN='chrome-extension://'+'a'.repeat(32);
const settings={enabled:true,allowedIds:['42'],allowedEmails:[],directBillingAcknowledged:true};
const headers={origin:ORIGIN};
function reply(){return{code:0,body:null,headers:null,writeHead(status,h){this.code=status;this.headers=h;},end(body){this.body=body;}};}
function req(method,route,body=null,extra={}){
 const parts=body==null?[]:[Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body))];
 const request=(async function*(){for(const x of parts)yield x;})();
 request.method=method;request.url=route;request.headers={...headers,...extra};
 return request;
}
async function send(method,route,body,extra={},options={}){
 const res=reply();await share.handle(req(method,route,body,extra),res,route,{
  requireDatabase:()=>{},requireUser:async()=>({id:42,email:'owner@example.com'}),
  loadSettings:async()=>settings,checkSourceAccess:async()=>true,...options});return res;
}
const jpeg=Buffer.concat([Buffer.from([0xff,0xd8]),Buffer.alloc(120,77),Buffer.from([0xff,0xd9])]);
test('Admin-paired tab sharing requires a random one-time code, unique extension origin, and token',()=>{
  share.stop();
  const {code}=share.newPairing(100000);
  assert.match(code,/^[A-F0-9]{32}$/);
  assert.throws(()=>share.pair('0'.repeat(32),ORIGIN,100001),/Invalid pairing/);
  const {token,expiresAt}=share.pair(code,ORIGIN,100002);
  assert.equal(token.length>=32,true);
  assert.equal(Date.parse(expiresAt)>100002,true);
  assert.throws(()=>share.pair(code,ORIGIN,100003),/No active pairing/);
  assert.throws(()=>share.assertPublisher(token,'chrome-extension://'+'b'.repeat(32),100004),/expired or was revoked/);
  assert.throws(()=>share.assertPublisher('wrong',ORIGIN,100004),/token was rejected/);
  assert.doesNotThrow(()=>share.assertPublisher(token,ORIGIN,100004));
  share.stop();
  assert.throws(()=>share.assertPublisher(token,ORIGIN,100005),/expired or was revoked/);
});
test('Accepted screenshots are bounded JPEG, rate-limited, memory-only and expire quickly',()=>{
  share.stop();
  const code=share.newPairing(100000).code,{token}=share.pair(code,ORIGIN,100001);
  assert.deepEqual(share.publish(jpeg,token,ORIGIN,103000),{accepted:true});
  assert.deepEqual(share.currentFrame(103100),jpeg);
  assert.throws(()=>share.publish(jpeg,token,ORIGIN,103300),/too frequent/);
  assert.throws(()=>share.publish(Buffer.alloc(160,0),token,ORIGIN,105000),/bounded JPEG/);
  assert.equal(share.currentFrame(116000),null);
  share.stop();
});
test('Extension pairing is rejected when disabled, and no browser permissions are granted to viewers',async()=>{
  share.stop();
  let res=await send('POST','/api/aivid-tab-share/pair',{code:'0'.repeat(32)},headers,{loadSettings:async()=>({...settings,enabled:false})});
  assert.equal(res.code,403);
  res=await send('OPTIONS','/api/aivid-tab-share/pair',null);
  assert.equal(res.code,204);
  assert.equal(res.headers['access-control-allow-origin'],ORIGIN);
  res=await send('POST','/api/aivid-tab-share/pair',{code:'0'.repeat(32)},{origin:'https://other.example'});
  assert.equal(res.code,403);
  res=await send('POST','/api/windows-studio/action',{action:'click',x:1,y:1},{origin:'https://cmmtools.site'});
  assert.equal(res.code,410);
  assert.match(JSON.parse(res.body).error,/automation is disabled/);
  res=await send('POST','/api/windows-studio/upload',{name:'ref.png'});
  assert.equal(res.code,410);
});
test('Only approved signed-in CMMTools accounts can retrieve snapshots or status',async()=>{
  share.stop();
  const code=share.newPairing(100000).code,{token}=share.pair(code,ORIGIN,100001);
  share.publish(jpeg,token,ORIGIN,103000);
  let res=await send('GET','/api/windows-studio/frame',null,{}, {now:()=>103500});
  assert.equal(res.code,200);assert.deepEqual(res.body,jpeg);
  res=await send('GET','/api/windows-studio/frame',null,{}, {now:()=>120000});
  assert.equal(res.code,204);
  res=await send('GET','/api/windows-studio/frame',null,{}, {loadSettings:async()=>({...settings,enabled:false})});
  assert.equal(res.code,403);
  res=await send('GET','/api/windows-studio/status',null,{}, {checkSourceAccess:async()=>false});
  assert.equal(res.code,403);
  res=await send('GET','/aivid-live-studio',null,{}, {requireUser:async()=>{throw Object.assign(new Error('Sign in'),{statusCode:401});}});
  assert.equal(res.code,401);
  share.stop();
});
test('Live screen sharing route is separate from old Windows Playwright controls',()=>{
 const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
 const viewer=fs.readFileSync(path.join(__dirname,'..','public','aivid-windows-studio.html'),'utf8');
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'..','scripts','aivid-tab-share-extension','manifest.json')));
 const controller=fs.readFileSync(path.join(__dirname,'..','scripts','aivid-tab-share-extension','controller.js'),'utf8');
 const background=fs.readFileSync(path.join(__dirname,'..','scripts','aivid-tab-share-extension','background.js'),'utf8');
 assert.match(server,/require\('\.\/src\/aivid_tab_share\.js'\)\.handle\(/);
 assert.doesNotMatch(server,/require\('\.\/src\/aivid_windows_live\.js'\)\.handle\(/);
 assert.match(viewer,/Read-only/);
 assert.doesNotMatch(viewer,/api\/windows-studio\/action|keyboard\.press|\.mouse\.click/i);
 assert.equal(manifest.content_scripts,undefined);
 assert.equal(manifest.permissions.includes('scripting'),false);
 assert.equal(manifest.permissions.includes('debugger'),false);
 assert.match(controller,/chrome\.tabs\.captureVisibleTab/);
 assert.doesNotMatch(controller,/require\(['"]playwright|chrome\.scripting\.|chrome\.debugger\.|executeScript\(|eval\(/i);
 assert.doesNotMatch(background,/chrome\.scripting\.|chrome\.debugger\.|executeScript\(|eval\(/i);
});

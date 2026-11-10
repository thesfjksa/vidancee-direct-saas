'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const x=require('../src/aivid_native_desktop.js');
const policy={enabled:true,allowedEmails:['owner@cmmtools.site'],allowedIds:[],directBillingAcknowledged:true};
const jpeg=Buffer.concat([Buffer.from([255,216]),Buffer.alloc(140,11),Buffer.from([255,217])]);
const request=(method,url,payload=null,headers={})=>{
 const chunks=payload===null?[]:[Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload))];
 const req=(async function*(){for(const p of chunks)yield p;})();
 Object.assign(req,{method,url,headers});
 return req;
};
const response=()=>({status:0,headers:{},payload:null,writeHead(status,headers){this.status=status;this.headers=headers;},end(value){this.payload=value;}});
async function ask(method,url,payload=null,options={},headers={}){
 const res=response();
 await x.handle(request(method,url,payload,{host:'cmmtools.site',origin:'https://cmmtools.site',...headers}),res,url,{
  requireDatabase:()=>{},requireUser:async()=>({id:54,email:'owner@cmmtools.site'}),
  loadSettings:async()=>policy,checkSourceAccess:async()=>true,...options
 });
 return res;
}
const json=res=>JSON.parse(res.payload);
test('Native host one-time pairing bound to single 90-minute session and Admin revoke',()=>{
 x.stop();
 const {code}=x.pairCode(500000);
 assert.match(code,/^[A-F0-9]{32}$/);
 assert.throws(()=>x.pair('A'.repeat(32),500005),/Incorrect pairing/);
 const {token,expiresAt}=x.pair(code,500010);
 assert.match(token,/^[A-Za-z0-9_-]{40,}$/);
 assert.ok(Date.parse(expiresAt)>500010);
 assert.throws(()=>x.pair(code,500030),/Pairing expired/);
 assert.throws(()=>x.auth('wrong',500030),/token rejected/);
 assert.doesNotThrow(()=>x.auth(token,500030));
 x.stop();assert.throws(()=>x.auth(token,500031),/expired or was revoked/);
});
test('Reject all invalid frame pixels/width/rate and let old screenshots expire',()=>{
 x.stop();const code=x.pairCode(500000).code,token=x.pair(code,500002).token;
 assert.deepEqual(x.image(jpeg,1024,720,token,505000),{accepted:true});
 assert.deepEqual(x.frame(505020),jpeg);
 assert.throws(()=>x.image(jpeg,1024,720,token,505200),/Too many screen updates/);
 assert.throws(()=>x.image(Buffer.alloc(180,0),1024,720,token,507000),/JPEG image/);
 assert.throws(()=>x.image(jpeg,100,720,token,507000),/dimensions/);
 assert.equal(x.frame(518000),null);
 x.stop();
});
test('Restricts remote input to pointer, printable text and specific harmless keys',()=>{
 for(const v of [{action:'key',key:'Ctrl+L'},{action:'key',key:'F11'},
  {action:'click',x:11000,y:33},{action:'type',text:'\x00'},
  {action:'type',text:'X'.repeat(257)},{action:'wheel',delta:500}])
  assert.throws(()=>x.inputShape(v));
 assert.deepEqual(x.inputShape({action:'click',x:5000,y:2500}),{action:'click',x:5000,y:2500});
 assert.deepEqual(x.inputShape({action:'type',text:'Hello World'}),{action:'type',text:'Hello World'});
 assert.deepEqual(x.inputShape({action:'key',key:'Tab'}),{action:'key',key:'Tab'});
});
test('Only one owner controls the viewport; Admin can revoke all queued inputs',()=>{
 x.stop();const code=x.pairCode(500000).code,token=x.pair(code,500002).token;
 x.image(jpeg,800,500,token,510000);
 assert.equal(x.enqueue('54',{action:'click',x:50,y:60},510200).queued,true);
 assert.throws(()=>x.enqueue('55',{action:'click',x:70,y:80},510300),/Another approved viewer/);
 assert.deepEqual(x.next(token,510300).action,{action:'click',x:50,y:60,id:1});
 assert.equal(x.next(token,510350).action,null);
 x.release('54');
 assert.equal(x.enqueue('55',{action:'wheel',delta:1},510500).queued,true);
 x.stop();
 assert.throws(()=>x.next(token,510600),/expired or was revoked/);
});
test('Native host ack reports actual execution/focus rejection to customer instead of claiming Sent',()=>{
 x.stop();
 const code=x.pairCode(500000).code,token=x.pair(code,500002).token;
 x.image(jpeg,1024,640,token,510000);
 const first=x.enqueue('54',{action:'click',x:2400,y:3000},510200);
 assert.equal(x.state(510201).lastInputId,0);
 const cmd=x.next(token,510300).action;
 assert.equal(cmd.id,first.id);
 assert.deepEqual(x.acknowledge(token,{id:cmd.id,executed:false,message:'Bring the AIVID Edge window to the foreground'},510350),
   {acknowledged:true});
 let status=x.state(510400);
 assert.equal(status.lastInputId,first.id);
 assert.equal(status.lastInputStatus,'blocked');
 assert.match(status.lastInputMessage,/foreground/);
 assert.throws(()=>x.acknowledge(token,{id:cmd.id,executed:true},510450),/Invalid or outdated/);
 const second=x.enqueue('54',{action:'type',text:'A safe test'},510500);
 x.next(token,510600);
 x.acknowledge(token,{id:second.id,executed:true},510650);
 status=x.state(510651);
 assert.equal(status.lastInputStatus,'executed');
 assert.match(status.lastInputMessage,/dispatched input/);
 x.stop();
});
test('Interactive UI offers direct keyboard controls, fullscreen, actual size and decode-safe refresh',()=>{
 const root=path.join(__dirname,'..');
 const viewer=fs.readFileSync(path.join(root,'public/aivid-native-studio.html'),'utf8');
 const ps=fs.readFileSync(path.join(root,'scripts/aivid-native-host','CMMTools-Remote.ps1'),'utf8');
 assert.match(viewer,/requestFullscreen/);
 assert.match(viewer,/Actual size/);
 assert.match(viewer,/addEventListener\('keydown'/);
 assert.match(viewer,/lastInputStatus/);
 assert.match(viewer,/await decoder\.decode\(\)/);
 assert.match(ps,/Math\]::Min\(1600,\$width\)/);
 assert.match(ps,/Send-HostRequest 'ack'/);
 assert.match(ps,/Get-WebViewport/);
});
test('Viewer is authenticated; non-approved viewers and cross-site input are rejected',async()=>{
 x.stop();
 let res=await ask('GET','/api/aivid-native/status');
 assert.equal(res.status,200);assert.equal(json(res).ok,true);
 res=await ask('GET','/api/aivid-native/status',null,{loadSettings:async()=>({...policy,enabled:false})});
 assert.equal(res.status,403);
 res=await ask('GET','/aivid-interactive-studio',null,{requireUser:async()=>{throw Object.assign(new Error('Login'),{statusCode:401});}});
 assert.equal(res.status,401);
 res=await ask('POST','/api/aivid-native/input',{action:'click',x:50,y:50},{},{origin:'https://attacker.example'});
 assert.equal(res.status,403);
 res=await ask('POST','/api/aivid-native/input',{action:'key',key:'Ctrl+L'});
 assert.equal(res.status,503); // no host, command never reaches Windows
});
test('Host pairing uses config-enabled state, must have Admin pairing code and rejects bearer impersonation',async()=>{
 x.stop();
 let res=await ask('POST','/api/aivid-native/host/pair',{code:'0'.repeat(32)},{loadSettings:async()=>({...policy,enabled:false})});
 assert.equal(res.status,403);
 res=await ask('POST','/api/aivid-native/host/pair',{code:'0'.repeat(32)});
 assert.equal(res.status,403);
 res=await ask('GET','/api/aivid-native/host/next');
 assert.equal(res.status,403);
 x.stop();
});
test('Native host script contains no Playwright, CDP, browser debugging or exposed desktop stream',()=>{
 const root=path.join(__dirname,'..');
 const ps=fs.readFileSync(path.join(root,'scripts','aivid-native-host','CMMTools-Remote.ps1'),'utf8');
 const viewer=fs.readFileSync(path.join(root,'public','aivid-native-studio.html'),'utf8');
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.doesNotMatch(ps,/require\(['"]playwright|chromium\.launch|connectOverCDP|chrome\.debugger|executeScript\(/);
 assert.match(ps,/CMMWindowsBrowser/);
 assert.match(ps,/Get-WebViewport/);
 assert.match(ps,/AutomationElement/);
 assert.match(ps,/GetForegroundWindow/);
 assert.doesNotMatch(ps,/GetWindowDC|GetDesktopWindow|CopyFromScreen\(0,0/);
 assert.match(server,/src\/aivid_native_desktop\.js/);
 assert.match(viewer,/aivid-native\/input/);
 assert.match(viewer,/Interactive Premium Studio/);
});

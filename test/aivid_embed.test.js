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

test('Live Studio supports a private file chooser and video download bridge without collecting credentials',async()=>{
 const {state,uploadToChooser,captureDownload,stop}=require('../src/aivid_embed.js');
 const cdpEvents={},sent=[],pageEvents={};const attributes=new Map();
 const input={tagName:'INPUT',type:'file',
   setAttribute:(k,v)=>attributes.set(k,v),getAttribute:k=>attributes.get(k),removeAttribute:k=>attributes.delete(k)};
 const element={evaluate:async(fn,arg)=>fn(input,arg)};
 const page={url:()=> 'https://aivid.dev/',on:(name,fn)=>{pageEvents[name]=fn;},
   addInitScript:async()=>{},goto:async()=>{},addStyleTag:async()=>{}};
 const cdp={on:(name,fn)=>{cdpEvents[name]=fn;},
   send:async(name,args)=>{
     sent.push({name,args});
     if(name==='Browserless.setDownloadEnabled')return{ok:true,enabled:true};
     if(name==='Browserless.liveURL')return {liveURL:'https://production-sfo.browserless.io/live/test',timeout:600000,error:null};
     if(name==='Browserless.uploadFile')return {ok:true};
     throw Error('Unknown CDP command '+name);
   },
   detach:async()=>{}};
 let pages;const context={on:()=>{},newPage:async()=>page,newCDPSession:async()=>cdp};
 const browser={newContext:async()=>context,close:async()=>{}};
 const user={id:200,email:'remote@example.com'};
 const env={AIVID_LIVE_VIEW_ENABLED:'true',AIVID_LIVE_VIEW_ALLOWED_IDS:'200',
   AIVID_LIVE_VIEW_DIRECT_BILLING_ACK:'true',
   AIVID_LIVE_VIEW_BROWSERLESS_WS:'wss://production-sfo.browserless.io?token=test'};
 const {start}=require('../src/aivid_embed.js');
 const begun=await start(user,{env,connect:async()=>browser});
 assert.equal(new URL(begun.liveURL).hostname,'production-sfo.browserless.io');
 assert.equal(sent.find(x=>x.name==='Browserless.liveURL').args.mode,'follow',
  'Popup navigation is required for Google sign-in attempts');
 assert.equal(sent.find(x=>x.name==='Browserless.liveURL').args.showBrowserInterface,true);
 assert.equal(sent.find(x=>x.name==='Browserless.setDownloadEnabled').args.enabled,true);
 const s={context,pendingUpload:null,uploading:false,downloads:new Map(),downloadsEnabled:true,expires:Date.now()+60000,notice:''};
 const chooser={page:()=>page,element:async()=>element};
 s.pendingUpload={chooser,expires:Date.now()+60000};
 assert.equal(state(s).uploadPending,true);
 const image=Buffer.from([0x89,0x50,0x4e,0x47]);
 await uploadToChooser(s,[{name:'photo.png',mimeType:'image/png',data:image}]);
 const upload=sent.find(x=>x.name==='Browserless.uploadFile');
 assert.match(upload.args.selector,/data-cmm-live-upload/);
 assert.equal(upload.args.files[0].content,image.toString('base64'));
 assert.equal(s.pendingUpload,null);
 assert.equal(attributes.size,0,'temporary remote DOM tag cleaned up');
 assert.equal(state(s).uploadPending,false);
 const mp4=Buffer.alloc(14);mp4.write('ftyp',4);
 assert.equal(captureDownload(s,{filename:'output.mp4',size:mp4.length,data:mp4.toString('base64')}),true);
 assert.equal(state(s).downloads[0].name,'output.mp4');
 assert.equal(captureDownload(s,{filename:'secret.html',size:mp4.length,data:mp4.toString('base64')}),false);
 assert.equal(captureDownload(s,{filename:'video.mp4',size:70*1024*1024,data:'x'.repeat(12)}),false);
 await stop(user.id);
});
test('File validation only permits expected reference media extensions and nonempty bytes',()=>{
 const {validFile}=require('../src/aivid_embed.js');
 assert.equal(validFile({name:'frame.png',mimeType:'image/png',data:Buffer.from([137])}).mimeType,'image/png');
 assert.throws(()=>validFile({name:'script.svg',mimeType:'image/svg+xml',data:Buffer.from([1])}),/Choose/);
 assert.throws(()=>validFile({name:'clip.mp4',mimeType:'text/html',data:Buffer.from([1])}),/match/);
 assert.throws(()=>validFile({name:'clip.mp4',mimeType:'video/mp4',data:Buffer.alloc(0)}),/Empty/);
});
test('Multipart reference uploads are parsed from the actual HTTP stream',async()=>{
 const {PassThrough}=require('node:stream');
 const {parseUploads}=require('../src/aivid_embed.js');
 const boundary='----cmm-live-test-boundary';
 const body=Buffer.concat([
  Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="reference"; filename="frame.png"\r\nContent-Type: image/png\r\n\r\n'),
  Buffer.from([137,80,78,71,13,10,26,10]),
  Buffer.from('\r\n--'+boundary+'--\r\n'),
 ]);
 const req=new PassThrough();
 req.headers={'content-type':'multipart/form-data; boundary='+boundary,'content-length':String(body.length)};
 const promise=parseUploads(req);req.end(body);
 const uploaded=await promise;
 assert.equal(uploaded.length,1);
 assert.equal(uploaded[0].name,'frame.png');
 assert.equal(uploaded[0].mimeType,'image/png');
 assert.deepEqual(uploaded[0].data,Buffer.from([137,80,78,71,13,10,26,10]));
});

test('Unapproved users and cross-site upload requests remain denied',async()=>{
 const {handle}=require('../src/aivid_embed.js');
 const previous=process.env.AIVID_LIVE_VIEW_ENABLED;
 const previousIds=process.env.AIVID_LIVE_VIEW_ALLOWED_IDS;
 process.env.AIVID_LIVE_VIEW_ENABLED='true';
 process.env.AIVID_LIVE_VIEW_ALLOWED_IDS='123';
 try{
  function response(){return{status:null,data:'',writeHead(status){this.status=status;},end(data){this.data=String(data||'');}}}
  const denied=response();
  await handle({headers:{origin:'https://cmmtools.site',host:'cmmtools.site'},method:'POST'},denied,'/api/aivid-live-studio/upload',
    {requireDatabase:()=>{},requireUser:async()=>({id:456,email:'user@example.com'})});
  assert.equal(denied.status,403);
  const cross=response();
  await handle({headers:{origin:'https://evil.example',host:'cmmtools.site'},method:'POST'},cross,'/api/aivid-live-studio/upload',
    {requireDatabase:()=>{},requireUser:async()=>({id:123,email:'user@example.com'})});
  assert.equal(cross.status,403);
 }finally{
  if(previous===undefined)delete process.env.AIVID_LIVE_VIEW_ENABLED;
  else process.env.AIVID_LIVE_VIEW_ENABLED=previous;
  if(previousIds===undefined)delete process.env.AIVID_LIVE_VIEW_ALLOWED_IDS;
  else process.env.AIVID_LIVE_VIEW_ALLOWED_IDS=previousIds;
 }
});
test('Embedded Studio explains Google login limitations and contains local file upload and video download controls',()=>{
 const fs=require('node:fs');
 const html=fs.readFileSync(require.resolve('../public/aivid-live-studio.html'),'utf8');
 assert.match(html,/href="https:\/\/aivid\.dev\/" target="_blank" rel="noopener noreferrer"/);
 assert.match(html,/Google may block sign-in/);
 assert.match(html,/id="referenceFiles" type="file" multiple/);
 assert.match(html,/id="downloadArea" hidden/);
 assert.match(html,/\/api\/aivid-live-studio\/upload/);
 assert.match(html,/\/api\/aivid-live-studio\/download\//);
});

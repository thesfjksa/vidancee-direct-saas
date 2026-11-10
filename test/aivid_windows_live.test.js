'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {enabled,allowed,authorized,validateUpload,validateAction,handle}=require('../src/aivid_windows_live.js');
const {WindowsLive,allowedUrl}=require('../scripts/aivid-rdp/native.cjs');
const {runtime}=require('../src/aivid_runtime.js');
const {validateManifest}=require('../scripts/aivid-rdp/worker.cjs');

const settings={
  AIVID_WINDOWS_VIEW_ENABLED:'true',
  AIVID_WINDOWS_VIEW_ALLOWED_IDS:'42',
  AIVID_WINDOWS_VIEW_DIRECT_BILLING_ACK:'true',
};
async function env(value,run){
  const before=Object.fromEntries(Object.keys(value).map(k=>[k,process.env[k]]));
  try{for(const [key,v]of Object.entries(value))if(v===undefined)delete process.env[key];else process.env[key]=v;return await run();}
  finally{for(const [key,v]of Object.entries(before))if(v===undefined)delete process.env[key];else process.env[key]=v;}
}
test('Windows-only feature is disabled until the owner selects allowed customer and acknowledges direct source billing',async()=>{
  await env({AIVID_WINDOWS_VIEW_ENABLED:undefined,AIVID_WINDOWS_VIEW_ALLOWED_IDS:undefined,
    AIVID_WINDOWS_VIEW_ALLOWED_EMAILS:undefined,AIVID_WINDOWS_VIEW_DIRECT_BILLING_ACK:undefined},()=>{
    assert.equal(enabled(),false);
    assert.equal(allowed({id:42}),false);
  });
  await env(settings,()=>{
    assert.equal(allowed({id:42,email:'test@example.com'}),true);
    assert.equal(allowed({id:84,email:'other@example.com'}),false);
    assert.equal(authorized({id:42}),true);
  });
  await env({...settings,AIVID_WINDOWS_VIEW_DIRECT_BILLING_ACK:'false'},()=>{
    assert.throws(()=>authorized({id:42}),/bills the provider account directly/);
  });
});
test('Windows browser actions permit only safe coordinates, typed text and simple keys',()=>{
  assert.deepEqual(validateAction({action:'click',x:1280,y:760}),{action:'click',x:1280,y:760});
  assert.deepEqual(validateAction({action:'type',text:'hello @ google.com'}),{action:'type',text:'hello @ google.com'});
  assert.deepEqual(validateAction({action:'key',key:'Enter'}),{action:'key',key:'Enter'});
  assert.throws(()=>validateAction({action:'secret',ciphertext:'cleartext-password'}),/encrypted password/);
  const ciphertext=Buffer.alloc(256,7).toString('base64');
  assert.deepEqual(validateAction({action:'secret',ciphertext}),{action:'secret',ciphertext});
  assert.throws(()=>validateAction({action:'click',x:-1,y:5}),/outside/);
  assert.throws(()=>validateAction({action:'click',x:5.4,y:1}),/outside/);
  assert.throws(()=>validateAction({action:'key',key:'Control+O'}),/Unrestricted/);
  assert.throws(()=>validateAction({action:'key',key:'Control+Shift+I'}),/Unrestricted/);
  assert.throws(()=>validateAction({action:'navigate',url:'file:///C:/Users'}),/Unsupported/);
  assert.throws(()=>validateAction({action:'type',text:'A'.repeat(3001)}),/3,000/);
  assert.throws(()=>validateAction({action:'type',text:'abc\x01xyz'}),/printable/);
});
test('File references have extension/size restrictions and path stripping',()=>{
  const image=Buffer.from('test image');
  assert.deepEqual(validateUpload('../private/fun.png',image),{
    name:'fun.png',mime:'image/png',size:image.length,
    sha256:require('node:crypto').createHash('sha256').update(image).digest('hex')
  });
  assert.throws(()=>validateUpload('evil.exe',image),/one image/);
  assert.throws(()=>validateUpload('big.mp4',Buffer.alloc(30*1024*1024+1)),/at most 30/);
});
test('Paired Edge browser limits document navigation to AIVID and Google, never Windows private addresses',()=>{
  for(const url of ['https://aivid.dev/','https://accounts.google.com/signin','https://sub.aivid.dev/foo']){
    assert.equal(allowedUrl(url,true),true,url);
  }
  for(const url of ['file:///C:/Windows','http://localhost:1234/','http://169.254.169.254/latest',
    'https://127.0.0.1/','https://100.100.100.100/','https://evil.example/']){
    assert.equal(allowedUrl(url,true),false,url);
  }
  assert.equal(allowedUrl('https://cdn.example.com/assets/video.mp4',false),true);
});
test('Existing Windows worker can auto-update without replacing its six-file managed manifest',()=>{
  const r=runtime();
  assert.equal(validateManifest(r.manifest).files.length,6);
  assert.equal(r.manifest.files.some(f=>f.path==='native.cjs'),true);
  assert.equal(r.manifest.files.some(f=>f.path==='live.cjs'),false);
});
test('Windows Edge view is restricted to one customer and a dedicated profile, never the automated agent profile',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cmm-live-test-'));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  class MockPage extends EventEmitter{
    constructor(){super();this.isPassword=false;this.inserted='';this.mouse={click:async()=>{}};
      this.keyboard={insertText:async text=>{this.inserted=text;},press:async()=>{}};}
    async evaluate(){return this.isPassword;}
    isClosed(){return false;}url(){return 'https://aivid.dev/';}
    async screenshot(){return Buffer.from([0xff,0xd8,0xff,0xd9]);}
    async goto(){}async close(){this.emit('close');}
  }
  class MockContext extends EventEmitter{
    constructor(){super();this.p=new MockPage();this.closed=false;}
    pages(){return [this.p];}async route(){}async newPage(){return this.p;}
    async close(){this.closed=true;}
  }
  const contexts=[];let profile='';
  const session=new WindowsLive({root:folder,launch:async dir=>{
    profile=dir;const c=new MockContext();contexts.push(c);return c;
  }});
  const first=await session.run({owner:'42',action:'open'});
  assert.equal(first.state,'frame');
  assert.match(first.secretKey,/^[A-Za-z0-9+/]+=*$/);
  const pem=Buffer.from(first.secretKey,'base64').toString('utf8');
  const secret= require('node:crypto').publicEncrypt({key:pem,oaepHash:'sha256'},Buffer.from('test-private-password')).toString('base64');
  contexts[0].p.isPassword=true;
  await assert.rejects(session.run({owner:'42',action:'type',text:'unsafe-cleartext'}),/Type password securely/);
  await session.run({owner:'42',action:'secret',ciphertext:secret});
  assert.equal(contexts[0].p.inserted,'test-private-password');
  contexts[0].p.isPassword=false;
  assert.match(profile,/\.aivid-live-profile-u42$/);
  assert.doesNotMatch(profile,/\.aivid-rdp-edge-profile/);
  await assert.rejects(session.run({owner:'43',action:'open'}),/Another isolated Premium browser/);
  const chooser={setInputFiles:async file=>{
    assert.equal(file.name,'ref.png');assert.equal(file.mimeType,'image/png');assert.equal(file.data.toString(),'png');
  }};
  contexts[0].p.emit('filechooser',chooser);
  const result=await session.run({owner:'42',action:'upload',name:'ref.png',mime:'image/png'},Buffer.from('png'));
  assert.equal(result.uploadPending,false);
  const closed=await session.run({owner:'42',action:'close'});
  assert.equal(closed.state,'frame');
  assert.equal(contexts[0].closed,true);
});
function response(){
  const res={status:null,headers:null,body:null};
  return {...res,writeHead(status,headers){this.status=status;this.headers=headers;},
    end(body){this.body=body;}};
}
test('Windows browser page and controls stay behind CMMTools login, source access and same-origin POST',async()=>{
  await env(settings,async()=>{
    const handlers={requireDatabase:()=>{},requireUser:async()=>({id:42,email:'test@example.com'}),
      checkSourceAccess:async()=>true,
      runner:async(_user,action)=>({state:'frame',jpeg:'',url:'https://aivid.dev/',
        notice:action.action,fileName:'',uploadPending:false,downloadReady:false})};
    let r=response();
    assert.equal(await handle({method:'GET',headers:{}},r,'/aivid-live-studio',handlers),true);
    assert.equal(r.status,200);
    assert.match(r.body,/Windows Premium Studio/);
    assert.match(r.headers['content-security-policy'],/img-src data:/);
    assert.doesNotMatch(r.body,/__CMM_NONCE__/);
    const req=async function*(text){yield Buffer.from(text);};
    r=response();
    await handle(Object.assign(req(JSON.stringify({action:'frame'})),{
      method:'POST',headers:{host:'cmmtools.site',origin:'https://attacker.example'}
    }),r,'/api/windows-studio/action',handlers);
    assert.equal(r.status,403);
    r=response();
    await handle(Object.assign(req(JSON.stringify({action:'frame'})),{
      method:'POST',headers:{host:'cmmtools.site',origin:'https://cmmtools.site'}
    }),r,'/api/windows-studio/action',handlers);
    assert.equal(r.status,200);
    assert.equal(JSON.parse(r.body).state,'frame');
    r=response();
    await handle({method:'GET',headers:{}},r,'/rdp-studio',{...handlers,checkSourceAccess:async()=>false});
    assert.equal(r.status,403);
  });
});

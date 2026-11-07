'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromeArguments, debuggerEndpoint, takeLock, downloadNative } = require('../native.cjs');
const { origin, Transport, loadConfig, saveConfig, readPairingInput } = require('../agent.cjs');
const { Readable } = require('node:stream');
test('Windows dialog pairing input is bounded, validated and never included in errors', async () => {
  const code = 'aabbccddeeff001122334455';
  assert.deepEqual(await readPairingInput(Readable.from(['https://cmmtools.site\r\n', code + '\r\n'])),
    { origin: 'https://cmmtools.site', code: code.toUpperCase() });
  for (const input of ['https://cmmtools.site\nwrong', 'https://cmmtools.site\n' + code + '\nextra', 'x'.repeat(4097)])
    await assert.rejects(readPairingInput(Readable.from([input])), error => { assert.doesNotMatch(error.message, new RegExp(code)); return true; });
  await assert.rejects(readPairingInput(Readable.from(['http://cmmtools.site\n' + code])), /HTTPS/);
});
test('manual login has no automation or debugging flags; automation binds only to loopback', () => {
  const login = chromeArguments('./private-profile');
  assert.doesNotMatch(login.join(' '), /debugging|enable-automation|no-sandbox|disable-web-security|remote-allow-origins/);
  const agent = chromeArguments('./private-profile', true);
  assert.ok(agent.includes('--remote-debugging-address=127.0.0.1')); assert.ok(agent.includes('--remote-debugging-port=0'));
  assert.doesNotMatch(agent.join(' '), /0\.0\.0\.0|enable-automation|no-sandbox|disable-web-security|remote-allow-origins/);
});
test('debugging discovery rejects a non-local or mismatched browser', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-endpoint-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'DevToolsActivePort'), '45678\n/devtools/browser/abc-123\n');
  for (const url of ['ws://evil.test:45678/devtools/browser/abc-123', 'ws://127.0.0.1:45678/devtools/browser/other', 'wss://127.0.0.1:45678/devtools/browser/abc-123'])
    assert.equal(await debuggerEndpoint(root, async () => Response.json({ webSocketDebuggerUrl: url })), null);
  assert.equal(await debuggerEndpoint(root, async () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/browser/abc-123' })), 'ws://127.0.0.1:45678/devtools/browser/abc-123');
});
test('one agent owns the profile, and credentials remain encrypted and origin-bound', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-config-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const release = await takeLock(root); await assert.rejects(takeLock(root), /already running/); await release();
  const codec = async (mode, value) => mode === 'protect' ? Buffer.from(value).toString('base64') : Buffer.from(value, 'base64').toString();
  const token = 'a'.repeat(64);
  await saveConfig(root, { origin: 'https://cmmtools.site', token }, codec);
  assert.doesNotMatch(await fs.readFile(path.join(root, '.aivid-agent.json'), 'utf8'), new RegExp(token));
  assert.equal((await loadConfig(root, codec)).token, token);
  const record = JSON.parse(await fs.readFile(path.join(root, '.aivid-agent.json'), 'utf8')); record.origin = 'https://other.example';
  await fs.writeFile(path.join(root, '.aivid-agent.json'), JSON.stringify(record));
  await assert.rejects(loadConfig(root, codec), /configuration changed/);
});
test('agent sends credentials only in the authorization header and refuses redirects', async () => {
  for (const url of ['http://cmmtools.site', 'https://user:password@cmmtools.site', 'https://cmmtools.site/path', 'https://cmmtools.site/?token=x']) assert.throws(() => origin(url));
  let seen;
  const token = 'b'.repeat(64);
  const client = new Transport('https://cmmtools.site', token, async (url, options) => { seen = { url, options }; return Response.json({ ok: true }); });
  await client.request('/poll', { body: { status: 'ready' } });
  assert.equal(seen.options.headers.authorization, 'Bearer ' + token); assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.url.includes(token), false); assert.equal(seen.options.body.includes(token), false);
});
test('native download validates the MP4 header and deletes only its temporary download', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-download-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'clip.mp4'), data = Buffer.from('0000ftypisom0000'); await fs.writeFile(file, data);
  let deleted = 0;
  const download = { failure: async () => null, path: async () => file, delete: async () => { deleted++; } };
  const page = { waitForEvent: async () => download, getByRole: () => ({ click: async () => {} }) };
  assert.deepEqual((await downloadNative(page)).data, data); assert.equal(deleted, 1);
  await fs.writeFile(file, 'not a video file');
  await assert.rejects(downloadNative(page), /valid MP4/); assert.equal(deleted, 2);
});

test('job-specific errors leave the agent available for the next poll',async t=>{
  const {Agent}=require('../agent.cjs');
  for(const kind of ['collect','preflight']){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'aivid-collect-retry-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const statuses=[];let issued=false,reports=0,agent;
    const transport={request:async(route,options)=>{
      if(route==='/poll'){
        const status=options.body.status;statuses.push(status);
        if(status==='starting')return{command:null};
        if(!issued){issued=true;return{command:{id:'fixture-command',kind,payload:{},expiresAt:Date.now()+60000}};}
        agent.stopping=true;return{command:null};
      }
      if(route.endsWith('/result')){reports++;assert.equal(options.body.error,true);return{saved:true};}
      throw new Error('Unexpected fixture request');
    }};
    agent=new Agent({root,transport,pause:async()=>{},clientFactory:()=>({preflight:async()=>({ready:true})})});
    agent.execute=async()=>{throw new Error('Temporary video detail/download failure')};
    await agent.run();assert.equal(reports,1);
    assert.equal(statuses.at(-1),'ready');
  }
});
test('download security warnings stop collection without clicking through the warning',async()=>{
 const {EventEmitter}=require('node:events');const {securityWarning}=require('../native.cjs');
 assert.equal(securityWarning('Safety warning','Did you mean aivid.dev? The site looks fake.'),true);
 assert.equal(securityWarning('Video Detail','The prompt says did you mean'),false);
 const context=new EventEmitter(),page=new EventEmitter();let clicks=0;
 page.context=()=>context;page.waitForEvent=()=>new Promise(()=>{});
 const popup={opener:async()=>page,waitForLoadState:async()=>{},title:async()=> 'Safety warning',locator:()=>({innerText:async()=> 'Did you mean aivid.dev? The site looks fake.'})};
 page.getByRole=()=>({click:async()=>{clicks++;context.emit('page',popup)}});
 await assert.rejects(downloadNative(page),e=>e.aividCode==='download_security');
 assert.equal(clicks,1);assert.equal(context.listenerCount('page'),0);
});

test('inline media URL is pinned to the observed source storage host and exact job',()=>{
 const {inlineVideoUrl}=require('../native.cjs'),id='6aee348c6467353c0fd7ded1';
 const good='https://aivid-dev.ea27a69da769d04e04a51faf6bcc2f00.r2.cloudflarestorage.com/generating/123-123-'+id+'.mp4?X-Amz-Signature=fixture';
 assert.equal(inlineVideoUrl(good,id),good);
 const distinctAsset=good.replace(id,'other-asset-id');
 assert.equal(inlineVideoUrl(distinctAsset,id),null);
 assert.equal(inlineVideoUrl(distinctAsset,id,{jobVerified:true}),distinctAsset);
 for(const bad of [good.replace('https:','http:'),good.replace('/generating/','/other/'),good.replace('.com/','.com.evil.test/'),good.replace('https://','https://user:pass@'),good+'#fragment',good.replace('.com/','.com:444/')]){
  assert.equal(inlineVideoUrl(bad,id),null);
  assert.equal(inlineVideoUrl(bad,id,{jobVerified:true}),null);
 }
 assert.equal(inlineVideoUrl(good,null),null);
});
test('inline transfer enforces status, type, complete bounded body and MP4 signature',async()=>{
 const {readInlineVideo}=require('../native.cjs'),clip=Buffer.from('0000ftypisom0000');let options;
 assert.deepEqual((await readInlineVideo('https://fixture.test/clip',{fetchImpl:async(url,opts)=>{options=opts;return new Response(clip,{headers:{'content-type':'video/mp4','content-length':String(clip.length)}})}})).data,clip);
 assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers,undefined);
 for(const response of [new Response(clip,{status:403}),new Response(clip,{status:206,headers:{'content-type':'video/mp4'}}),new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}}),new Response('not valid video',{headers:{'content-type':'video/mp4'}}),new Response(clip,{headers:{'content-type':'video/mp4','content-length':'200'}}),new Response(clip,{headers:{'content-type':'video/mp4','content-length':String(100*1024*1024+1)}})])await assert.rejects(readInlineVideo('https://fixture.test/clip',{fetchImpl:async()=>response}));
});
test('media delivery failures are retryable while invalid files stay rejected',async()=>{
 const {readInlineVideo}=require('../native.cjs'),url='https://fixture.test/clip',clip=Buffer.from('0000ftypisom0000');
 for(const status of [403,404,408,425,429,500,503]){
  await assert.rejects(readInlineVideo(url,{fetchImpl:async()=>new Response(null,{status})}),{aividCode:'collection_media_pending'});
 }
 await assert.rejects(readInlineVideo(url,{fetchImpl:async()=>{throw Error('connection interrupted');}}),{aividCode:'collection_media_pending'});
 await assert.rejects(readInlineVideo(url,{fetchImpl:async()=>new Response(clip,{headers:{'content-type':'video/mp4','content-length':'200'}})}),{aividCode:'collection_media_pending'});
 await assert.rejects(readInlineVideo(url,{fetchImpl:async()=>new Response('<html>error</html>',{headers:{'content-type':'video/mp4'}})}),/Invalid MP4/);
});
test('inline popup completes without a download event and closes only the owned media tab',async()=>{
 const {EventEmitter}=require('node:events'),context=new EventEmitter(),page=new EventEmitter(),popup=new EventEmitter();
 const id='6aee348c6467353c0fd7ded1',url='https://aivid-dev.ea27a69da769d04e04a51faf6bcc2f00.r2.cloudflarestorage.com/generating/123-'+id+'.mp4?X-Amz-Signature=fixture',clip=Buffer.from('0000ftypisom0000');let closed=0,fetches=0;
 page.url=()=> 'https://aivid.dev/videos/another-accepted-job';page.context=()=>context;
 popup.opener=async()=>page;popup.waitForLoadState=async()=>{};popup.title=async()=>'';popup.url=()=>url;popup.close=async()=>{closed++};
 popup.locator=selector=>selector==='body'?{innerText:async()=>''}:{first:()=>({evaluate:async()=>url})};
 page.getByRole=()=>({click:async()=>{context.emit('page',popup)}});
 const output=await downloadNative(page,{timeoutMs:1000,fetchImpl:async u=>{assert.equal(u,url);fetches++;return new Response(clip,{headers:{'content-type':'video/mp4'}})}});
 assert.deepEqual(output.data,clip);assert.equal(fetches,1);assert.equal(closed,1);
 assert.equal(context.listenerCount('page'),0);assert.equal(page.listenerCount('download'),0);assert.equal(popup.listenerCount('domcontentloaded'),0);
});
test('a warning or unrelated popup never triggers an inline HTTP request',async()=>{
 const {EventEmitter}=require('node:events');
 for(const warning of [true,false]){
  const context=new EventEmitter(),page=new EventEmitter(),popup=new EventEmitter();let fetches=0,closed=0;
  page.url=()=> 'https://aivid.dev/videos/6aee348c6467353c0fd7ded1';page.context=()=>context;
  popup.opener=async()=>warning?page:null;popup.waitForLoadState=async()=>{};popup.title=async()=> 'Safety warning';popup.url=()=> 'https://aivid-dev.ea27a69da769d04e04a51faf6bcc2f00.r2.cloudflarestorage.com/generating/123-6aee348c6467353c0fd7ded1.mp4';
  popup.locator=()=>({innerText:async()=> 'Did you mean aivid.dev? The site looks fake.'});popup.close=async()=>{closed++};
  page.getByRole=()=>({click:async()=>context.emit('page',popup)});
  await assert.rejects(downloadNative(page,{timeoutMs:25,fetchImpl:async()=>{fetches++;throw Error('must not fetch')}}),warning?e=>e.aividCode==='download_security':/valid MP4/);
  assert.equal(fetches,0);assert.equal(closed,0);
 }
});

test('connection and update outages reconnect without repeating an accepted operation',async t=>{
 const {Agent}=require('../agent.cjs');
 const oldRoot=process.env.AIVID_AGENT_ROOT,oldVersion=process.env.AIVID_RUNTIME_VERSION;
 process.env.AIVID_AGENT_ROOT='fixture';process.env.AIVID_RUNTIME_VERSION='fixture-version';
 t.after(()=>{for(const [k,v] of [['AIVID_AGENT_ROOT',oldRoot],['AIVID_RUNTIME_VERSION',oldVersion]])if(v===undefined)delete process.env[k];else process.env[k]=v;});
 for(const failure of ['startup','update','poll','unauthorized-update']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aivid-reconnect-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let agent,failed=false,checks=0,executions=0,pauses=0,updates=0,readyPolls=0;
  const transport={request:async(route,options)=>{
   if(route==='/runtime'){
    updates++;
    if(failure==='unauthorized-update')throw Object.assign(Error('rejected'),{statusCode:401});
    if(failure==='update')throw Object.assign(Error('offline'),{network:true});
    return{version:'fixture-version'};
   }
   assert.equal(route,'/poll');
   const status=options.body.status;
   if(!failed&&((failure==='startup'&&status==='starting')||(failure==='poll'&&status==='ready'))){failed=true;throw Object.assign(Error('offline'),{network:true});}
   if(status==='starting')return{command:null};
   readyPolls++;
   if(readyPolls===1)return{command:{id:'existing-result',kind:'collect',payload:{providerJobId:'existing-video'}}};
   agent.stopping=true;return{command:null};
  }};
  agent=new Agent({root,transport,pause:async()=>{pauses++;assert.ok(pauses<5,'reconnect loop must make progress');},clientFactory:()=>({preflight:async()=>{checks++;return{};}})});
  agent.execute=async command=>{assert.equal(command.payload.providerJobId,'existing-video');executions++;};
  if(failure==='unauthorized-update'){await assert.rejects(agent.run(),{statusCode:401});assert.equal(executions,0);}
  else{await agent.run();assert.equal(executions,1);assert.equal(agent.status,'ready');assert.ok(pauses>=1);}
  assert.equal(checks,1);assert.equal(updates,1);
  assert.equal(await fs.stat(path.join(root,'.aivid-agent.lock')).then(()=>true,()=>false),false);
 }
});

test('the agent restores readiness after the browser session recovers', async t => {
  const { Agent } = require('../agent.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aivid-session-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 0, checks = 0;
  const statuses = [];
  const agent = new Agent({
    root,
    now: () => now,
    pause: async () => { now += 30000; },
    transport: { request: async (_route, options) => {
      statuses.push(options.body.status);
      if (options.body.status === 'ready') agent.stopping = true;
      return { command: null };
    } },
    clientFactory: () => ({ preflight: async () => {
      if (++checks === 1) throw Object.assign(new Error('Sign in'), { aividCode: 'session_sign_in' });
    } }),
  });
  await agent.run();
  assert.deepEqual(statuses, ['starting', 'needs_login', 'ready']);
});

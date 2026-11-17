'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../scripts/video-studio-launcher/extension/proxy-core.js');
const {ProxyManager} = require('../scripts/video-studio-launcher/extension/proxy-manager.js');
const endpoint = (label, host, extra = {}) => ({label, host, scheme:'http', port:8080, username:'test-user', password:'test-password', ...extra});
const config = servers => core.normalize({enabled:true, includeDirect:false, directNetworkConfirmed:true, servers});
const event = () => ({listeners:[], addListener(fn) {this.listeners.push(fn);}});
function fixture(conf, fetcher) {
  const data = {proxyConfig:conf};
  let effective = {value:{mode:'system'}, levelOfControl:'controllable_by_this_extension'};
  const writes = [];
  const api = {
    storage:{session:{async get(key) {return {[key]:api.sessionWindowId};}},local:{async get(key) {return {[key]:data[key]};}, async set(value) {Object.assign(data, structuredClone(value));}, async setAccessLevel(value) {api.access=value.accessLevel;}}},
    permissions:{async contains() {return api.granted;}}, granted:true,
    proxy:{settings:{async get() {return effective;}, async set({value,scope}) {assert.equal(scope,'regular_only'); writes.push(structuredClone(value)); effective={value:structuredClone(value),levelOfControl:'controlled_by_this_extension'};}, async clear({scope}) {assert.equal(scope,'regular_only'); api.clears++; effective={value:{mode:'system'},levelOfControl:'controllable_by_this_extension'};}}},
    clears:0, tabs:{async query(query) {assert.deepEqual(query,{url:core.URLS});return api.tabsOpen || [];}}, windows:{async get(id) {if(api.closed) throw Error('No window'); return {id,incognito:false};}},
    webRequest:{onAuthRequired:event(),onCompleted:event(),onErrorOccurred:event()}
  };
  let clock=0;
  const manager = new ProxyManager(api, fetcher || (async () => {clock += 20;return {ok:true};}), () => clock, 20);
  return {manager,api,data,writes,setEffective:value=>{effective=value;},advance:ms=>{clock+=ms;}};
}

test('PAC matches only exact AIVID domain/subdomains and never adds direct fallback for proxy targets', () => {
  const server = config([endpoint('one','proxy.example')]).servers[0];
  const value = core.pac(server);
  const context = {dnsDomainIs:(host,suffix)=>host.endsWith(suffix)};
  vm.createContext(context); vm.runInContext(value.pacScript.data, context);
  assert.equal(value.pacScript.mandatory,true);
  for(const host of ['aivid.dev','api.aivid.dev','AIVID.DEV']) assert.equal(context.FindProxyForURL('https://'+host,host),'PROXY proxy.example:8080');
  for(const host of ['notaivid.dev','aivid.dev.evil.test','google.com','localhost']) assert.equal(context.FindProxyForURL('https://'+host,host),'DIRECT');
});

test('configuration rejects PAC injection, duplicate endpoints, unsupported auth, missing consent and invalid ports', () => {
  for (const bad of [endpoint('x','proxy; DIRECT'),endpoint('x','https://proxy.test'),endpoint('x','proxy.test',{port:0}),endpoint('x','proxy.test',{scheme:'socks5'}),endpoint('x','proxy.test',{username:'bad\nname'})]) assert.throws(()=>config([bad]));
  assert.throws(()=>config([endpoint('x','proxy.test'),endpoint('y','proxy.test')]));
  assert.throws(()=>core.normalize({enabled:true,includeDirect:false,directNetworkConfirmed:false,servers:[endpoint('x','proxy.test')]}));
  assert.throws(()=>config(Array.from({length:6},(_,i)=>endpoint('x','proxy'+i+'.test'))));
});

test('selection measures sequentially, ignores failed routes, rechecks winner and pins it', async () => {
  const conf=config([endpoint('slow','slow.test'),endpoint('failed','failed.test'),endpoint('fast','fast.test')]);
  let f,concurrent=0,peak=0,calls=0;
  f=fixture(conf,async (url,options)=>{
    concurrent++;peak=Math.max(peak,concurrent); calls++;
    assert.match(url,/^https:\/\/aivid\.dev\//); assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    const id=f.data.proxyConnection.serverId;
    await Promise.resolve();concurrent--;
    if(id.includes('failed')) throw Error('a raw secret-bearing network diagnostic');
    f.advance(id.includes('slow')?200:30);return {ok:true};
  });
  const status=await f.manager.prepare(11);
  assert.equal(status.label,'fast'); assert.equal(status.ms,30); assert.equal(status.phase,'active');
  assert.equal(peak,1);assert.equal(calls,6);assert.equal(status.samples.length,3); assert.equal(status.samples[1].ms,null);
  assert.equal(f.writes.length,4); assert.equal(f.writes.at(-1).pacScript.data,core.pac(conf.servers[2]).pacScript.data);
  assert.doesNotMatch(JSON.stringify(status),/test-password|test-user|raw secret/);
  const writes=f.writes.length;await f.manager.prepare(11);assert.equal(f.writes.length,writes,'active session is not retested');
});

test('direct connection is considered only when explicitly included', async () => {
  const conf=config([endpoint('server','proxy.test')]);conf.includeDirect=true;
  let f;f=fixture(conf,async()=>{f.advance(f.data.proxyConnection.serverId?100:10);return {ok:true};});
  const result=await f.manager.prepare(1);assert.equal(result.serverId,null);assert.equal(result.label,'Direct connection');
  const g=fixture(config([endpoint('server','proxy.test')]));const result2=await g.manager.prepare(2);assert.notEqual(result2.serverId,null);
});

test('all failed proxies restore browser defaults and block navigation path', async () => {
  const f=fixture(config([endpoint('server','proxy.test')]),async()=>{throw Error('failed');});
  await assert.rejects(f.manager.prepare(1),/No configured route passed/);
  assert.equal(f.api.clears,1);assert.equal(f.data.proxyConnection.phase,'default');
  assert.ok(f.writes.every(value=>!value.pacScript.data.includes('return "DIRECT";\nreturn')));
});

test('HTTP error responses and deadline failures are excluded', async () => {
  const denied=fixture(config([endpoint('server','proxy.test')]),async()=>({ok:false}));
  await assert.rejects(denied.manager.prepare(1),/No configured route/);
  const f=fixture(config([endpoint('server','proxy.test')]),(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('deadline')))));
  await assert.rejects(f.manager.prepare(1),/No configured route/);assert.equal(f.api.clears,1);
});

test('credentials go only to exact configured proxy challenge once per request, never website auth', async () => {
  const conf=config([endpoint('server','proxy.test')]), f=fixture(conf);
  await f.manager.setState({phase:'active',serverId:conf.servers[0].id});
  const challenge={isProxy:true,url:'https://aivid.dev/',challenger:{host:'proxy.test',port:8080},requestId:'one'};
  for(const changes of [{isProxy:false},{url:'https://other.test/'},{challenger:{host:'attacker.test',port:8080}},{challenger:{host:'proxy.test',port:8081}}]) assert.deepEqual(await f.manager.authenticate({...challenge,...changes}),{});
  assert.deepEqual(await f.manager.authenticate(challenge),{authCredentials:{username:'test-user',password:'test-password'}});
  assert.deepEqual(await f.manager.authenticate(challenge),{cancel:true});
  f.manager.registerAuth();f.api.webRequest.onCompleted.listeners[0]({requestId:'one'});
  assert.equal(f.manager.attempts.size,0);
});

test('other proxy controllers, existing fixed proxies and open AIVID tabs are left alone', async () => {
  for(const effective of [{value:{mode:'system'},levelOfControl:'controlled_by_other_extensions'},{value:{mode:'fixed_servers'},levelOfControl:'controllable_by_this_extension'},{value:{mode:'system'},levelOfControl:'not_controllable'}]) {
    const f=fixture(config([endpoint('server','proxy.test')]));f.setEffective(effective);
    await assert.rejects(f.manager.prepare(1),/existing proxy or policy/);assert.equal(f.writes.length,0);assert.equal(f.api.clears,0);
  }
  const f=fixture(config([endpoint('server','proxy.test')]));f.api.tabsOpen=[{id:9}];
  await assert.rejects(f.manager.prepare(1),/Close all AIVID tabs/);assert.equal(f.writes.length,0);
});

test('denied optional permissions and disabled feature never change browser routing', async () => {
  const f=fixture(config([endpoint('server','proxy.test')]));f.api.granted=false;
  await assert.rejects(f.manager.prepare(1),/allow proxy permissions/);assert.equal(f.writes.length,0);
  const g=fixture({enabled:false,includeDirect:false,directNetworkConfirmed:false,servers:[]});
  assert.equal((await g.manager.prepare(1)).phase,'default');assert.equal(g.writes.length,0);
});

test('closing during a slow check cancels it and clears routing, without selecting another server', async () => {
  let started;
  const seen=new Promise(resolve=>{started=resolve;});
  const f=fixture(config([endpoint('one','one.test'),endpoint('two','two.test')]),(_url,{signal})=>new Promise((_resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(Error('cancelled')));}));
  const pending=f.manager.prepare(1);await seen;const done=f.manager.disconnect();
  await assert.rejects(pending,/cancelled/i);await done;
  assert.equal(f.writes.length,1);assert.equal(f.data.proxyConnection.phase,'default');
});

test('startup clears stale routes and restricts stored credentials to trusted extension contexts', async () => {
  const f=fixture(config([endpoint('one','one.test')]));await f.manager.setState({phase:'testing',windowId:1});
  await f.manager.initialize();assert.equal(f.api.access,'TRUSTED_CONTEXTS');assert.equal(f.api.clears,1);assert.equal(f.data.proxyConnection.phase,'default');
});

test('saving settings while Studio is live is rejected before persisting or changing routes', async () => {
  const conf=config([endpoint('one','one.test')]), f=fixture(conf);await f.manager.setState({phase:'active',windowId:1});
  await assert.rejects(f.manager.save({...conf,servers:[]}),/Close the Studio/);assert.equal(f.api.clears,0);assert.equal(f.data.proxyConfig,conf);
});

test('manifest uses optional proxy permissions and bounded AIVID site access', () => {
  const p=path.join(__dirname,'../scripts/video-studio-launcher/extension');
  const manifest=JSON.parse(fs.readFileSync(path.join(p,'manifest.json'),'utf8'));
  assert.equal(manifest.version,'1.7.0');assert.deepEqual(manifest.permissions,['storage']);
  assert.deepEqual(manifest.optional_permissions,core.PERMISSIONS);assert.deepEqual(manifest.host_permissions,core.URLS);
  assert.ok(manifest.content_scripts[0].js.includes('connection-badge.js'));
  assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
});

function backgroundFixture(failing = false) {
  const messages = event(), external = event(), removed = event();
  const session = {};const calls=[];
  const chrome = {
    runtime:{getURL:file=>'chrome-extension://test/'+file,onMessage:messages,onMessageExternal:external,async openOptionsPage() {calls.push('options');}},
    storage:{session:{async get(key){return {[key]:session[key]};},async set(value){Object.assign(session,value);},async remove(key){delete session[key];}}},
    windows:{onRemoved:removed,async create(){calls.push('window');return {id:4};},async update() {calls.push('focus');}},
    tabs:{async get(id){return {id,windowId:4,url:'chrome-extension://test/loading.html'};},async update(){calls.push('navigate');}},
    permissions:{onAdded:event(),onRemoved:event()}
  };
  class Manager {
    async initialize() {}
    async prepare() {calls.push('prepare');if(failing)throw Error('No proxy connected');return {phase:'active',label:'one'};}
    async disconnect() {calls.push('disconnect');}
    async status() {return {phase:'default'};}
    async config() {return {secret:'must stay inside options'};}
    registerAuth() {}
  }
  const context={chrome,CMMProxyManager:Manager,CMMProxyCore:core,CMMManagedProxy:class {async refresh(){} removed(){}},importScripts(){},URL,Promise};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../scripts/video-studio-launcher/extension/background.js'),'utf8'),context);
  return {calls,messages,external,session,removed,send(message,sender) {return new Promise(resolve=>{const handled=messages.listeners[0](message,sender,resolve);if(!handled)resolve({unhandled:true});});}};
}

test('background prepares the route before navigation and rejects content-script credential reads', async () => {
  const f=backgroundFixture();
  await f.send({type:'CMMTOOLS_OPEN_STUDIO'},{url:'chrome-extension://test/launcher.html'});
  assert.equal(f.session.studioWindowId,4);
  const result=await f.send({type:'CMMTOOLS_START_NAVIGATION'},{url:'chrome-extension://test/loading.html',tab:{id:8,windowId:4}});
  assert.equal(result.ok,true);assert.deepEqual(f.calls,['window','prepare','navigate']);
  const denied=await f.send({type:'CMMTOOLS_PROXY_CONFIG'},{url:'https://aivid.dev/'});assert.equal(denied.unhandled,true);
  const config=await f.send({type:'CMMTOOLS_PROXY_CONFIG'},{url:'chrome-extension://test/options.html'});assert.equal(config.ok,true);
  await f.removed.listeners[0](4);await new Promise(resolve=>setImmediate(resolve));assert.ok(f.calls.includes('disconnect'));assert.equal(f.session.studioWindowId,undefined);
});

test('background leaves loading page open on proxy failure and rejects an unverified tab', async () => {
  const f=backgroundFixture(true);
  await f.send({type:'CMMTOOLS_OPEN_STUDIO'},{url:'chrome-extension://test/launcher.html'});
  const failed=await f.send({type:'CMMTOOLS_START_NAVIGATION'},{url:'chrome-extension://test/loading.html',tab:{id:8,windowId:4}});
  assert.equal(failed.ok,false);assert.ok(!f.calls.includes('navigate'));
  const unverified=await f.send({type:'CMMTOOLS_START_NAVIGATION'},{url:'chrome-extension://test/loading.html',tab:{id:8,windowId:9}});
  assert.equal(unverified.ok,false);assert.match(unverified.error,/verified/);
});

test('save persists validated connection settings only after optional permission grant', async () => {
  const f=fixture({enabled:false,includeDirect:false,directNetworkConfirmed:false,servers:[]});
  f.api.granted=false;
  const next={enabled:true,includeDirect:false,directNetworkConfirmed:true,servers:[endpoint('one','one.test')]};
  await assert.rejects(f.manager.save(next),/optional proxy permissions/);assert.equal(f.data.proxyConfig.enabled,false);
  f.api.granted=true;await f.manager.save(next);assert.equal(f.data.proxyConfig.enabled,true);assert.equal(f.data.proxyConfig.servers.length,1);
  await f.manager.save({enabled:false,includeDirect:false,directNetworkConfirmed:false,servers:[]});assert.equal(f.data.proxyConfig.servers.length,0);
});

test('worker restart preserves only an active Studio in this browser session', async () => {
  const conf=config([endpoint('one','one.test')]);
  const f=fixture(conf);await f.manager.setState({phase:'active',windowId:12,serverId:conf.servers[0].id});
  await f.manager.initialize();assert.equal(f.api.clears,1,'new browser session clears persisted route even if a window ID is reused');
  const g=fixture(conf);g.api.sessionWindowId=12;await g.manager.setState({phase:'active',windowId:12,serverId:conf.servers[0].id});
  await g.manager.initialize();assert.equal(g.api.clears,0,'service worker restart keeps a live session pinned');
});

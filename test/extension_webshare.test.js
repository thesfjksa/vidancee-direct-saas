'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../scripts/video-studio-launcher/extension/webshare.js');
const permission = allowed => ({permissions:{async contains(value) {assert.deepEqual(value,{origins:['https://proxy.webshare.io/*']});return allowed;}}});
const row = (index, extra={}) => ({valid:true,proxy_address:'192.0.2.'+index,port:8080,username:'sample-user',password:'sample-password',country_code:'US',...extra});
const response = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});

test('imports five distinct valid Webshare direct endpoints without importing invalid or backbone rows',()=>{
 const data={results:[row(1,{valid:false}),row(2,{proxy_address:null}),row(3,{proxy_address:'bad;DIRECT'}),row(4),row(4),...Array.from({length:8},(_,i)=>row(i+5))]};
 const servers=api.proxiesFromResponse(data);
 assert.equal(servers.length,5);assert.equal(servers[0].host,'192.0.2.4');assert.equal(servers[0].scheme,'http');
 assert.equal(servers[0].username,'sample-user');assert.equal(servers[0].password,'sample-password');
 assert.match(servers[0].label,/Webshare US/);assert.equal(new Set(servers.map(s=>s.id)).size,5);
});

test('uses only the fixed HTTPS read endpoint, header auth and an optional country filter',async()=>{
 let called=0;
 const result=await api.importProxies(permission(true),{apiKey:'demo-api-token',country:'de'},async(url,options)=>{
  called++;const u=new URL(url);assert.equal(u.origin,'https://proxy.webshare.io');assert.equal(u.pathname,'/api/v2/proxy/list/');
  assert.equal(u.searchParams.get('mode'),'direct');assert.equal(u.searchParams.get('page_size'),'100');assert.equal(u.searchParams.get('country_code__in'),'DE');
  assert.ok(!url.includes('demo-api-token'));assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Token demo-api-token');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
  return response({next:'https://malicious.example/',results:[row(1)]});
 });
 assert.equal(called,1);assert.equal(result.servers.length,1);assert.ok(!JSON.stringify(result).includes('demo-api-token'));
});

test('requires optional origin permission and valid key/filter before making requests',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return response({results:[row(1)]});};
 await assert.rejects(api.importProxies(permission(false),{apiKey:'demo'},fetcher),/Allow access/);
 for(const input of [{apiKey:''},{apiKey:'bad\r\nkey'},{apiKey:'x',country:'../../us'},{apiKey:'x'.repeat(513)}]) await assert.rejects(api.importProxies(permission(true),input,fetcher));
 assert.equal(calls,0);
});

test('auth/rate/server errors are actionable without exposing response bodies or keys',async()=>{
 for(const [status,pattern] of [[401,/rejected/],[403,/rejected/],[429,/rate limit/],[500,/temporarily unavailable/]]) {
  await assert.rejects(api.importProxies(permission(true),{apiKey:'secret-token'},async()=>response({error:'private upstream response secret-token'},status)),e=>pattern.test(e.message)&&!e.message.includes('secret-token')&&!e.message.includes('private upstream'));
 }
 await assert.rejects(api.importProxies(permission(true),{apiKey:'secret-token'},async()=>{throw Error('transport secret-token');}),e=>!e.message.includes('secret-token'));
});

test('request timeout and oversized/malformed responses do not return imported credentials',async()=>{
 await assert.rejects(api.importProxies(permission(true),{apiKey:'demo'},(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('abort')))),10),/deadline/);
 await assert.rejects(api.importProxies(permission(true),{apiKey:'demo'},async()=>new Response('x'.repeat(131073))),/size limit/);
 await assert.rejects(api.importProxies(permission(true),{apiKey:'demo'},async()=>new Response('not json')),/invalid proxy list/);
 await assert.rejects(api.importProxies(permission(true),{apiKey:'demo'},async()=>response({results:[]})),/No usable direct proxies/);
});

test('API key is not persisted by importer; UI clears key and only options can invoke import',()=>{
 const root=path.join(__dirname,'../scripts/video-studio-launcher/extension');
 const code=fs.readFileSync(path.join(root,'webshare.js'),'utf8');assert.doesNotMatch(code,/storage\.|console\./);
 const ui=fs.readFileSync(path.join(root,'proxy-options.js'),'utf8');assert.match(ui,/proxyId\('webshareApiKey'\)\.value = ''/);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));assert.equal(manifest.version,'1.6.1');assert.deepEqual(manifest.optional_host_permissions,[api.ORIGIN]);
 const background=fs.readFileSync(path.join(root,'background.js'),'utf8');
 assert.match(background,/if \(sender\.url === OPTIONS_PAGE\) \{\s*if \(message\?\.type === 'CMMTOOLS_WEBSHARE_IMPORT'\)/);
});

test('options imports once, clears API key, replaces only unsaved rows and preserves rows on failure',async()=>{
 const vm=require('node:vm');
 const root=path.join(__dirname,'../scripts/video-studio-launcher/extension');
 const html=fs.readFileSync(path.join(root,'options.html'),'utf8');
 const ids=[...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,'each control has a unique ID');
 const script=fs.readFileSync(path.join(root,'proxy-options.js'),'utf8');
 async function run(allow,fail=false) {
  class Element {
   constructor(){this.value='';this.checked=false;this.disabled=false;this.children=[];this.listeners={};}
   appendChild(child){this.children.push(child);child.parent=this;}
   replaceChildren(){this.children=[];}
   addEventListener(type,handler){(this.listeners[type] ||= []).push(handler);}
   remove(){this.parent.children=this.parent.children.filter(c=>c!==this);}
   click(){for(const fn of this.listeners.click||[])fn();}
  }
  const elements=Object.fromEntries(ids.map(id=>[id,new Element()]));let imports=0,saves=0,permissionCalls=0;
  const chrome={runtime:{sendMessage(message,cb){
   if(message.type==='CMMTOOLS_PROXY_CONFIG') return cb({ok:true,result:{enabled:false,includeDirect:false,directNetworkConfirmed:false,servers:api.proxiesFromResponse({results:[row(88)]})}});
   if(message.type==='CMMTOOLS_PROXY_STATUS')return cb({ok:true,result:{phase:'default',label:'Browser default'}});
   if(message.type==='CMMTOOLS_PROXY_SAVE'){saves++;return cb({ok:true,result:{saved:true}});}
   if(message.type==='CMMTOOLS_WEBSHARE_IMPORT'){imports++;assert.equal(message.apiKey,'demo-key');assert.equal(elements.webshareApiKey.value,'');return cb(fail?{ok:false,error:'Webshare unavailable'}:{ok:true,result:{servers:api.proxiesFromResponse({results:[row(1)]})}});}
  }},permissions:{async request(request){permissionCalls++;assert.deepEqual(JSON.parse(JSON.stringify(request)),{origins:['https://proxy.webshare.io/*']});return allow;}}};
  const context={document:{getElementById:id=>elements[id],createElement:()=>new Element()},chrome,window:{addEventListener(){}}};
  vm.createContext(context);vm.runInContext(script,context);await new Promise(setImmediate);
  assert.equal(elements.proxyServers.children.length,1);
  elements.webshareApiKey.value='demo-key';elements.webshareImport.click();await new Promise(setImmediate);
  assert.equal(elements.webshareImport.listeners.click.length,1);assert.equal(permissionCalls,1);assert.equal(elements.webshareApiKey.value,'');assert.equal(saves,0);
  const field=elements.proxyServers.children[0].children[2].children[0];
  assert.equal(field.value,allow&&!fail?'192.0.2.1':'192.0.2.88');assert.equal(imports,allow?1:0);
 }
 await run(true);await run(false);await run(true,true);
});

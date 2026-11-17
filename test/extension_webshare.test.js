'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const api=require('../src/webshare_proxy.js');
const {createExtensionWebshare,connectPage}=require('../src/extension_webshare.js');
const Managed=require('../scripts/video-studio-launcher/extension/managed-proxy.js');
const core=require('../scripts/video-studio-launcher/extension/proxy-core.js');
const row=i=>({valid:true,proxy_address:'192.0.2.'+i,port:8080,username:'proxy-user',password:'proxy-pass',country_code:'US'});
const permission=allowed=>({permissions:{contains:async()=>allowed}});
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function service(){const data={},writes=[];let failed=false;return {data,writes,fail(){failed=true;},value:createExtensionWebshare({get:async(k,f)=>data[k]??f,set:async(k,v,o)=>{writes.push({k,v,o});data[k]=v;},readProxies:async(_api,input)=>{if(failed)throw Error('raw upstream secret '+input.apiKey);return {servers:api.proxiesFromResponse({results:[row(1),row(2)]})};}})};}

test('Webshare importer uses fixed HTTPS GET/header auth and returns five valid distinct direct endpoints',async()=>{
 let called=0;const result=await api.importProxies(permission(true),{apiKey:'admin-key',country:'us'},async(url,opt)=>{
 called++;const u=new URL(url);assert.equal(u.origin,'https://proxy.webshare.io');assert.equal(u.pathname,'/api/v2/proxy/list/');assert.equal(u.searchParams.get('mode'),'direct');assert.equal(u.searchParams.get('country_code__in'),'US');assert.ok(!url.includes('admin-key'));assert.equal(opt.method,'GET');assert.equal(opt.headers.Authorization,'Token admin-key');assert.equal(opt.redirect,'error');assert.equal(opt.credentials,'omit');
 return response({next:'https://evil.test/',results:[{...row(9),valid:false},row(1),row(1),...Array.from({length:9},(_,i)=>row(i+2))]});});
 assert.equal(called,1);assert.equal(result.servers.length,5);assert.ok(!JSON.stringify(result).includes('admin-key'));
});
test('Webshare errors and timeouts never echo raw response secrets or mutate account',async()=>{
 for(const status of [401,403,429,500])await assert.rejects(api.importProxies(permission(true),{apiKey:'admin-key'},async()=>response({secret:'admin-key'},status)),e=>!e.message.includes('admin-key'));
 await assert.rejects(api.importProxies(permission(true),{apiKey:'admin-key'},(_u,{signal})=>new Promise((_yes,no)=>signal.addEventListener('abort',()=>no(Error('secret admin-key')))),5),/deadline/);
 await assert.rejects(api.importProxies(permission(true),{apiKey:'admin-key'},async()=>new Response('x'.repeat(140000))),/size limit/);
 await assert.rejects(api.importProxies(permission(true),{apiKey:'bad\nkey'},async()=>{throw Error('must not request');}));
});
test('Admin saves API key and proxies in one encrypted setting; status and customer config never contain the API key',async()=>{
 const s=service();const result=await s.value.save({enabled:true,apiKey:'owner-webshare-key',country:'us'});
 assert.equal(s.writes.length,1);assert.deepEqual(s.writes[0].o,{secret:true});assert.equal(result.configured,true);assert.equal(result.serverCount,2);assert.ok(!JSON.stringify(result).includes('owner-webshare-key'));
 const config=await s.value.customer({id:1,status:'active'});assert.equal(config.servers.length,2);assert.equal(config.includeDirect,false);assert.ok(!JSON.stringify(config).includes('owner-webshare-key'));
 await s.value.save({enabled:true,country:'US'});assert.equal(s.writes.length,2,'saved key reused for explicit admin sync');
});
test('failed Admin sync leaves the previous setting intact and returns a bounded error',async()=>{
 const s=service();await s.value.save({enabled:true,apiKey:'old-owner-key'});const before=JSON.stringify(s.data);s.fail();
 await assert.rejects(s.value.save({enabled:true,apiKey:'new-owner-key'}),e=>e.statusCode===502&&!e.message.includes('new-owner-key'));
 assert.equal(JSON.stringify(s.data),before);assert.equal(s.writes.length,1);
});
test('only active signed-in customers receive managed config; disabling blocks new connections',async()=>{
 const s=service();await s.value.save({enabled:true,apiKey:'owner-key'});
 for(const user of [null,{status:'suspended'}])await assert.rejects(s.value.customer(user),e=>e.statusCode===401);
 await s.value.disable();await assert.rejects(s.value.customer({status:'active'}),e=>e.statusCode===503);
 assert.equal((await s.value.status()).configured,true,'disable preserves encrypted account setup');
});
function bridge(){const flags={managedEnabled:true,managedConsent:true},saved=[],removed=[];let created;
 const manager={permitted:async()=>true,save:async config=>saved.push(core.normalize(config))};
 const value=new Managed({storage:{local:{get:async()=>flags}},runtime:{id:'a'.repeat(32)},windows:{create:async o=>{created=o;return {id:55};},remove:async id=>removed.push(id)}},manager,1000);
 return {value,flags,saved,removed,get created(){return created;}};
}
test('managed handoff binds exact CMMTools origin, path, connection window and fresh nonce',async()=>{
 const b=bridge(),pending=b.value.refresh(9);await new Promise(setImmediate);const u=new URL(b.created.url),nonce=u.searchParams.get('nonce');
 const config=core.normalize({enabled:true,includeDirect:false,directNetworkConfirmed:true,servers:[{host:'proxy.test',scheme:'http',port:80,username:'u',password:'p'}]});
 const message={nonce,config},sender={url:'https://cmmtools.site/extension/connect',tab:{windowId:55}};
 for(const invalid of [{...sender,url:'https://evil.test/extension/connect'},{...sender,url:'https://cmmtools.site/other'},{...sender,tab:{windowId:56}}])assert.equal(await b.value.accept(message,invalid),false);
 assert.equal(await b.value.accept({...message,nonce:'invalid'},sender),false);assert.equal(b.saved.length,0);
 assert.equal(await b.value.accept(message,sender),true);await pending;assert.equal(b.saved.length,1);assert.deepEqual(b.removed,[55]);
});
test('closing Studio cancels managed refresh; disabled preference never opens a connection window',async()=>{
 const b=bridge(),pending=b.value.refresh(9);await new Promise(setImmediate);b.value.removed(9);await assert.rejects(pending,/cancelled/);assert.deepEqual(b.removed,[55]);
 const c=bridge();c.flags.managedEnabled=false;await c.value.refresh(1);assert.equal(c.created,undefined);
});
test('customer Options has no Webshare key/server inputs and package needs no Webshare host permission',()=>{
 const root=path.join(__dirname,'../scripts/video-studio-launcher/extension');const html=fs.readFileSync(path.join(root,'options.html'),'utf8');assert.doesNotMatch(html,/id="webshareApiKey"|id="proxyServers"/);assert.match(html,/id="managedConsent"/);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));assert.equal(manifest.version,'1.7.1');assert.equal(manifest.optional_host_permissions,undefined);
 assert.ok(!connectPage().includes('owner-webshare-key'));
 const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');assert.ok(server.indexOf("routePath==='/admin/extension/webshare'")>server.indexOf('if (!adminAuthorized(req))'));
 assert.match(server,/const user=await requireUser\(req\);\s*const config=await extensionWebshare.customer\(user\)/);
});

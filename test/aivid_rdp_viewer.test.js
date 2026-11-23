'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {allowed,gatewayUrl,assertEnabled,customerSourceAllowed,handle}=require('../src/aivid_rdp_viewer.js');

const USER={id:42,email:'pilot@example.com',status:'active'};
const CONFIG={
  AIVID_RDP_VIEW_ENABLED:'true',
  AIVID_RDP_VIEW_ALLOWED_IDS:'42',
  AIVID_RDP_VIEW_URL:'https://rdp.cmmtools.site/guacamole/',
  AIVID_RDP_VIEW_ISOLATION_ACK:'true',
  AIVID_RDP_VIEW_DIRECT_BILLING_ACK:'true',
};

test('RDP viewer is disabled by default, restricted to one CMMTools user',()=>{
  assert.equal(allowed(USER,{}),false);
  assert.equal(allowed(USER,{AIVID_RDP_VIEW_ENABLED:'true'}),false);
  assert.equal(allowed(USER,CONFIG),true);
  assert.equal(allowed({id:43,email:'other@example.com'},CONFIG),false);
  assert.equal(allowed(USER,{...CONFIG,AIVID_RDP_VIEW_ALLOWED_IDS:'',AIVID_RDP_VIEW_ALLOWED_EMAILS:'pilot@example.com'}),true);
  assert.equal(allowed(USER,{...CONFIG,AIVID_RDP_VIEW_ALLOWED_IDS:'',AIVID_RDP_VIEW_ALLOWED_EMAILS:'pilot@example.net'}),false);
  assert.equal(allowed({id:'evil'},CONFIG),false);
});

test('RDP gateway URL permits only a dedicated HTTPS Guacamole instance, never URL credentials',()=>{
  assert.equal(gatewayUrl(CONFIG),'https://rdp.cmmtools.site/guacamole/');
  for(const address of [
    '', 'http://rdp.cmmtools.site/guacamole/','https://cmmtools.site/guacamole/',
    'https://aivid.dev/guacamole/','https://rdp.cmmtools.site/other/',
    'https://user:password@rdp.cmmtools.site/guacamole/',
    'https://rdp.cmmtools.site:8443/guacamole/',
    'https://rdp.cmmtools.site/guacamole/?token=secret',
    'https://rdp.cmmtools.site/guacamole/#/client/abc',
    'https://localhost/guacamole/',
  ]){
    assert.throws(()=>gatewayUrl({...CONFIG,AIVID_RDP_VIEW_URL:address}),{statusCode:503},address);
  }
});

test('Separate Windows and Guacamole user isolation and direct billing require explicit acknowledgements',()=>{
  assert.equal(assertEnabled(USER,CONFIG),'https://rdp.cmmtools.site/guacamole/');
  assert.throws(()=>assertEnabled(USER,{...CONFIG,AIVID_RDP_VIEW_ISOLATION_ACK:'false'}),/isolated Guacamole/);
  assert.throws(()=>assertEnabled(USER,{...CONFIG,AIVID_RDP_VIEW_DIRECT_BILLING_ACK:'false'}),/direct provider billing/);
  assert.throws(()=>assertEnabled({id:20},CONFIG),/not enabled/);
});

function reply(){
  const result={status:null,headers:{},body:null};
  return {result,writeHead(status,headers){result.status=status;result.headers=headers;},
    end(value){result.body=value;}};
}
function handlers(user=USER){
  return {requireDatabase:()=>{},requireUser:async()=>user,checkSourceAccess:async()=>true};
}

async function withEnv(values,run){
  const keys=Object.keys(values),previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    for(const key of keys)if(values[key]===undefined)delete process.env[key];else process.env[key]=values[key];
    return await run();
  }finally{
    for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  }
}

test('Authenticated RDP entry renders a nonce-protected sandbox, never a Browserless token',async()=>{
  await withEnv(CONFIG,async()=>{
    const x=reply();
    assert.equal(await handle({method:'GET'},x,'/aivid-live-studio',handlers()),true);
    assert.equal(x.result.status,200);
    assert.match(x.result.headers['content-security-policy'],/frame-src https:\/\/rdp\.cmmtools\.site/);
    assert.match(x.result.headers['content-security-policy'],/script-src 'nonce-/);
    assert.match(x.result.headers['content-security-policy'],/frame-ancestors 'none'/);
    assert.match(x.result.body,/Premium Remote Desktop/);
    assert.match(x.result.body,/allow-downloads/);
    assert.match(x.result.body,/\/api\/rdp-studio\/config/);
    assert.doesNotMatch(x.result.body,/Browserless\.liveURL|AIVID_LIVE_VIEW_BROWSERLESS_WS|token=/);
    assert.doesNotMatch(x.result.body,/__CMM_RDP_NONCE__/);
    const second=reply();await handle({method:'GET'},second,'/rdp-studio',handlers());
    assert.equal(second.result.status,200);
    assert.notEqual(second.result.headers['content-security-policy'],x.result.headers['content-security-policy']);
  });
});

test('Gateway information requires CMMTools authentication and returns no RDP credentials',async()=>{
  await withEnv(CONFIG,async()=>{
    const x=reply();await handle({method:'GET'},x,'/api/rdp-studio/config',handlers());
    assert.equal(x.result.status,200);
    const v=JSON.parse(x.result.body);
    assert.deepEqual(v,{ok:true,gatewayUrl:'https://rdp.cmmtools.site/guacamole/',
      transport:'rdp',fileTransfer:'guacamole-virtual-drive',separateGatewayLogin:true,directBilling:true});
    const blocked=reply();
    await handle({method:'GET'},blocked,'/api/rdp-studio/config',handlers({id:12,email:'stranger@example.com'}));
    assert.equal(blocked.result.status,403);
    assert.ok(!blocked.result.body.includes('rdp.cmmtools.site'));
    const legacy=reply();
    await handle({method:'POST'},legacy,'/api/aivid-live-studio/start',handlers());
    assert.equal(legacy.result.status,410);
    assert.match(legacy.result.body,/Browserless live-view API was retired/);
    const denied=reply();
    await handle({method:'POST'},denied,'/aivid-live-studio',handlers());
    assert.equal(denied.result.status,405);
  });
});

test('Studio model picker links selected Premium models to the interactive Windows workspace',()=>{
  const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
  assert.match(html,/id="premiumDesktopLink" href="\/aivid-interactive-studio" target="_blank" rel="noopener noreferrer"/);
  assert.match(html,/desktopLink\.classList\.toggle\('hide',!m\?\.premium\)/);
  const server=fs.readFileSync(require.resolve('../server.js'),'utf8');
  assert.match(server,/require\('\.\/src\/aivid_rdp_viewer\.js'\)\.handle/);
  assert.match(server,/require\('\.\/src\/aivid_native_desktop\.js'\)\.handle/);
  assert.doesNotMatch(server,/require\('\.\/src\/aivid_embed\.js'\)\.handle/);
});

test('RDP page rejects customers with explicitly disabled AIVID source grants',async()=>{
  const allowedAccess={execute:async(_sql,args)=>{assert.deepEqual(args,[42,'aivid']);return [[{enabled:1}]];}};
  const deniedAccess={execute:async()=>[[{enabled:0}]]};
  const defaultAccess={execute:async()=>[[]]};
  assert.equal(await customerSourceAllowed(42,allowedAccess),true);
  assert.equal(await customerSourceAllowed(42,defaultAccess),true);
  assert.equal(await customerSourceAllowed(42,deniedAccess),false);
  await withEnv(CONFIG,async()=>{
    const res=reply();
    await handle({method:'GET'},res,'/rdp-studio',{...handlers(),checkSourceAccess:async()=>false});
    assert.equal(res.result.status,403);
    assert.match(res.result.body,/disabled in this customer/);
    assert.doesNotMatch(res.result.body,/rdp\.cmmtools\.site/);
  });
});

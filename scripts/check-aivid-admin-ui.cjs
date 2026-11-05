const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const artifacts=process.env.AIVID_UI_ARTIFACT_DIR||'artifacts/aivid-admin-ui';fs.mkdirSync(artifacts,{recursive:true});
 const page=await browser.newPage({viewport:{width:1365,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let saved=false,loginState='idle',failLogin=true,loginExpiresAt=Date.now()+120000;const calls=[];
 const loginId='12345678-1234-1234-1234-123456789012';
 const login=()=>({id:loginId,state:loginState,expiresAt:new Date(loginExpiresAt).toISOString(),message:loginState==='connected'?'AIVID sign-in verified and saved for the worker.':'Open the login window, sign in, then verify.',...(loginState==='waiting'?{liveURL:'https://production-sfo.browserless.io/live/test?i=fixture'}:{}),...(loginState==='connected'?{verifiedAt:new Date().toISOString()}:{})});
 await page.route('http://cmmtools.test/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  if(p==='/admin-console')return route.fulfill({contentType:'text/html',body:fs.readFileSync('public/admin.html','utf8')});
  if(p==='/admin/aivid/status')return route.fulfill({json:{ok:true,apiKeyConfigured:saved,configured:saved&&loginState==='connected',endpoint:'https://production-sfo.browserless.io',ttlDays:1,login:login()}});
  if(p==='/admin/aivid/settings'){calls.push({p,headers:req.headers(),body:req.postDataJSON()});saved=true;return route.fulfill({json:{ok:true,apiKeyConfigured:true}});}
  if(p==='/admin/aivid/login'){
   if(failLogin){failLogin=false;loginState='failed';return route.fulfill({status:502,json:{ok:false,error:'Browserless session creation failed (HTTP 401). Browserless rejected authentication.'}});}
   loginState='waiting';loginExpiresAt=Date.now()+120000;return route.fulfill({json:{ok:true,login:login()}});
  }
  if(p.endsWith('/finish')){loginState='connected';return route.fulfill({json:{ok:true,requested:true}});}
  if(p==='/admin/aivid/login/'+loginId)return route.fulfill({json:{ok:true,login:login()}});
  if(p==='/admin/aivid/check')return route.fulfill({json:{ok:true,price:2,balance:25}});
  if(p.startsWith('/admin/'))return route.fulfill({json:{ok:true,settings:{},models:[],users:[],entries:[],boot:[],boots:[],pricing:[],sourceCost30d:[],providers:[],config:{},web:{uptimeSeconds:1,startedAt:new Date().toISOString(),slowRequests:[]}}});
  const file=path.join('public',p);
  if(fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file});
  return route.fulfill({status:404,body:''});
 });
 await page.goto('http://cmmtools.test/admin-console');
 await page.locator('#tokenInput').fill('fixture-admin');
 await page.getByRole('button',{name:'Open dashboard',exact:true}).click();
 await page.locator('#adminApp').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Provider',exact:true}).click();
 await page.locator('#aividKeyStatus').filter({hasText:'No Browserless key'}).waitFor();
 await page.locator('#aividBrowserlessKey').fill('fixture-browserless-key');
 await page.getByRole('button',{name:'Save Browserless key',exact:true}).click();
 await page.locator('#aividKeyStatus').filter({hasText:'configured'}).waitFor();
 assert.equal(await page.locator('#aividBrowserlessKey').inputValue(),'');
 assert.equal(calls[0].body.apiKey,'fixture-browserless-key');
 assert.equal(calls[0].headers['x-admin-token'],'fixture-admin');
 await page.getByRole('button',{name:'Connect aivid',exact:true}).click();
 await page.locator('#aividAdminMessage').filter({hasText:'HTTP 401'}).waitFor();
 await page.locator('#aividConnectionBadge').filter({hasText:'Reconnect to continue'}).waitFor();
 assert.equal(await page.locator('#aividLoginLink').getAttribute('href'),null);
 await page.getByRole('button',{name:'Connect aivid',exact:true}).waitFor({state:'visible'});
 await page.getByRole('button',{name:'Connect aivid',exact:true}).click();
 await page.getByRole('link',{name:'Open aivid login window',exact:false}).waitFor({state:'visible'});
 await page.locator('#aividLoginCountdown').filter({hasText:'remaining'}).waitFor();
 await page.locator('#aividAdminCard').scrollIntoViewIfNeeded();
 await page.locator('#aividAdminCard').screenshot({path:path.join(artifacts,'desktop.png')});
 await page.getByRole('button',{name:'Verify sign-in',exact:true}).click();
 await page.locator('#aividConnectionBadge').filter({hasText:'Sign-in verified'}).waitFor();
 await page.getByRole('button',{name:'Check connection',exact:true}).click();
 await page.locator('#aividAdminMessage').filter({hasText:'Balance: 25 credits'}).waitFor();
 await page.setViewportSize({width:390,height:1000});
 await page.locator('#aividAdminCard').scrollIntoViewIfNeeded();
 const bounds=await page.locator('#aividAdminCard').boundingBox();
 assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391);
 await page.locator('#aividAdminCard').screenshot({path:path.join(artifacts,'mobile.png')});
 await page.getByRole('button',{name:'Connect aivid',exact:true}).click();
 loginExpiresAt=Date.now()+600;
 await page.locator('#aividAdminCard').getByRole('button',{name:'Refresh status',exact:true}).click();
 await page.locator('#aividLoginCountdown').filter({hasText:'expired'}).waitFor();
 assert.equal(await page.locator('#aividLoginLink').getAttribute('href'),null);
 assert.equal(await page.locator('#aividVerifyButton').isDisabled(),true);
 loginState='expired';
 await page.locator('#aividAdminCard').getByRole('button',{name:'Refresh status',exact:true}).click();
 await page.locator('#aividLoginBox').waitFor({state:'hidden'});
 assert.equal(await page.locator('#aividConnectButton').isEnabled(),true);
 await page.locator('#aividAdminCard').screenshot({path:path.join(artifacts,'expired.png')});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({keySave:true,setupFailureShown:true,retryAfterFailure:true,loginLink:true,verification:true,checkConnection:true,countdown:true,expiredLinkRemoved:true,mobileCardFits:true,pageErrors:errors}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

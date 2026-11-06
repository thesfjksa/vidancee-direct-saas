const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {openLoginPage,AividBrowserlessClient,waitForSession}=require('../src/provider/aivid.js');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const formPage=await browser.newPage();
 await require('./aivid-rdp/fixtures/form.cjs').checkForm(formPage,AividBrowserlessClient,waitForSession);
 await formPage.close();
 await require('./aivid-rdp/fixtures/references.cjs').checkReferenceFlows(browser,AividBrowserlessClient);
 await require('./aivid-rdp/fixtures/collection.cjs').checkCollection(browser,AividBrowserlessClient);
 console.log('AIVID full preflight: prompt line endings/retention, zero balance, duration, Public pricing and safe diagnostics passed; no Generate click.');
 // Exercise the login preparation against a real DOM. Only the entry button
 // is clicked; Google sign-in and paid actions must remain untouched.
 const loginPage=await browser.newPage();
 let signedIn=false,inertFirstClick=false;
 await loginPage.route('https://aivid.dev/**',route=>route.fulfill({contentType:'text/html',body:
  '<textarea placeholder="Describe your video idea..."></textarea>'+
  (signedIn?'':'<button id="entry">Sign In</button>')+
  '<button id="google" hidden>Continue with Google</button><script>window.entryClicks=0;window.googleClicks=0;'+
  'document.querySelector("#entry")?.addEventListener("click",()=>{window.entryClicks++;'+(inertFirstClick?'if(window.entryClicks===1)return;':'')+'document.querySelector("#google").hidden=false;});'+
  'document.querySelector("#google").addEventListener("click",()=>window.googleClicks++);</script>'}));
 assert.equal(await openLoginPage(loginPage),true);
 assert.equal(await loginPage.getByRole('button',{name:'Continue with Google',exact:true}).isVisible(),true);
 assert.deepEqual(await loginPage.evaluate(()=>({entry:window.entryClicks,google:window.googleClicks})),{entry:1,google:0});
 assert.deepEqual(loginPage.viewportSize(),{width:1024,height:720});
 signedIn=true;
 assert.equal(await openLoginPage(loginPage),false);
 assert.deepEqual(await loginPage.evaluate(()=>({entry:window.entryClicks,google:window.googleClicks})),{entry:0,google:0});
 signedIn=false;inertFirstClick=true;
 assert.equal(await openLoginPage(loginPage),true);
 assert.deepEqual(await loginPage.evaluate(()=>({entry:window.entryClicks,google:window.googleClicks})),{entry:2,google:0});
 await loginPage.close();
 const artifacts=process.env.AIVID_UI_ARTIFACT_DIR||'artifacts/aivid-admin-ui';fs.mkdirSync(artifacts,{recursive:true});
 const page=await browser.newPage({viewport:{width:1365,height:1000}});
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
  if(window.fixtureClipboardBlocked)throw new Error('Clipboard unavailable');
  window.fixtureCopiedCode=text;
 }}}));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let saved=false,loginState='idle',failLogin=true,loginExpiresAt=Date.now()+120000,mode='browserless',rdpPaired=false,cloudStarts=0;const calls=[],checkRequests=[],referenceChecks=[];
 const loginId='12345678-1234-1234-1234-123456789012';
 const login=()=>({id:loginId,state:loginState,expiresAt:new Date(loginExpiresAt).toISOString(),message:loginState==='connected'?'AIVID sign-in verified and saved for the worker.':'Open the login window, sign in, then verify.',...(loginState==='waiting'?{liveURL:'https://production-sfo.browserless.io/live/test?i=fixture'}:{}),...(loginState==='connected'?{verifiedAt:new Date().toISOString()}:{})});
 await page.route('http://cmmtools.test/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  if(p==='/admin-console')return route.fulfill({contentType:'text/html',body:fs.readFileSync('public/admin.html','utf8')});
  if(p==='/admin/aivid/status')return route.fulfill({json:{ok:true,mode,rdp:{paired:rdpPaired,online:rdpPaired,status:'ready',seenAt:new Date().toISOString()},apiKeyConfigured:saved,configured:mode==='rdp'?rdpPaired:saved&&loginState==='connected',endpoint:'https://production-sfo.browserless.io',ttlDays:1,login:mode==='rdp'?{state:'idle'}:login()}});
  if(p==='/admin/aivid/settings'){const body=req.postDataJSON();calls.push({p,headers:req.headers(),body});mode=body.mode||mode;saved=true;return route.fulfill({json:{ok:true,apiKeyConfigured:true}});}
  if(p==='/admin/aivid/rdp/pairing')return route.fulfill({json:{ok:true,code:'AABBCCDDEEFF001122334455',expiresAt:new Date(Date.now()+600000).toISOString()}});
  if(p==='/admin/aivid/login'){
   cloudStarts++;
   if(failLogin){failLogin=false;loginState='failed';return route.fulfill({status:502,json:{ok:false,error:'Browserless session creation failed (HTTP 401). Browserless rejected authentication.'}});}
   loginState='waiting';loginExpiresAt=Date.now()+120000;return route.fulfill({json:{ok:true,login:login()}});
  }
  if(p.endsWith('/finish')){loginState='connected';return route.fulfill({json:{ok:true,requested:true}});}
  if(p==='/admin/aivid/login/'+loginId)return route.fulfill({json:{ok:true,login:login()}});
  if(p==='/admin/aivid/check-references'){const body=req.postDataJSON();referenceChecks.push(body);return route.fulfill({json:{ok:true,verified:true,submitted:false,generationBlocked:true,modelId:body.model,balanceBefore:25,balanceAfter:25,uploadedCounts:{image:1,video:1,audio:1}}});}
  if(p==='/admin/aivid/check'){checkRequests.push(req.postDataJSON());return route.fulfill({json:{ok:true,price:2,balance:25,modelVerified:true,withinLimit:true,standardCustomerCredits:1693.44}});}
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
 const previousCloudStarts=cloudStarts;
 await page.locator('#aividTransport').selectOption('rdp');
 await page.getByRole('button',{name:'Save RDP connection',exact:true}).click();
 await page.getByRole('button',{name:'Generate pairing code',exact:true}).waitFor({state:'visible'});
 assert.equal(await page.locator('#aividBrowserlessFields').isVisible(),false);
 await page.getByRole('button',{name:'Generate pairing code',exact:true}).click();
 await page.locator('#aividPairCopyRow').waitFor({state:'visible'});
 assert.equal(await page.locator('#aividPairCodeInput').inputValue(),'AABBCCDDEEFF001122334455');
 await page.getByRole('button',{name:'Copy code',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.fixtureCopiedCode),'AABBCCDDEEFF001122334455');
 await page.locator('#aividAdminMessage').filter({hasText:'Code copied'}).waitFor();
 await page.evaluate(()=>{window.fixtureClipboardBlocked=true;});
 await page.getByRole('button',{name:'Copy code',exact:true}).click();
 await page.locator('#aividAdminMessage').filter({hasText:'Ctrl+C'}).waitFor();
 assert.equal(await page.locator('#aividPairCodeInput').evaluate(input=>input.selectionEnd-input.selectionStart),24);
 rdpPaired=true;
 await page.locator('#aividAdminCard').getByRole('button',{name:'Refresh status',exact:true}).click();
 await page.locator('#aividRdpStatus').filter({hasText:'Agent online'}).waitFor();
 await page.getByRole('button',{name:'Check RDP connection',exact:true}).click();
 await page.locator('#aividAdminMessage').filter({hasText:'Balance: 25 credits'}).waitFor();
 assert.equal(cloudStarts,previousCloudStarts);
 const beforeChecks=checkRequests.length;
 await page.getByRole('button',{name:'Check all Premium models',exact:true}).click();
 await page.locator('#aividAdminMessage').filter({hasText:'6/6 checks passed'}).waitFor();
 assert.equal(checkRequests.length-beforeChecks,6);
 const batch=checkRequests.slice(beforeChecks);
 assert.deepEqual([...new Set(batch.map(v=>v.model))],['aivid_seedance_2_0_mini','aivid_seedance_2_0','aivid_seedance_2_5']);
 assert.ok(batch.every(v=>v.duration===5&&v.aspectRatio==='16:9'));
 assert.deepEqual(batch.map(v=>v.resolution),['480p','720p','480p','720p','480p','720p']);
 assert.match(await page.locator('#aividAdminMessage').innerText(),/No video was generated and no credits were charged/);
 assert.equal(await page.getByRole('button',{name:'Check all Premium models',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'Check reference uploads (no generation)',exact:true}).click();
 await page.locator('#aividAdminMessage').filter({hasText:'3/3 reference checks passed'}).waitFor();
 assert.deepEqual(referenceChecks.map(v=>v.model),['aivid_seedance_2_0_mini','aivid_seedance_2_0','aivid_seedance_2_5']);
 assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('AABBCCDDEEFF001122334455')),false);
 await page.locator('#aividAdminCard').screenshot({path:path.join(artifacts,'rdp-mobile.png')});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({rdpCopyCode:true,clipboardFallback:true,rdpMode:true,rdpPairing:true,rdpCheckWithoutBrowserless:true,loginDialogPrepared:true,googleLeftForOwner:true,existingSignInReused:true,keySave:true,setupFailureShown:true,retryAfterFailure:true,loginLink:true,verification:true,checkConnection:true,countdown:true,expiredLinkRemoved:true,mobileCardFits:true,pageErrors:errors}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

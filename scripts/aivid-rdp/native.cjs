'use strict';
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function browserLabel() { return 'Microsoft Edge'; }
function findBrowser(browser = 'edge', env = process.env, exists = existsSync) {
  if (browser !== 'edge') throw new Error('Only Microsoft Edge is supported by the AIVID RDP agent.');
  const folder = ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  const override = env.AIVID_EDGE_PATH;
  const roots = [env.PROGRAMFILES || env.ProgramFiles, env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'], env.LOCALAPPDATA];
  const candidates = [override, ...roots.filter(Boolean).map(root => path.win32.join(root, ...folder))].filter(Boolean);
  const found = candidates.find(exists);
  if (!found) throw new Error('Microsoft Edge is not installed on this RDP. Install Edge before starting the agent.');
  return found;
}
function browserProfile(root, browser = 'edge') {
  if (browser !== 'edge') throw new Error('Only Microsoft Edge is supported by the AIVID RDP agent.');
  return path.join(root, '.aivid-rdp-edge-profile');
}
function chromiumArguments(profile, debug = false, initialUrl = 'https://aivid.dev/') {
  if (!['https://aivid.dev/', 'about:blank'].includes(initialUrl)) throw new Error('Unsupported browser start page.');
  return ['--user-data-dir=' + path.resolve(profile), '--new-window',
    ...(debug ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] : []), initialUrl];
}
async function startEdge(profile, { browser = 'edge', debug = false, env = process.env, start = spawn, initialUrl = 'https://aivid.dev/' } = {}) {
  if (browser !== 'edge') throw new Error('Only Microsoft Edge is supported by the AIVID RDP agent.');
  await fs.mkdir(profile, { recursive: true });
  const child = start(findBrowser('edge', env), chromiumArguments(profile, debug, initialUrl), { detached: true, stdio: 'ignore', shell: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve); child.once('error', () => reject(new Error(browserLabel(browser) + ' could not start. Use a writable folder on your RDP.')));
  });
  child.unref();
}
async function debuggerEndpoint(profile, fetchImpl = fetch) {
  try {
    const [line, target] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    const port = Number(line);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(target)) return null;
    const response = await fetchImpl('http://127.0.0.1:' + port + '/json/version', { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const url = new URL((await response.json()).webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== port || url.pathname !== target || url.username || url.password || url.search || url.hash) return null;
    return 'ws://127.0.0.1:' + port + target;
  } catch { return null; }
}
async function connectNative(profile, { browser: browserType = 'edge', chromium, fetchImpl = fetch, start = startEdge, timeoutMs = 20000 } = {}) {
  if (browserType !== 'edge') throw new Error('Only Microsoft Edge is supported by the AIVID RDP agent.');
  let endpoint = await debuggerEndpoint(profile, fetchImpl);
  if (!endpoint) {
    await start(profile, { browser: browserType, debug: true });
    const deadline = Date.now() + timeoutMs;
    while (!endpoint && Date.now() < deadline) { await pause(250); endpoint = await debuggerEndpoint(profile, fetchImpl); }
  }
  if (!endpoint) throw new Error('Close the ' + browserLabel(browserType) + ' windows opened by AIVID-Login.exe, then restart AIVID-Agent.exe. Other browser windows can stay open.');
  chromium ||= require('playwright-core').chromium;
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error();
    // The managed profile owns one reusable work tab. Guarded submissions
    // navigate it to a blank page before removing request interception.
    const page = context.pages().find(p=>p.url()==='about:blank#cmmtools-worker'||p.url().startsWith('https://aivid.dev/')) || context.pages().find(p=>p.url()==='about:blank') || await context.newPage();
    page.setDefaultTimeout(15000);
    for (const old of context.pages()) {
      if (old === page) continue;
      try { if (old.url() === 'about:blank' || new URL(old.url()).origin === 'https://aivid.dev') await old.close(); } catch {}
    }
    // With connectOverCDP, close disconnects the Playwright transport. Edge
    // was launched independently and stays running with its saved profile.
    return { browser, context, page, close: async () => { await browser.close().catch(() => {}); } };
  } catch {
    if (browser) await browser.close().catch(() => {});
    throw new Error('The local AIVID ' + browserLabel(browserType) + ' connection failed. Inspect its window on the RDP.');
  }
}
function securityWarning(title,text){return /safety warning|security warning|privacy error/i.test(title)&&/looks fake|did you mean|connection is not private|deceptive site/i.test(text);}
const MEDIA_HOST='aivid-dev.ea27a69da769d04e04a51faf6bcc2f00.r2.cloudflarestorage.com';
const MAX_VIDEO_BYTES=100*1024*1024;
function inlineVideoUrl(value,jobId,{jobVerified=false}={}) {
  try {
    const url=new URL(value);
    if(!/^[a-z0-9_-]{8,100}$/i.test(String(jobId))||url.protocol!=='https:'||url.hostname!==MEDIA_HOST||url.port||url.username||url.password||url.hash||
      !url.pathname.startsWith('/generating/')||!/^\/generating\/[a-z0-9_-]+\.mp4$/i.test(url.pathname)||(!jobVerified&&!url.pathname.endsWith('-'+jobId+'.mp4')))return null;
    return url.href;
  }catch{return null;}
}
function mp4Output(data) {
  if(data.length<12||data.length>MAX_VIDEO_BYTES||data.toString('ascii',4,8)!=='ftyp')throw new Error('Invalid MP4.');
  return {data,mimeType:'video/mp4'};
}
// Retrieve verified provider media without forwarding cookies or following redirects.
async function readInlineVideo(url,{fetchImpl=fetch,signal}={}) {
  const unavailable=()=>collectionFailure('collection_media_pending','AIVID has not delivered the complete MP4 yet.');
  let response;
  try {
    response=await fetchImpl(url,{method:'GET',redirect:'error',credentials:'omit',signal});
  } catch {
    throw unavailable();
  }
  try {
    if([403,404,408,425,429].includes(response.status)||response.status>=500)throw unavailable();
    if(response.status!==200||!/^video\/mp4(?:;|$)/i.test(response.headers.get('content-type')||''))throw new Error('Unsupported media response.');
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)<12||Number(length)>MAX_VIDEO_BYTES))throw new Error('Unsupported media size.');
    let size=0;const chunks=[];
    if(!response.body)throw unavailable();
    try {
      for await(const chunk of response.body){
        size+=chunk.length;
        if(size>MAX_VIDEO_BYTES)break;
        chunks.push(Buffer.from(chunk));
      }
    } catch {
      throw unavailable();
    }
    if(size>MAX_VIDEO_BYTES)throw new Error('Media size limit.');
    if(length!==null&&Number(length)!==size)throw unavailable();
    return mp4Output(Buffer.concat(chunks,size));
  }catch(error){await response.body?.cancel?.().catch(()=>{});throw error;}
}
async function downloadNative(page,{fetchImpl=fetch,timeoutMs=60000,jobId:requestedId,button=null}={}) {
  let download,resolveInline,rejectInline,rejectBlocked,success=false,mediaStarted=false,timer,nativeListener;
  const owned=new Map(),controller=new AbortController();
  const jobId=(()=>{try{const u=new URL(page.url());return u.origin==='https://aivid.dev'?(requestedId||u.pathname.match(/^\/videos\/([a-z0-9_-]+)$/i)?.[1]):null;}catch{return null;}})();
  const relatedToDetail=(()=>{try{return new URL(page.url()).origin==='https://aivid.dev'&&new URL(page.url()).pathname==='/videos/'+jobId;}catch{return false;}})();
  const mediaUrl=value=>inlineVideoUrl(value,jobId,{jobVerified:relatedToDetail});
  const blocked=new Promise((_,reject)=>{rejectBlocked=reject});blocked.catch(()=>{});
  const inline=new Promise((resolve,reject)=>{resolveInline=resolve;rejectInline=reject});inline.catch(()=>{});
  const timed=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Download timed out.'));},timeoutMs)});timed.catch(()=>{});
  const inspect=async target=>{try{
    await target.waitForLoadState('domcontentloaded',{timeout:10000});
    if(securityWarning(await target.title(),await target.locator('body').innerText({timeout:3000}))){
      rejectBlocked(Object.assign(new Error('Microsoft Edge blocked this download. Review its security warning; automatic collection is paused.'),{aividCode:'download_security'}));controller.abort();return;
    }
    const media=mediaUrl(target.url());
    if(!media||mediaStarted)return;
    const src=await target.locator('video').first().evaluate(video=>video.currentSrc||video.src,undefined,{timeout:10000});
    if(mediaUrl(src)!==media||mediaStarted)return;
    mediaStarted=true;
    try{resolveInline(await readInlineVideo(media,{fetchImpl,signal:controller.signal}));}catch(error){rejectInline(error);}
  }catch{}};
  const registerPopup=async target=>{try{
    if(owned.has(target))return;
    const loaded=()=>{void inspect(target)};owned.set(target,loaded);target.on?.('domcontentloaded',loaded);
    // Some source versions start a file download on the popup instead.
    target.on?.('download',popupDownload);
    await inspect(target);
  }catch{}};
  const popup=async target=>{try{if(await target.opener()===page)await registerPopup(target)}catch{}};
  const directPopup=target=>{void registerPopup(target)};
  let resolvePopup;
  const popupFile=new Promise(resolve=>{resolvePopup=resolve});
  const popupDownload=value=>resolvePopup(value);
  const navigated=()=>{void inspect(page)};
  page.context?.().on('page',popup);page.on?.('popup',directPopup);page.on?.('domcontentloaded',navigated);
  try {
    const pending=page.on?new Promise(resolve=>{nativeListener=resolve;page.on('download',nativeListener)}):page.waitForEvent('download',{timeout:timeoutMs});pending.catch(()=>{});
    await (button||page.getByRole('button', { name: 'Download Video', exact: true })).click();
    const result=await Promise.race([pending,popupFile,inline,blocked,timed]);
    if(result?.mimeType==='video/mp4'){success=true;return result;}
    download=result;
    if (await download.failure()) throw new Error();
    const file = await download.path();
    if (!file) throw new Error();
    const size = (await fs.stat(file)).size;
    if (size < 12 || size > MAX_VIDEO_BYTES) throw new Error();
    const data = await fs.readFile(file);
    if (data.length !== size) throw new Error();
    const output=mp4Output(data);success=true;return output;
  } catch(error) { if(error?.aividCode==='download_security')throw error;throw new Error('AIVID did not return a valid MP4 within the download limit. The existing source job will be kept.'); }
  finally {
    clearTimeout(timer);controller.abort();if(nativeListener)page.off('download',nativeListener);page.context?.().off('page',popup);page.off?.('popup',directPopup);page.off?.('domcontentloaded',navigated);
    for(const [target,loaded]of owned){target.off?.('domcontentloaded',loaded);target.off?.('download',popupDownload);if(success)await target.close?.().catch(()=>{});}
    if(success&&mediaUrl(page.url?.()))await page.goto('about:blank#cmmtools-worker',{timeout:10000}).catch(()=>{});
    if(download)await download.delete().catch(()=>{});
  }
}

function collectionFailure(code,message){
  return Object.assign(new Error(message),{aividCode:code});
}

// Observe the account history GET that the Generate page already makes.
// Match the provider ID and its MP4 independently before reading the media.
async function collectSavedVideo(page,id,{fetchImpl=fetch,timeoutMs=60000,checkChallenge=null}={}) {
  if(!/^[a-z0-9_-]{8,100}$/i.test(String(id)))throw new Error('Invalid AIVID job ID.');
  const generateUrl='https://aivid.dev/generate';
  const readHistory=async(number,action)=>{
    const response=page.waitForResponse(response=>{
      const url=new URL(response.url());
      return response.request().method()==='GET'&&url.origin==='https://api.aivid.dev'&&
        url.pathname==='/v2/generations'&&url.searchParams.get('page')===String(number)&&
        Number(url.searchParams.get('pageSize'))>1;
    },{timeout:15000});
    response.catch(()=>{});
    try {
      await action();
      await checkChallenge?.(page);
      const result=await response;
      if(page.url()!==generateUrl||!result.ok())throw new Error('Unavailable history.');
      const history=await result.json();
      if(!Array.isArray(history?.data))throw new Error('Invalid history.');
      return history;
    }catch(error){
      if(error?.aividCode==='session_verification')throw error;
      await checkChallenge?.(page);
      throw collectionFailure('collection_history','AIVID generation history is unavailable.');
    }
  };
  let history=await readHistory(1,()=>page.goto(generateUrl,{waitUntil:'domcontentloaded',timeout:30000}));
  for(let number=1;number<=3;number++){
    const matches=history.data.filter(row=>row?._id===id);
    if(matches.length>1)throw collectionFailure('collection_history','AIVID generation history contains an ambiguous job ID.');
    const job=matches[0];
    if(job){
      if(job.status==='failed'&&typeof job.error==='string'&&
        /^the request failed because the input or output video may contain sensitive information\.?$/i.test(job.error.trim())){
        return {state:'failed',errorCode:'source_sensitive_content'};
      }
      if(['failed','cancelled','canceled'].includes(job.status))return {state:'failed'};
      if(job.status!=='completed')return {state:'pending'};
      // The authenticated history row ties the media to this exact job.
      // AIVID can use a separate asset ID in the MP4 filename.
      const url=inlineVideoUrl(job.video,id,{jobVerified:true});
      if(!url)throw collectionFailure('collection_media_url','AIVID did not provide a verified MP4 for this job.');
      try{
        const output=await readInlineVideo(url,{fetchImpl,signal:AbortSignal.timeout(timeoutMs)});
        return {state:'completed',output};
      }catch(error){
        if(error?.aividCode==='collection_media_pending')throw error;
        throw collectionFailure('collection_download','AIVID did not return a valid MP4 within the download limit. The existing source job will be kept.');
      }
    }
    if(number===3||!(Number(history.metadata?.totalPages)>number))break;
    const more=page.getByRole('button',{name:'Load More',exact:true});
    history=await readHistory(number+1,async()=>{
      await more.waitFor({state:'visible',timeout:5000});
      await more.click({timeout:5000});
    });
  }
  return {state:'pending'};
}

async function takeLock(root) {
  const file = path.join(root, '.aivid-agent.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await fs.unlink(file).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Another agent lock needs inspection. Close all AIVID agents before removing .aivid-agent.lock.');
      try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { await fs.unlink(file); continue; } }
      throw new Error('An AIVID agent is already running. Keep only one agent open.');
    }
  }
  throw new Error('The AIVID agent lock could not be acquired.');
}
// Restricted interactive Edge *page surface* (not the Windows desktop).
// Uses a NEW per-customer Edge user-data directory, never the paid-job
// .aivid-rdp-edge-profile or saved agent credentials.
const MAX_FRAME=450000;
const MAX_VIDEO=100*1024*1024;
const TTL=15*60*1000;

function allowedUrl(value,navigation=false){
  let url;try{url=new URL(value);}catch{return false;}
  if(url.protocol!=='https:'||url.username||url.password)return false;
  const host=url.hostname.toLowerCase();
  if(require('node:net').isIP(host))return false;
  if(host==='localhost'||host.endsWith('.localhost')||host==='metadata.google.internal'||host.endsWith('.internal')||
     /^(?:127|0|10|192\.168)\./.test(host)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)||host==='169.254.169.254')
    return false;
  if(!navigation)return true;
  return host==='aivid.dev'||host.endsWith('.aivid.dev')||
    host==='google.com'||host.endsWith('.google.com')||
    host==='googleusercontent.com'||host.endsWith('.googleusercontent.com');
}
function id(value){if(!/^[1-9]\d{0,14}$/.test(String(value||'')))throw new Error('Invalid customer identity.');return String(value);}
const safeName=value=>String(value||'').replaceAll('\\','/').split('/').pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').slice(0,120)||'reference';
class WindowsLive {
  constructor({root,launch,now=Date.now}={}){
    this.root=root||process.env.AIVID_AGENT_ROOT||__dirname;
    this.launch=launch||((dir)=>require('playwright-core').chromium.launchPersistentContext(dir,{
      executablePath:findBrowser('edge'),headless:false,acceptDownloads:true,
      viewport:{width:1280,height:760},
      args:['--no-first-run','--no-default-browser-check']}));
    this.now=now;this.state=null;
  }
  async shutdown(){
    const old=this.state;this.state=null;
    if(old?.context)await old.context.close().catch(()=>{});
  }
  async open(owner){
    const target=id(owner);
    if(this.state&&this.state.owner!==target&&this.state.expires>this.now())
      throw new Error('Another isolated Premium browser session is active on this Windows agent.');
    if(this.state?.owner===target&&this.state.expires>this.now())return this.state;
    await this.shutdown();
    const dir=path.join(this.root,'.aivid-live-profile-u'+target);
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const context=await this.launch(dir);
    const state={owner:target,context,page:null,expires:this.now()+TTL,
      chooser:null,download:null,notice:'Dedicated Edge profile. Provider sign-in is separate from the AIVID job agent.'};
    this.state=state;
    await context.route('**/*',async route=>{
      const request=route.request();
      const nav=request.isNavigationRequest()||request.resourceType()==='document';
      if(!allowedUrl(request.url(),nav))return route.abort().catch(()=>{});
      return route.continue().catch(()=>{});
    });
    const hooked=new WeakSet();
    const attach=page=>{
      if(hooked.has(page))return;
      hooked.add(page);
      page.on('filechooser',chooser=>{state.chooser=chooser;state.notice='Choose a reference file from CMMTools Upload.';});
      page.on('download',download=>{state.download=download;state.notice='Video download detected. Use Save video in CMMTools.';});
      page.on('close',()=>{if(state.page===page)state.page=context.pages().find(p=>!p.isClosed())||null;});
      // Google OAuth can open a new Edge tab/window within this isolated context.
      page.on('popup',popup=>{state.page=popup;});
    };
    context.on('page',page=>{
      attach(page);
      if(state.page)state.page=page;
    });
    const page=context.pages().find(p=>!p.isClosed())||await context.newPage();
    state.page=page;attach(page);
    try{await page.goto('https://aivid.dev/',{waitUntil:'domcontentloaded',timeout:35000});}
    catch{state.notice='AIVID may need attention. Check the Windows Edge browser.';}
    return state;
  }
  async run(payload,file=null){
    const owner=id(payload.owner),action=String(payload.action);
    if(action==='open')await this.open(owner);
    if(action==='close'){
      if(this.state&&this.state.owner!==owner&&this.state.expires>this.now())throw new Error('Browser belongs to another customer.');
      await this.shutdown();
      return {state:'frame',jpeg:'',url:'',notice:'Closed your private browser session.',fileName:'',uploadPending:false,downloadReady:false};
    }
    const s=this.state;
    if(!s||s.owner!==owner||s.expires<=this.now()){
      if(s&&s.expires<=this.now())await this.shutdown();
      throw new Error('Private browser session not open or expired.');
    }
    let page=s.page;
    if(!page||page.isClosed()){page=s.context.pages().find(p=>!p.isClosed());s.page=page||null;}
    if(!page)throw new Error('The Edge browser was closed.');
    if(action==='click')await page.mouse.click(payload.x,payload.y);
    else if(action==='scroll')await page.mouse.wheel(0,payload.delta);
    else if(action==='type')await page.keyboard.insertText(payload.text);
    else if(action==='key')await page.keyboard.press(payload.key==='Space'?'Space':payload.key);
    else if(action==='upload'){
      if(!s.chooser||!file)throw new Error('Click an AIVID reference upload field first.');
      if(file.length>30*1024*1024||file.length<1)throw new Error('Reference size is outside the limit.');
      const chooser=s.chooser;s.chooser=null;
      await chooser.setInputFiles({name:safeName(payload.file?.name||payload.name),mimeType:payload.file?.mime||payload.mime,data:file});
      s.notice='Reference supplied to AIVID. Confirm the file appears in its editor.';
    }
    else if(action==='download'){
      if(!s.download)throw new Error('Click AIVID Download first, then click Save video in CMMTools.');
      const filePath=await s.download.path();
      if(!filePath)throw new Error('AIVID download has not finished yet.');
      const stat=await fs.stat(filePath);
      if(stat.size<12||stat.size>MAX_VIDEO)throw new Error('Only finished MP4 video files up to 100 MiB are supported.');
      const data=await fs.readFile(filePath);
      if(data.toString('ascii',4,8)!=='ftyp')throw new Error('Provider download is not a valid MP4 file.');
      s.download=null;
      return {state:'download',data};
    }else if(!['open','frame'].includes(action))throw new Error('Unsupported browser operation.');
    let jpeg=await page.screenshot({type:'jpeg',quality:48,timeout:15000});
    if(jpeg.length>MAX_FRAME)jpeg=await page.screenshot({type:'jpeg',quality:24,timeout:15000});
    if(jpeg.length>MAX_FRAME)throw new Error('The browser preview is too large.');
    return {state:'frame',jpeg:jpeg.toString('base64'),url:allowedUrl(page.url(),true)?page.url().slice(0,290):'',
      notice:s.notice.slice(0,290),fileName:s.download?safeName(s.download.suggestedFilename()):'',
      uploadPending:Boolean(s.chooser),downloadReady:Boolean(s.download)};
  }
}


module.exports = { collectSavedVideo, inlineVideoUrl, readInlineVideo, securityWarning, findBrowser, browserProfile, chromiumArguments, startEdge, debuggerEndpoint, connectNative, downloadNative, takeLock, WindowsLive, allowedUrl };

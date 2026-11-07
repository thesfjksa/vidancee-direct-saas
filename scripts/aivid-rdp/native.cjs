'use strict';
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function findChrome(env = process.env, exists = existsSync) {
  const candidates = [env.AIVID_CHROME_PATH, ...[env.PROGRAMFILES || env.ProgramFiles,
    env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
    .map(root => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))].filter(Boolean);
  const found = candidates.find(exists);
  if (!found) throw new Error('Google Chrome is not available. Use the Chrome already installed on your RDP.');
  return found;
}
function chromeArguments(profile, debug = false, initialUrl = 'https://aivid.dev/') {
  if (!['https://aivid.dev/', 'about:blank'].includes(initialUrl)) throw new Error('Unsupported browser start page.');
  return ['--user-data-dir=' + path.resolve(profile), '--new-window',
    ...(debug ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] : []), initialUrl];
}
async function startChrome(profile, { debug = false, env = process.env, start = spawn, initialUrl = 'https://aivid.dev/' } = {}) {
  await fs.mkdir(profile, { recursive: true });
  const child = start(findChrome(env), chromeArguments(profile, debug, initialUrl), { detached: true, stdio: 'ignore', shell: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve); child.once('error', () => reject(new Error('Chrome could not start. Use a writable folder on your RDP.')));
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
async function connectNative(profile, { chromium, fetchImpl = fetch, start = startChrome, timeoutMs = 20000 } = {}) {
  let endpoint = await debuggerEndpoint(profile, fetchImpl);
  if (!endpoint) {
    await start(profile, { debug: true });
    const deadline = Date.now() + timeoutMs;
    while (!endpoint && Date.now() < deadline) { await pause(250); endpoint = await debuggerEndpoint(profile, fetchImpl); }
  }
  if (!endpoint) throw new Error('Close the Chrome windows opened by AIVID-Login.exe, then restart AIVID-Agent.exe. Other Chrome windows can stay open.');
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
    // With connectOverCDP, close disconnects the Playwright transport. Chrome
    // was launched independently and stays running with its saved profile.
    return { browser, context, page, close: async () => { await browser.close().catch(() => {}); } };
  } catch {
    if (browser) await browser.close().catch(() => {});
    throw new Error('The local AIVID Chrome connection failed. Inspect its window on the RDP.');
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
      rejectBlocked(Object.assign(new Error('Chrome blocked this download. Review its security warning; automatic collection is paused.'),{aividCode:'download_security'}));controller.abort();return;
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
async function collectSavedVideo(page,id,{fetchImpl=fetch,timeoutMs=60000}={}) {
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
      const result=await response;
      if(page.url()!==generateUrl||!result.ok())throw new Error('Unavailable history.');
      const history=await result.json();
      if(!Array.isArray(history?.data))throw new Error('Invalid history.');
      return history;
    }catch{
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
module.exports = { collectSavedVideo, inlineVideoUrl, readInlineVideo, securityWarning, findChrome, chromeArguments, startChrome, debuggerEndpoint, connectNative, downloadNative, takeLock };

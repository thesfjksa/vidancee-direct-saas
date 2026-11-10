'use strict';
/**
 * Optional AIVID Live Studio: a remote-browser canvas embedded in CMMTools,
 * never a direct aivid.dev iframe. Direct clicks bill AIVID, not CMMTools.
 * Each allowlisted user gets an isolated, short-lived Browserless context.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Busboy=require('busboy');
const {chromium}=require('playwright-core');
const sessions=new Map();
const TTL=10*60*1000;
const CHOOSER_TTL=2*60*1000;
const MAX_UPLOAD=45*1024*1024;
const MAX_DOWNLOAD=60*1024*1024;
const MAX_FILES=30;
const MAX_DOWNLOADS=3;
const bool=v=>/^(1|true|yes|on)$/i.test(String(v||''));
const set=v=>new Set(String(v||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const forbidden=message=>fail(message,403);
function allowed(user,env=process.env){
  return bool(env.AIVID_LIVE_VIEW_ENABLED)&&Boolean(user?.id)&&(
    set(env.AIVID_LIVE_VIEW_ALLOWED_EMAILS).has(String(user.email||'').toLowerCase())||
    set(env.AIVID_LIVE_VIEW_ALLOWED_IDS).has(String(user.id)));
}
function endpoint(env=process.env){
  let u;
  try{u=new URL(String(env.AIVID_LIVE_VIEW_BROWSERLESS_WS||''));}catch{throw fail('Live browser endpoint is not configured.',503)}
  if(u.protocol!=='wss:'||!u.hostname.endsWith('.browserless.io')||u.username||u.password||!u.searchParams.get('token'))
    throw fail('Secure Browserless websocket with a token required.',503);
  return u.toString();
}
const CSS=':root{--cmm-accent:#3479ee}header img[alt*="aivid" i],nav img[alt*="aivid" i],aside img[alt*="aivid" i],header svg[aria-label*="aivid" i],nav svg[aria-label*="aivid" i]{visibility:hidden!important}button,input,textarea,select{border-radius:10px!important}button:focus-visible,input:focus-visible{outline:2px solid var(--cmm-accent)!important}';
const SCRIPT='(function(){'+
  'function rewrite(){if(document.title!=="CMMTools Video Studio")document.title="CMMTools Video Studio";'+
  'for(const el of document.querySelectorAll("header,nav,aside,[role=banner]")){'+
  'const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes=[];while(w.nextNode())nodes.push(w.currentNode);'+
  'for(const n of nodes){if(/\\baivid(?:\\.dev)?\\b/i.test(n.nodeValue))n.nodeValue=n.nodeValue.replace(/\\baivid(?:\\.dev)?\\b/gi,"CMMTools");}}'+
  'if(!document.querySelector("style[data-cmm-skin]")){const s=document.createElement("style");s.setAttribute("data-cmm-skin","1");s.textContent='+JSON.stringify(CSS)+';(document.head||document.documentElement).appendChild(s);}}'+
  'function start(){rewrite();new MutationObserver(rewrite).observe(document.documentElement,{subtree:true,childList:true,characterData:true});}'+
  'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();})();';

function originOk(req){
  const origin=String(req.headers.origin||''),host=String(req.headers.host||'').trim().toLowerCase();
  if(!origin||!host)return false;
  try{const u=new URL(origin);return u.host.toLowerCase()===host&&(u.protocol==='https:'||/^localhost(?::\d+)?$/.test(host));}catch{return false}
}
function send(res,status,data){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
  res.end(JSON.stringify(data));
}
function activeSession(userId){
  const s=sessions.get(String(userId));
  if(!s||s.expires<=Date.now())throw fail('Studio session expired. Reopen Studio to continue.',409);
  return s;
}
function state(s){
  return {active:true,expiresAt:s.expires,uploadPending: Boolean(s.pendingUpload&&s.pendingUpload.expires>Date.now()&&!s.uploading),
    uploading:Boolean(s.uploading),downloads:[...s.downloads.values()].map(x=>({id:x.id,name:x.name,size:x.data.length})),
    downloadsEnabled:s.downloadsEnabled,notice:s.notice||''};
}
function safeName(value){
  const name=String(value||'').replace(/\\/g,'/').split('/').pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').trim();
  return name.slice(0,120)||'reference';
}
const TYPES=Object.freeze({
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4',
});
function validFile({name,mimeType,data}){
  const ext=path.extname(name).toLowerCase(),expected=TYPES[ext];
  if(!expected)throw fail('Choose PNG/JPG/WebP images, MP4/MOV/WebM videos, or MP3/WAV/M4A audio only.',415);
  if(mimeType&&mimeType!=='application/octet-stream'&&mimeType!==expected&&!(ext==='.jpg'&&mimeType==='image/jpg'))
    throw fail('Reference file extension and media type do not match.',415);
  if(!Buffer.isBuffer(data)||!data.length)throw fail('Empty reference file.',400);
  return {name,mimeType:expected,data};
}
function parseUploads(req){
  return new Promise((resolve,reject)=>{
    const type=String(req.headers['content-type']||'');
    if(!type.startsWith('multipart/form-data;'))return reject(fail('Use multipart/form-data for references.',415));
    const size=Number(req.headers['content-length']||0);
    if(Number.isFinite(size)&&size>MAX_UPLOAD+40960)return reject(fail('Total reference upload exceeds 45 MiB.',413));
    let bb;try{bb=Busboy({headers:req.headers,limits:{files:MAX_FILES,fileSize:30*1024*1024,parts:MAX_FILES,fields:0}})}
    catch{return reject(fail('Invalid multipart upload.'))}
    const items=[];let total=0,problem=null,settled=false;
    const rejectOnce=e=>{if(!problem)problem=e;};
    bb.on('file',(_field,stream,info)=>{
      const chunks=[];let length=0;
      stream.on('limit',()=>rejectOnce(fail('Reference file exceeds 30 MiB.',413)));
      stream.on('data',chunk=>{
        total+=chunk.length;length+=chunk.length;
        if(total>MAX_UPLOAD)rejectOnce(fail('Total reference upload exceeds 45 MiB.',413));
        if(!problem)chunks.push(chunk);
      });
      stream.on('end',()=>{
        if(problem)return;
        try{items.push(validFile({name:safeName(info.filename),mimeType:info.mimeType,data:Buffer.concat(chunks,length)}));}
        catch(e){rejectOnce(e);}
      });
      stream.on('error',rejectOnce);
    });
    bb.on('filesLimit',()=>rejectOnce(fail('Too many reference files (30 maximum).',413)));
    bb.on('partsLimit',()=>rejectOnce(fail('Too many multipart fields.',413)));
    bb.on('field',()=>rejectOnce(fail('Only reference files may be uploaded.',400)));
    bb.on('error',e=>rejectOnce(fail('Invalid multipart upload.')));
    bb.on('close',()=>{if(settled)return;settled=true;if(problem||!items.length)reject(problem||fail('Select at least one reference file.'));else resolve(items);});
    req.on('aborted',()=>{if(!settled){settled=true;reject(fail('Upload interrupted.',400));}});
    req.pipe(bb);
  });
}
function captureDownload(s,result){
  // Only completed provider video downloads are eligible for the customer
  // download bridge. Never expose arbitrary browser files or local paths.
  if(!result||result.error){s.notice='The remote browser could not transfer this download (file may exceed its limit).';return false;}
  const name=safeName(result.filename),extension=path.extname(name).toLowerCase();
  if(!['.mp4','.mov','.webm'].includes(extension))return false;
  const size=Number(result.size),encoded=String(result.data||'');
  if(!Number.isInteger(size)||size<12||size>MAX_DOWNLOAD||encoded.length>Math.ceil(MAX_DOWNLOAD*4/3)+16)return false;
  const data=Buffer.from(encoded,'base64');
  if(data.length!==size)return false;
  if((extension==='.mp4'||extension==='.mov')?data.toString('ascii',4,8)!=='ftyp':!data.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return false;
  const id=crypto.randomUUID();
  while(s.downloads.size>=MAX_DOWNLOADS)s.downloads.delete(s.downloads.keys().next().value);
  s.downloads.set(id,{id,name,data,contentType:extension==='.webm'?'video/webm':extension==='.mov'?'video/quicktime':'video/mp4'});
  s.notice='Video downloaded in the remote browser. Save it from the Downloads panel.';
  return true;
}
async function uploadToChooser(s,files){
  const pending=s.pendingUpload;
  if(!pending||pending.expires<=Date.now())throw fail('Click Upload references in the embedded AIVID page before choosing local files.',409);
  if(s.uploading)throw fail('A reference transfer is already in progress.',409);
  const chooserPage=pending.chooser.page();
  if(!['aivid.dev','www.aivid.dev'].includes(new URL(chooserPage.url()).hostname))
    throw forbidden('Reference uploads are only allowed on the AIVID page.');
  s.uploading=true;s.pendingUpload=null;
  const element=await pending.chooser.element();
  const marker=crypto.randomUUID();
  try{
    const matches=await element.evaluate((input,id)=>{
      if(input.tagName!=='INPUT'||input.type!=='file')return false;
      input.setAttribute('data-cmm-live-upload',id);return true;
    },marker);
    if(!matches)throw fail('The AIVID reference chooser is no longer available.',409);
    const cdp=await s.context.newCDPSession(chooserPage);
    try{
      const uploaded=await cdp.send('Browserless.uploadFile',{
        selector:'input[type="file"][data-cmm-live-upload="'+marker+'"]',
        files:files.map(file=>({name:file.name,mimeType:file.mimeType,content:file.data.toString('base64')})),
      });
      if(uploaded?.ok!==true)throw fail('The remote browser rejected this reference transfer. Try selecting files again.',502);
    }finally{await cdp.detach().catch(()=>{});}
    s.notice=files.length+' reference file(s) transferred to the AIVID form.';
    return {ok:true,count:files.length};
  }finally{
    await element.evaluate((input,id)=>{if(input.getAttribute('data-cmm-live-upload')===id)input.removeAttribute('data-cmm-live-upload');},marker).catch(()=>{});
    s.uploading=false;
  }
}
async function stop(id){
  const key=String(id),s=sessions.get(key);
  if(!s)return;
  sessions.delete(key);
  s.pendingUpload=null;s.downloads.clear();
  await s.browser.close().catch(()=>{});
}
async function start(user,{env=process.env,connect=chromium.connectOverCDP}={}){
  if(!allowed(user,env))throw forbidden('Interactive Studio is not enabled for this user.');
  if(!bool(env.AIVID_LIVE_VIEW_DIRECT_BILLING_ACK))throw forbidden('Operator must explicitly acknowledge provider-direct billing before enabling this pilot.');
  const id=String(user.id),existing=sessions.get(id);
  if(existing&&existing.expires>Date.now())return{liveURL:existing.url,expiresAt:existing.expires};
  if(existing)await stop(id);
  if(sessions.size>=2)throw fail('Pilot is at capacity.',429);
  let browser;
  try{
    browser=await connect(endpoint(env),{timeout:30000});
    const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true});
    const s={browser,context,expires:Date.now()+TTL,url:null,pendingUpload:null,uploading:false,downloads:new Map(),downloadsEnabled:false,notice:''};
    const listenPage=page=>{
      page.on('filechooser',chooser=>{s.pendingUpload={chooser,expires:Date.now()+CHOOSER_TTL};s.notice='Select your local reference files using the toolbar above.';});
    };
    context.on('page',listenPage);
    const page=await context.newPage();listenPage(page);
    const cdp=await context.newCDPSession(page);
    cdp.on('Browserless.fileDownloaded',result=>{if(sessions.get(id)===s)captureDownload(s,result);});
    // Must use the same CDP session for enabling downloads and receiving
    // Browserless.fileDownloaded. Browserless may enforce a transfer-size cap.
    const downloads=await cdp.send('Browserless.setDownloadEnabled',{enabled:true});
    s.downloadsEnabled=downloads?.ok===true&&downloads?.enabled===true;
    await page.addInitScript({content:SCRIPT});
    await page.goto('https://aivid.dev/',{waitUntil:'domcontentloaded',timeout:30000});
    await page.addStyleTag({content:CSS}).catch(()=>{});
    // Follow Google OAuth popup tabs. The browser interface enables the user
    // to navigate those tabs, but Google can still deny embedded sign-in.
    const result=await cdp.send('Browserless.liveURL',{
      mode:'follow',interactable:true,resizable:true,showBrowserInterface:true,timeout:TTL,
    });
    if(result?.error||!result?.liveURL)throw new Error('No live viewer available');
    const u=new URL(result.liveURL);
    if(u.protocol!=='https:'||!u.hostname.endsWith('.browserless.io'))throw new Error('Invalid viewer URL');
    s.url=result.liveURL;
    s.expires=Date.now()+Math.min(TTL,Number(result.timeout)||TTL);
    sessions.set(id,s);
    return{liveURL:s.url,expiresAt:s.expires};
  }catch{
    if(browser)await browser.close().catch(()=>{});
    throw fail('Unable to start the interactive browser. Check the Browserless plan, endpoint, or session availability.',503);
  }
}
async function handle(req,res,route,{requireUser,requireDatabase}={}){
  if(route!=='/aivid-live-studio'&&!route.startsWith('/api/aivid-live-studio/'))return false;
  try{
    requireDatabase();
    const user=await requireUser(req);
    if(!allowed(user))throw forbidden('This pilot is not enabled for this account.');
    if(route==='/aivid-live-studio'&&req.method==='GET'){
      const page=fs.readFileSync(path.join(__dirname,'..','public','aivid-live-studio.html'));
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':page.length,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src https://*.browserless.io; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"});
      res.end(page);return true;
    }
    const download=route.match(/^\/api\/aivid-live-studio\/download\/([0-9a-f-]{36})$/i);
    if(download&&req.method==='GET'){
      const s=activeSession(user.id),entry=s.downloads.get(download[1]);
      if(!entry)throw fail('This video download has expired or was already saved.',404);
      s.downloads.delete(download[1]);
      res.writeHead(200,{'content-type':entry.contentType,'content-length':entry.data.length,
        'content-disposition':'attachment; filename="'+entry.name.replace(/[^a-zA-Z0-9_.-]/g,'_')+'"',
        'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
        'content-security-policy':"default-src 'none'"});
      res.end(entry.data);return true;
    }
    if(route==='/api/aivid-live-studio/status'&&req.method==='GET'){
      send(res,200,{ok:true,...state(activeSession(user.id))});return true;
    }
    if(!originOk(req))throw forbidden('Same-origin request required.');
    if(route==='/api/aivid-live-studio/start'&&req.method==='POST'){send(res,200,{ok:true,...await start(user)});return true;}
    if(route==='/api/aivid-live-studio/stop'&&req.method==='POST'){await stop(user.id);send(res,200,{ok:true});return true;}
    if(route==='/api/aivid-live-studio/upload'&&req.method==='POST'){
      const s=activeSession(user.id);
      if(!s.pendingUpload||s.pendingUpload.expires<=Date.now())throw fail('Choose Upload references inside AIVID first.',409);
      if(s.uploading)throw fail('An upload is already running.',409);
      const files=await parseUploads(req);
      send(res,200,await uploadToChooser(s,files));return true;
    }
    send(res,404,{ok:false,error:'Not found.'});return true;
  }catch(e){send(res,e?.statusCode||503,{ok:false,error:e?.statusCode?e.message:'Live Studio unavailable.'});return true;}
}
setInterval(()=>{for(const [id,s] of sessions)if(s.expires<=Date.now())void stop(id)},30000).unref?.();
module.exports={allowed,endpoint,originOk,start,stop,handle,SCRIPT,CSS,state,validFile,captureDownload,uploadToChooser,parseUploads};

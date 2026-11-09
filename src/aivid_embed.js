'use strict';
/**
 * Isolated AIVID Live Studio pilot. This does NOT meter CMMTools credits.
 * Disabled by default and allowlisted so no customer can use an unbilled
 * source account without an explicit operator deployment decision.
 */
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright-core');
const sessions=new Map();
const TTL=10*60*1000;
const bool=v=>/^(1|true|yes|on)$/i.test(String(v||''));
const set=v=>new Set(String(v||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
const forbidden=message=>Object.assign(new Error(message),{statusCode:403});
function allowed(user,env=process.env){
  return bool(env.AIVID_LIVE_VIEW_ENABLED)&&Boolean(user?.id)&&(
    set(env.AIVID_LIVE_VIEW_ALLOWED_EMAILS).has(String(user.email||'').toLowerCase())||
    set(env.AIVID_LIVE_VIEW_ALLOWED_IDS).has(String(user.id)));
}
function endpoint(env=process.env){
  let u;
  try{u=new URL(String(env.AIVID_LIVE_VIEW_BROWSERLESS_WS||''));}catch{throw Object.assign(new Error('Live browser endpoint is not configured.'),{statusCode:503})}
  if(u.protocol!=='wss:'||!u.hostname.endsWith('.browserless.io')||u.username||u.password||!u.searchParams.get('token'))
    throw Object.assign(new Error('Secure Browserless websocket with a token required.'),{statusCode:503});
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
  const origin=String(req.headers.origin||''),host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim().toLowerCase();
  if(!origin||!host)return false;
  try{const u=new URL(origin);return u.host.toLowerCase()===host&&(u.protocol==='https:'||/^localhost(?::\d+)?$/.test(host));}catch{return false}
}
function send(res,status,data){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
  res.end(JSON.stringify(data));
}
async function stop(id){
  const key=String(id),s=sessions.get(key);
  if(!s)return;
  sessions.delete(key);
  await s.browser.close().catch(()=>{});
}
async function start(user,{env=process.env,connect=chromium.connectOverCDP}={}){
  if(!allowed(user,env))throw forbidden('Interactive Studio is not enabled for this user.');
  if(!bool(env.AIVID_LIVE_VIEW_DIRECT_BILLING_ACK))throw forbidden('Operator must explicitly acknowledge provider-direct billing before enabling this pilot.');
  const id=String(user.id),existing=sessions.get(id);
  if(existing&&existing.expires>Date.now())return{liveURL:existing.url,expiresAt:existing.expires};
  if(existing)await stop(id);
  if(sessions.size>=2)throw Object.assign(new Error('Pilot is at capacity.'),{statusCode:429});
  let browser;
  try{
    browser=await connect(endpoint(env),{timeout:30000});
    const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true});
    const page=await context.newPage();
    await page.addInitScript({content:SCRIPT});
    await page.goto('https://aivid.dev/',{waitUntil:'domcontentloaded',timeout:30000});
    await page.addStyleTag({content:CSS}).catch(()=>{});
    const cdp=await context.newCDPSession(page);
    const result=await cdp.send('Browserless.liveURL',{interactable:true,resizable:false,showBrowserInterface:false,timeout:TTL});
    const u=new URL(result.liveURL);
    if(u.protocol!=='https:'||!u.hostname.endsWith('.browserless.io'))throw new Error('Invalid viewer URL');
    const expires=Date.now()+TTL;
    sessions.set(id,{browser,url:result.liveURL,expires});
    return{liveURL:result.liveURL,expiresAt:expires};
  }catch{
    if(browser)await browser.close().catch(()=>{});
    throw Object.assign(new Error('Unable to start the live browser. Check Browserless configuration and sign-in.'),{statusCode:503});
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
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':page.length,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src https://*.browserless.io; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'"});
      res.end(page);return true;
    }
    if(!originOk(req))throw forbidden('Same-origin request required.');
    if(route==='/api/aivid-live-studio/start'&&req.method==='POST'){send(res,200,{ok:true,...await start(user)});return true;}
    if(route==='/api/aivid-live-studio/stop'&&req.method==='POST'){await stop(user.id);send(res,200,{ok:true});return true;}
    send(res,404,{ok:false,error:'Not found.'});return true;
  }catch(e){send(res,e?.statusCode||503,{ok:false,error:e?.statusCode?e.message:'Live Studio unavailable.'});return true;}
}
setInterval(()=>{for(const [id,s] of sessions)if(s.expires<=Date.now())void stop(id)},30000).unref?.();
module.exports={allowed,endpoint,originOk,start,stop,handle,SCRIPT,CSS};

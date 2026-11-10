'use strict';

/**
 * CMMTools' authenticated entry to a separately secured Apache Guacamole
 * RDP gateway. CMMTools does not proxy RDP, copy RDP passwords or act as a
 * substitute for Guacamole's own user-level authentication and permissions.
 * No Browserless session is created by this route.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const PAGE_ROUTES=new Set(['/rdp-studio','/aivid-live-studio']);
const CONFIG_ROUTE='/api/rdp-studio/config';
const LEGACY_API_PREFIX='/api/aivid-live-studio/';
const enabled=value=>/^(?:true|1|on|yes)$/i.test(String(value||''));
const list=value=>new Set(String(value||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
const error=(message,statusCode=403)=>Object.assign(new Error(message),{statusCode});

function allowed(user,env=process.env){
  if(!enabled(env.AIVID_RDP_VIEW_ENABLED)||!Number.isSafeInteger(Number(user?.id))||Number(user.id)<1)return false;
  return list(env.AIVID_RDP_VIEW_ALLOWED_IDS).has(String(user.id))||
    Boolean(user.email&&list(env.AIVID_RDP_VIEW_ALLOWED_EMAILS).has(String(user.email).toLowerCase()));
}

function gatewayUrl(env=process.env){
  const raw=String(env.AIVID_RDP_VIEW_URL||'').trim();
  let u;
  try{u=new URL(raw);}catch{throw error('RDP gateway URL is not configured.',503);}
  // A trusted, standalone Guacamole origin is necessary. Never embed the
  // CMMTools origin (sandbox allow-same-origin) or an unknown login/token URL.
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||
     (u.port&&u.port!=='443')||!/^\/guacamole\/?$/.test(u.pathname)||
     !u.hostname.includes('.')||u.hostname==='cmmtools.site'||
     ['aivid.dev','www.aivid.dev','localhost','127.0.0.1'].includes(u.hostname))
    throw error('The RDP gateway must be a dedicated HTTPS Guacamole origin with no embedded credentials.',503);
  return u.origin+'/guacamole/';
}

async function customerSourceAllowed(userId,db=require('./db.js').getPool()){
  const [rows]=await db.execute('SELECT enabled FROM user_provider_access WHERE user_id=? AND provider=? LIMIT 1',
    [Number(userId),'aivid']);
  return !rows.length||Number(rows[0].enabled)===1;
}

function assertEnabled(user,env=process.env){
  if(!allowed(user,env))throw error('Remote desktop is not enabled for this CMMTools account.');
  if(!enabled(env.AIVID_RDP_VIEW_ISOLATION_ACK))
    throw error('An administrator must confirm isolated Guacamole and Windows accounts before enabling desktop sharing.',503);
  if(!enabled(env.AIVID_RDP_VIEW_DIRECT_BILLING_ACK))
    throw error('An administrator must acknowledge direct provider billing before enabling the remote studio.',503);
  return gatewayUrl(env);
}

function reply(res,status,payload){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
  res.end(JSON.stringify(payload));
}

function page(res,url){
  const nonce=crypto.randomBytes(20).toString('base64');
  const html=fs.readFileSync(path.join(__dirname,'..','public','aivid-live-studio.html'),'utf8')
    .replaceAll('__CMM_RDP_NONCE__',nonce);
  const origin=new URL(url).origin;
  res.writeHead(200,{'content-type':'text/html; charset=utf-8',
    'cache-control':'private, no-store, max-age=0','x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer','x-frame-options':'DENY',
    'permissions-policy':'camera=(), microphone=(), geolocation=()',
    'content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src "+origin+
      "; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-"+nonce+"'"});
  res.end(html);
}

async function handle(req,res,route,{requireUser,requireDatabase,checkSourceAccess=customerSourceAllowed}={}){
  if(!PAGE_ROUTES.has(route)&&route!==CONFIG_ROUTE&&!route.startsWith(LEGACY_API_PREFIX))return false;
  try{
    // Authenticate before inspecting the feature configuration or
    // publishing the iframe URL. Never include a Guacamole/RDP credential.
    requireDatabase();
    const user=await requireUser(req);
    const url=assertEnabled(user);
    if(!await checkSourceAccess(user.id))throw error('Premium desktop access was disabled in this customer’s AIVID Sources settings.');
    if(PAGE_ROUTES.has(route)&&req.method==='GET'){page(res,url);return true;}
    if(route===CONFIG_ROUTE&&req.method==='GET'){
      reply(res,200,{ok:true,gatewayUrl:url,transport:'rdp',fileTransfer:'guacamole-virtual-drive',
        separateGatewayLogin:true,directBilling:true});return true;
    }
    if(route.startsWith(LEGACY_API_PREFIX)){
      reply(res,410,{ok:false,error:'The Browserless live-view API was retired. Use the RDP desktop gateway.'});return true;
    }
    reply(res,405,{ok:false,error:'Method not allowed.'});return true;
  }catch(e){
    const status=[403,405,410,503].includes(e?.statusCode)?e.statusCode:503;
    reply(res,status,{ok:false,error:e?.statusCode?e.message:'Remote desktop is unavailable.'});
    return true;
  }
}
module.exports={allowed,gatewayUrl,assertEnabled,customerSourceAllowed,handle,page};

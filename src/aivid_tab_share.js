'use strict';
/**
 * VIEW-ONLY tab sharing from an owner-opened ordinary Edge AIVID tab.
 * No Playwright, CDP, content scripts, DOM injection, browser automation or
 * Windows desktop access in this transport. Frames are memory-only, over HTTPS.
 */
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {readConfig,authorized}=require('./aivid_windows_settings.js');
const {customerSourceAllowed}=require('./aivid_rdp_viewer.js');

const PAGE_ROUTES=new Set(['/aivid-live-studio','/rdp-studio']);
const API='/api/windows-studio/';
const EXT='/api/aivid-tab-share/';
const MAX_FRAME=350*1024;
const FRAME_INTERVAL=2500;
const FRESH_MS=12000;
const PAIR_MS=5*60*1000;
const SESSION_MS=2*60*60*1000;
const MAX_PAIR_ATTEMPTS=8;
let session=null;
const hash=s=>crypto.createHash('sha256').update(s).digest();
const secureEqual=(a,b)=>Buffer.isBuffer(a)&&Buffer.isBuffer(b)&&a.length===b.length&&crypto.timingSafeEqual(a,b);
function fail(message,statusCode=400){return Object.assign(new Error(message),{statusCode,shareSafe:true});}
function send(res,status,payload){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
  res.end(JSON.stringify(payload));
}
const activeConfig=c=>c?.enabled===true&&c.directBillingAcknowledged===true;
function extensionOrigin(req){
  const raw=String(req.headers?.origin||'');
  if(!/^chrome-extension:\/\/[a-p]{32}$/.test(raw))throw fail('Install the CMMTools Edge extension and share from its controller.',403);
  return raw;
}
function cors(res,origin,additional={}){
  return {'access-control-allow-origin':origin,'vary':'origin',
    'access-control-allow-methods':'POST, OPTIONS',
    'access-control-allow-headers':'content-type, x-cmm-share-token',
    'access-control-max-age':'600',...additional};
}
function publicStatus(now=Date.now()){
  return {mode:'manual-edge-extension',viewOnly:true,noBrowserAutomation:true,
    paired:Boolean(session?.tokenHash&&session.expires>now),
    connected:Boolean(session?.frame&&session.expires>now&&now-session.lastFrameAt<FRESH_MS),
    lastFrameAt:session?.lastFrameAt||null,
    pairPending:Boolean(session?.pairHash&&session.pairExpires>now),
    frameIntervalMs:FRAME_INTERVAL};
}
function newPairing(now=Date.now()){
  const code=crypto.randomBytes(16).toString('hex').toUpperCase();
  session={pairHash:hash(code),pairExpires:now+PAIR_MS,attempts:0,
    tokenHash:null,extensionOrigin:null,expires:0,frame:null,lastFrameAt:0,previousFrameAt:0};
  return {code,expiresAt:new Date(now+PAIR_MS).toISOString()};
}
function pair(code,origin,now=Date.now()){
  if(!session?.pairHash||session.pairExpires<=now)throw fail('No active pairing code. Generate a new code in Admin.',403);
  if(++session.attempts>MAX_PAIR_ATTEMPTS){session=null;throw fail('Pairing attempts exceeded. Generate a new code.',429);}
  const input=typeof code==='string'&&/^[A-Fa-f0-9]{32}$/.test(code)?hash(code.toUpperCase()):Buffer.alloc(32);
  if(!secureEqual(input,session.pairHash))throw fail('Invalid pairing code.',403);
  const token=crypto.randomBytes(32).toString('base64url');
  session.pairHash=null;session.pairExpires=0;session.tokenHash=hash(token);
  session.extensionOrigin=origin;session.expires=now+SESSION_MS;session.frame=null;
  return {token,expiresAt:new Date(session.expires).toISOString(),frameIntervalMs:FRAME_INTERVAL};
}
function assertPublisher(token,origin,now=Date.now()){
  if(!session?.tokenHash||session.expires<=now||session.extensionOrigin!==origin)
    throw fail('Sharing session has expired or was revoked. Pair again in Admin.',403);
  if(typeof token!=='string'||!secureEqual(hash(token),session.tokenHash))
    throw fail('Sharing token was rejected. Pair the extension again.',401);
}
function publish(data,token,origin,now=Date.now()){
  assertPublisher(token,origin,now);
  if(!Buffer.isBuffer(data)||data.length<100||data.length>MAX_FRAME||
    data[0]!==0xff||data[1]!==0xd8||data.at(-2)!==0xff||data.at(-1)!==0xd9)
    throw fail('Only a bounded JPEG snapshot of the selected AIVID tab is accepted.',413);
  if(now-session.previousFrameAt<1400)throw fail('Preview updates are too frequent.',429);
  session.frame=Buffer.from(data);session.lastFrameAt=now;session.previousFrameAt=now;
  return {accepted:true};
}
function currentFrame(now=Date.now()){
  if(!publicStatus(now).connected)return null;
  return session.frame;
}
function stop(){session=null;}
async function readJson(req,max=2048){
  let bytes=0;const parts=[];
  for await(const chunk of req){bytes+=chunk.length;if(bytes>max)throw fail('Request too large.',413);parts.push(chunk);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fail('Invalid JSON.');}
}
async function readJPEG(req){
  const declared=req.headers['content-length'];
  if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)>MAX_FRAME||Number(declared)<100))
    throw fail('JPEG frame is too large.',413);
  let size=0;const parts=[];
  for await(const chunk of req){size+=chunk.length;if(size>MAX_FRAME)throw fail('JPEG frame is too large.',413);parts.push(chunk);}
  return Buffer.concat(parts,size);
}
function viewerPage(res){
  const nonce=crypto.randomBytes(24).toString('base64');
  const html=fs.readFileSync(path.join(__dirname,'..','public','aivid-windows-studio.html'),'utf8').replaceAll('__CMM_NONCE__',nonce);
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store',
    'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'permissions-policy':'camera=(), microphone=(), geolocation=()',
    'content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src blob:; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-"+nonce+"'"});
  res.end(html);
}
async function handle(req,res,route,{requireDatabase,requireUser,
    loadSettings=readConfig,checkSourceAccess=customerSourceAllowed,now=Date.now}={}){
  if(!PAGE_ROUTES.has(route)&&!route.startsWith(API)&&!route.startsWith(EXT))return false;
  try{
    requireDatabase();
    if(route.startsWith(EXT)){
      const origin=extensionOrigin(req);
      if(req.method==='OPTIONS'){
        res.writeHead(204,cors(res,origin,{'cache-control':'no-store'}));res.end();return true;
      }
      if(req.method!=='POST')throw fail('Method not allowed.',405);
      if(!activeConfig(await loadSettings()))throw fail('Tab sharing is disabled in CMMTools Admin.',403);
      if(route===EXT+'pair'){
        const input=await readJson(req);
        const result=pair(input.code,origin,now());
        res.writeHead(200,cors(res,origin,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}));
        res.end(JSON.stringify({ok:true,...result}));return true;
      }
      if(route===EXT+'frame'){
        const token=String(req.headers['x-cmm-share-token']||'');
        assertPublisher(token,origin,now()); // Reject before reading large request body.
        const result=publish(await readJPEG(req),token,origin,now());
        res.writeHead(200,cors(res,origin,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}));
        res.end(JSON.stringify({ok:true,...result}));return true;
      }
      throw fail('Route not found.',404);
    }
    const user=await requireUser(req);
    authorized(user,await loadSettings());
    if(!await checkSourceAccess(user.id))throw fail('AIVID is disabled in your Sources settings.',403);
    if(PAGE_ROUTES.has(route)&&req.method==='GET'){viewerPage(res);return true;}
    if(route===API+'config'||route===API+'status'){
      if(req.method!=='GET')throw fail('Method not allowed.',405);
      send(res,200,{ok:true,...publicStatus(now()),notice:'View-only ordinary Edge tab share; no remote commands.'});return true;
    }
    if(route===API+'frame'&&req.method==='GET'){
      const frame=currentFrame(now());
      if(!frame){res.writeHead(204,{'cache-control':'no-store','x-content-type-options':'nosniff'});res.end();return true;}
      res.writeHead(200,{'content-type':'image/jpeg','content-length':frame.length,'cache-control':'private, no-store',
        'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'"});
      res.end(frame);return true;
    }
    // Explicitly retire old RDP/Playwright click, type, upload and download APIs.
    if(route===API+'action'||route===API+'upload')throw fail(
      'Remote browser automation is disabled. Use your normal Microsoft Edge and CMMTools Tab Share extension.',410);
    throw fail('Route not found.',404);
  }catch(error){
    const status=error?.shareSafe||error?.studioSafe?error.statusCode:error?.statusCode&&[401,403].includes(error.statusCode)?error.statusCode:503;
    const payload={ok:false,error:error?.shareSafe||error?.studioSafe?error.message:
      status===401||status===403?'This CMMTools account cannot access the shared tab.':'Manual Edge sharing is unavailable.'};
    if(route.startsWith(EXT)){
      let origin;try{origin=extensionOrigin(req);}catch{}
      res.writeHead(status,origin?cors(res,origin,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}):
        {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(JSON.stringify(payload));return true;
    }
    send(res,status,payload);return true;
  }
}
async function handleAdmin(req,res,route,{readJson:readAdminJson=readJson,loadSettings=readConfig}={}){
  if(!route.startsWith('/admin/aivid/tab-share/'))return false;
  try{
    if(req.method==='GET'&&route==='/admin/aivid/tab-share/status'){
      send(res,200,{ok:true,...publicStatus()});return true;
    }
    if(req.method==='POST'&&route==='/admin/aivid/tab-share/pair'){
      if(!activeConfig(await loadSettings()))throw fail('Enable Windows Studio for a trusted account in Admin first.',409);
      send(res,200,{ok:true,...newPairing()});return true;
    }
    if(req.method==='POST'&&route==='/admin/aivid/tab-share/stop'){
      stop();send(res,200,{ok:true,connected:false,paired:false});return true;
    }
    throw fail('Method not allowed.',405);
  }catch(error){send(res,error?.statusCode||503,{ok:false,error:error?.shareSafe?error.message:'Tab sharing is unavailable.'});return true;}
}
module.exports={MAX_FRAME,FRAME_INTERVAL,PAIR_MS,SESSION_MS,publicStatus,newPairing,pair,
  assertPublisher,publish,currentFrame,stop,handle,handleAdmin,readJPEG};

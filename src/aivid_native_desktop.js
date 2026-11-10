'use strict';
/**
 * Opt-in Windows-NATIVE remote browser viewport. No Playwright, CDP, DOM
 * events, browser extension, RDP port, credentials, or Windows desktop stream.
 * The Windows helper is manually started in a dedicated non-admin session.
 *
 * Screenshots and input queue are PROCESS MEMORY ONLY. One host, one active
 * controller, an absolute 90-minute lifetime and immediate Admin revocation.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readConfig,authorized}=require('./aivid_windows_settings.js');
const {customerSourceAllowed}=require('./aivid_rdp_viewer.js');
const {originOk}=require('./aivid_embed.js');
const VIEW='/aivid-interactive-studio',API='/api/aivid-native/',ADMIN='/admin/aivid/native/';
const MAX_FRAME=490*1024,PAIR_MS=5*60*1000,SESSION_MS=90*60*1000,FRESH_MS=12000,CONTROL_TTL_MS=60*1000;
const hash=x=>crypto.createHash('sha256').update(x).digest();
const eq=(a,b)=>Buffer.isBuffer(a)&&Buffer.isBuffer(b)&&a.length===b.length&&crypto.timingSafeEqual(a,b);
const err=(message,statusCode=400)=>Object.assign(new Error(message),{nativeSafe:true,statusCode});
const statusHeaders={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
let active=null;
function send(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8',...statusHeaders});res.end(JSON.stringify(data));}
function state(now=Date.now()){
  return {mode:'native-remote-browser',playwright:false,interactive:true,paired:!!(active?.tokenHash&&active.expires>now),
    online:!!(active?.frame&&active.expires>now&&now-active.lastFrameAt<FRESH_MS),
    pairing:!!(active?.pairHash&&active.pairUntil>now),
    lastFrameAt:active?.lastFrameAt||null,controller:active?.controller||null,
    lastInputId:active?.lastInputId||0,lastInputStatus:active?.lastInputStatus||null,
    lastInputMessage:active?.lastInputMessage||null,lastInputAt:active?.lastInputAt||null,
    expiresAt:active?.expires?new Date(active.expires).toISOString():null,
    snapshotWidth:active?.width||0,snapshotHeight:active?.height||0,
    notice:'Windows-native mouse and keyboard; only the Edge webpage viewport is streamed. Remote browser navigation shortcuts are blocked.'};
}
function pairCode(now=Date.now()){
  const code=crypto.randomBytes(16).toString('hex').toUpperCase();
  active={pairHash:hash(code),pairUntil:now+PAIR_MS,attempts:0,tokenHash:null,
    expires:0,frame:null,lastFrameAt:0,lastPublished:0,width:0,height:0,
    actions:[],controller:null,controllerAt:0,nextId:0,lastCommandAt:0,
    lastInputId:0,lastInputStatus:null,lastInputMessage:null,lastInputAt:0};
  return {code,expiresAt:new Date(now+PAIR_MS).toISOString()};
}
function pair(code,now=Date.now()){
  if(!active?.pairHash||active.pairUntil<now)throw err('Pairing expired. Generate a new code in Admin.',403);
  if(++active.attempts>6){stop();throw err('Too many failed codes. Generate a new pairing code.',429);}
  const supplied=typeof code==='string'&&/^[A-Fa-f0-9]{32}$/.test(code)?hash(code.toUpperCase()):Buffer.alloc(32);
  if(!eq(supplied,active.pairHash))throw err('Incorrect pairing code.',403);
  const token=crypto.randomBytes(32).toString('base64url');
  active.pairHash=null;active.pairUntil=0;active.tokenHash=hash(token);
  active.expires=now+SESSION_MS;
  return {token,expiresAt:new Date(active.expires).toISOString()};
}
function auth(token,now=Date.now()){
  if(!active?.tokenHash||active.expires<now)throw err('Remote host pairing expired or was revoked.',403);
  if(typeof token!=='string'||token.length<40||token.length>100||!eq(hash(token),active.tokenHash))
    throw err('Remote host token rejected.',401);
  return active;
}
function stop(){active=null;}
function image(bytes,width,height,token,now=Date.now()){
  const s=auth(token,now);
  if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>MAX_FRAME||
    bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)
    throw err('The Windows helper must submit a JPEG image under 490 KiB.',413);
  if(!Number.isInteger(width)||width<320||width>2560||!Number.isInteger(height)||height<200||height>1600)
    throw err('Invalid AIVID viewport dimensions.',400);
  if(now-s.lastPublished<650)throw err('Too many screen updates.',429);
  s.frame=Buffer.from(bytes);s.width=width;s.height=height;s.lastFrameAt=now;s.lastPublished=now;
  return {accepted:true};
}
function frame(now=Date.now()){return state(now).online?active.frame:null;}
function inputShape(v){
  if(!v||typeof v!=='object'||Array.isArray(v))throw err('Invalid remote input.');
  const action=String(v.action||'');
  if(action==='click'){
    const x=Number(v.x),y=Number(v.y);
    if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||x<0||x>10000||y<0||y>10000)
      throw err('Click coordinates out of range.');
    return {action,x,y};
  }
  if(action==='wheel'){
    const delta=Number(v.delta);
    if(!Number.isInteger(delta)||![-3,-2,-1,1,2,3].includes(delta))throw err('Invalid scroll amount.');
    return {action,delta};
  }
  if(action==='type'){
    if(typeof v.text!=='string'||v.text.length<1||v.text.length>256||/[\x00-\x08\x0b-\x1f\x7f]/.test(v.text))
      throw err('Enter up to 256 printable characters.');
    return {action,text:v.text};
  }
  if(action==='key'){
    const key=String(v.key||'');
    if(!['Enter','Tab','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Escape'].includes(key))
      throw err('Browser shortcut blocked.');
    return {action,key};
  }
  throw err('Browser shortcut or automation not supported.');
}
function enqueue(userId,v,now=Date.now()){
  if(!active||!state(now).online)throw err('The Windows browser is not connected.',503);
  const id=String(userId);
  if(active.controller&&active.controller!==id&&now-active.controllerAt<CONTROL_TTL_MS)
    throw err('Another approved viewer is using this AIVID window.',409);
  if(now-active.lastCommandAt<75)throw err('Too many remote actions.',429);
  if(active.actions.length>=12)throw err('Remote input queue is busy.',429);
  const safe=inputShape(v);
  active.controller=id;active.controllerAt=now;active.lastCommandAt=now;
  const command={...safe,id:++active.nextId,expires:now+6000};
  active.actions.push(command);
  return {queued:true,id:command.id};
}
function next(token,now=Date.now()){
  const s=auth(token,now);
  while(s.actions.length&&s.actions[0].expires<now)s.actions.shift();
  const a=s.actions.shift();
  if(!a)return {action:null};
  const {expires,...command}=a;
  return {action:command};
}
function acknowledge(token,report,now=Date.now()){
  const s=auth(token,now);
  const id=Number(report?.id);
  if(!Number.isSafeInteger(id)||id<1||id>s.nextId||id<=s.lastInputId)
    throw err('Invalid or outdated native input acknowledgment.',400);
  if(typeof report.executed!=='boolean')throw err('Invalid native input result.',400);
  s.lastInputId=id;s.lastInputStatus=report.executed?'executed':'blocked';
  s.lastInputMessage=report.executed?'Action performed in Windows Edge':
    String(report.message||'Windows blocked this action.').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180);
  s.lastInputAt=now;
  return {acknowledged:true};
}
function release(userId){
  if(active?.controller===String(userId)){active.controller=null;active.controllerAt=0;active.actions=[];}
}
async function readJson(req,max=4096){
  const parts=[];let size=0;
  for await(const p of req){size+=p.length;if(size>max)throw err('Too much input.',413);parts.push(p);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw err('Invalid JSON.');}
}
async function readJpeg(req){
  if(req.headers['content-length']!==undefined&&Number(req.headers['content-length'])>MAX_FRAME)
    throw err('JPEG too large.',413);
  let count=0;const parts=[];
  for await(const p of req){count+=p.length;if(count>MAX_FRAME)throw err('JPEG too large.',413);parts.push(p);}
  return Buffer.concat(parts,count);
}
function html(res){
  const nonce=crypto.randomBytes(20).toString('base64');
  const html=fs.readFileSync(path.join(__dirname,'../public/aivid-native-studio.html'),'utf8').replaceAll('__CMM_NONCE__',nonce);
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store',
    'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'permissions-policy':'camera=(), microphone=(), geolocation=()',
    'content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; script-src 'nonce-"+nonce+"'"});
  res.end(html);
}
async function handle(req,res,route,{requireDatabase,requireUser,loadSettings=readConfig,checkSourceAccess=customerSourceAllowed,now=Date.now}={}){
  if(route!==VIEW&&!route.startsWith(API))return false;
  try{
    requireDatabase();
    if(route.startsWith(API+'host/')){
      if(req.method!=='POST'&&req.method!=='GET')throw err('Unsupported host operation.',405);
      const hostSettings=await loadSettings();
      if(hostSettings.enabled!==true||hostSettings.directBillingAcknowledged!==true)
        throw err('Windows Studio has been disabled or direct provider billing is not acknowledged.',403);
      if(route===API+'host/pair'&&req.method==='POST'){
        const v=await readJson(req);send(res,200,{ok:true,...pair(v.code,now())});return true;
      }
      const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      auth(token,now());
      if(route===API+'host/frame'&&req.method==='POST'){
        const width=Number(req.headers['x-cmm-width']),height=Number(req.headers['x-cmm-height']);
        const result=image(await readJpeg(req),width,height,token,now());
        send(res,200,{ok:true,...result});return true;
      }
      if(route===API+'host/next'&&req.method==='GET'){send(res,200,{ok:true,...next(token,now())});return true;}
      if(route===API+'host/ack'&&req.method==='POST'){
        send(res,200,{ok:true,...acknowledge(token,await readJson(req),now())});return true;
      }
      if(route===API+'host/stop'&&req.method==='POST'){stop();send(res,200,{ok:true});return true;}
      throw err('Not found.',404);
    }
    const user=await requireUser(req);
    authorized(user,await loadSettings());
    if(!await checkSourceAccess(user.id))throw err('AIVID is disabled in your Sources settings.',403);
    if(route===VIEW&&req.method==='GET'){html(res);return true;}
    if(route===API+'status'&&req.method==='GET'){send(res,200,{ok:true,...state(now())});return true;}
    if(route===API+'frame'&&req.method==='GET'){
      const bytes=frame(now());
      if(!bytes){res.writeHead(204,{'cache-control':'no-store'});res.end();return true;}
      res.writeHead(200,{'content-type':'image/jpeg','content-length':bytes.length,
        'cache-control':'private, no-store','x-content-type-options':'nosniff'});res.end(bytes);return true;
    }
    if(!originOk(req))throw err('Same-origin interaction required.',403);
    if(route===API+'input'&&req.method==='POST'){
      send(res,200,{ok:true,...enqueue(user.id,await readJson(req),now())});return true;
    }
    if(route===API+'release'&&req.method==='POST'){release(user.id);send(res,200,{ok:true});return true;}
    throw err('Method not allowed.',405);
  }catch(e){
    const code=e?.nativeSafe?e.statusCode:e?.statusCode===401||e?.statusCode===403?e.statusCode:503;
    send(res,code,{ok:false,error:e?.nativeSafe?e.message:code===401||code===403?
      'This CMMTools account cannot access the Windows Studio.':'The Windows interactive host is unavailable.'});return true;
  }
}
async function admin(req,res,route,{loadSettings=readConfig}={}){
  if(!route.startsWith(ADMIN))return false;
  try{
    if(route===ADMIN+'status'&&req.method==='GET'){send(res,200,{ok:true,...state()});return true;}
    if(route===ADMIN+'pair'&&req.method==='POST'){
      const c=await loadSettings();
      if(c.enabled!==true||c.directBillingAcknowledged!==true)throw err('Enable Windows Studio and acknowledge direct provider billing first.',409);
      send(res,200,{ok:true,...pairCode()});return true;
    }
    if(route===ADMIN+'stop'&&req.method==='POST'){stop();send(res,200,{ok:true,online:false});return true;}
    throw err('Method not allowed.',405);
  }catch(e){send(res,e?.nativeSafe?e.statusCode:503,{ok:false,error:e?.nativeSafe?e.message:'Windows Studio is unavailable.'});return true;}
}
module.exports={VIEW,MAX_FRAME,PAIR_MS,SESSION_MS,FRESH_MS,CONTROL_TTL_MS,
  pairCode,pair,auth,stop,image,frame,inputShape,enqueue,next,acknowledge,release,state,handle,admin};

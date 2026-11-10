'use strict';
/**
 * Outbound-only interactive Microsoft Edge relay for an existing paired Windows
 * agent. Never forwards Windows desktop/RDP input or the automated agent profile.
 * Each action is an authenticated, short-lived MySQL RPC; no WebSockets/VPS.
 */
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {AividRdpClient,RdpStore,readDevice,failure,CHUNK}=require('./aivid_rdp.js');
const {getPool}=require('./db.js');
const {customerSourceAllowed}=require('./aivid_rdp_viewer.js');
const {originOk}=require('./aivid_embed.js');

const PAGE_ROUTES=new Set(['/aivid-live-studio','/rdp-studio']);
const API='/api/windows-studio/';
const MAX_INPUT=30*1024*1024;
const MAX_TOTAL_UPLOAD=30*1024*1024;
const FILE_TYPES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4',
  '.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4'};
const bool=value=>/^(?:true|yes|1|on)$/i.test(String(value||''));
const ids=value=>new Set(String(value||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
const active=new Map();

function enabled(env=process.env){return bool(env.AIVID_WINDOWS_VIEW_ENABLED);}
function allowed(user,env=process.env){
  if(!enabled(env)||!user||!Number.isSafeInteger(Number(user.id))||Number(user.id)<=0)return false;
  return ids(env.AIVID_WINDOWS_VIEW_ALLOWED_IDS).has(String(user.id)) ||
    Boolean(user.email&&ids(env.AIVID_WINDOWS_VIEW_ALLOWED_EMAILS).has(String(user.email).toLowerCase()));
}
function authorized(user,env=process.env){
  if(!allowed(user,env))throw failure('Windows Premium Studio is not enabled for this account.',403);
  if(!bool(env.AIVID_WINDOWS_VIEW_DIRECT_BILLING_ACK))throw failure(
    'Interactive AIVID generation bills the provider account directly. The owner must enable the direct-billing acknowledgment.',503);
  return true;
}
function safeName(value){
  const basename=String(value||'').replaceAll('\\','/').split('/').pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').trim();
  return basename.slice(0,120)||'reference';
}
function validateUpload(name,bytes){
  const mime=FILE_TYPES[path.extname(safeName(name)).toLowerCase()];
  if(!mime||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_INPUT)throw failure(
    'Choose one image, video or audio file of at most 30 MiB.',413);
  return {name:safeName(name),mime,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
function validateAction(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw failure('Invalid browser action.');
  const action=String(input.action||'');
  if(!['open','frame','click','scroll','type','key','close','download'].includes(action))throw failure('Unsupported browser operation.');
  const result={action};
  if(action==='click'){
    if(!Number.isInteger(input.x)||!Number.isInteger(input.y)||input.x<0||input.x>1280||input.y<0||input.y>760)
      throw failure('Click is outside the private browser viewport.');
    result.x=input.x;result.y=input.y;
  }else if(action==='scroll'){
    if(!Number.isInteger(input.delta)||Math.abs(input.delta)>1200)throw failure('Invalid scroll amount.');
    result.delta=input.delta;
  }else if(action==='type'){
    if(typeof input.text!=='string'||input.text.length>3000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.text))
      throw failure('Type at most 3,000 printable characters.');
    result.text=input.text;
  }else if(action==='key'){
    const key=String(input.key||'');
    if(!['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space','Home','End'].includes(key))
      throw failure('Unrestricted keyboard shortcuts are not allowed.');
    result.key=key;
  }
  return result;
}
function send(res,status,value){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
  res.end(JSON.stringify(value));
}
function htmlPage(res){
  const nonce=crypto.randomBytes(20).toString('base64');
  const body=fs.readFileSync(path.join(__dirname,'..','public','aivid-windows-studio.html'),'utf8')
    .replaceAll('__CMM_NONCE__',nonce);
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store',
    'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'permissions-policy':'camera=(), microphone=(), geolocation=()',
    'content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src data:; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-"+nonce+"'"});
  res.end(body);
}
async function readJson(req,max=8192){
  let size=0;const data=[];
  for await(const part of req){size+=part.length;if(size>max)throw failure('Request is too large.',413);data.push(part);}
  try{return JSON.parse(Buffer.concat(data).toString('utf8'));}catch{throw failure('Invalid request JSON.');}
}
async function readBinary(req){
  const length=Number(req.headers['content-length']);
  if(!Number.isSafeInteger(length)||length<1||length>MAX_TOTAL_UPLOAD)throw failure('Invalid reference size.',413);
  let count=0;const data=[];
  for await(const part of req){count+=part.length;if(count>MAX_TOTAL_UPLOAD)throw failure('Reference is too large.',413);data.push(part);}
  if(count!==length)throw failure('Reference upload was incomplete.',400);
  return Buffer.concat(data,count);
}
async function run(userId,input,bytes=null,{now=Date.now,store=new RdpStore(),getDevice=readDevice,delay}={}){
  const id=String(userId);
  if(active.has(id))throw failure('The previous browser action is still finishing.',409);
  active.set(id,true);
  let commandId;
  try{
    const device=await getDevice();
    if(!device?.deviceId||!device?.tokenHash)throw failure('Connect the existing AIVID Windows agent first.',503);
    const client=new AividRdpClient({rdpDevice:device,store,now,delay});
    if(!bytes)return await client.run('live',{owner:id,...input},{timeoutMs:75000});
    // Store file bytes in bounded 1 MiB MySQL chunks. Staging state prevents
    // the agent claiming a half-uploaded command.
    commandId=crypto.randomUUID();
    const meta=validateUpload(input.name,bytes);
    await store.insert({id:commandId,deviceId:device.deviceId,generationId:null,kind:'live',initialState:'staging',
      expiresAt:now()+75000,payload:{owner:id,action:'upload',file:meta}});
    for(let offset=0,index=0;offset<bytes.length;offset+=CHUNK,index++)
      await store.chunk(commandId,index,bytes.subarray(offset,offset+CHUNK));
    if(!await store.move(commandId,'staging','queued'))throw failure('Upload session expired.',409);
    const result=await client.wait(commandId,'live',{timeoutMs:75000});
    commandId=null;
    return result;
  }finally{
    if(commandId)await store.remove(commandId).catch(()=>{});
    active.delete(id);
  }
}
async function handle(req,res,route,{requireUser,requireDatabase,checkSourceAccess=customerSourceAllowed,runner=run}={}){
  if(!enabled())return false;
  if(!PAGE_ROUTES.has(route)&&!route.startsWith(API))return false;
  try{
    requireDatabase();
    const user=await requireUser(req);
    authorized(user);
    if(!await checkSourceAccess(user.id))throw failure('AIVID is disabled in your Sources settings.',403);
    if(PAGE_ROUTES.has(route)){
      if(req.method!=='GET')throw failure('Method not allowed.',405);
      htmlPage(res);return true;
    }
    if(route===API+'config'&&req.method==='GET'){
      send(res,200,{ok:true,mode:'windows-edge',oneViewer:true,fileTransfers:true,directBilling:true,
        notice:'This is an isolated Edge browser surface, not access to the Windows desktop.'});return true;
    }
    if(!originOk(req))throw failure('Same-origin request required.',403);
    if(route===API+'action'&&req.method==='POST'){
      const action=validateAction(await readJson(req));
      const result=await runner(user.id,action);
      if(action.action==='download'&&result?.state==='download'&&result.output?.data){
        res.writeHead(200,{'content-type':'video/mp4','content-disposition':'attachment; filename="aivid-video.mp4"',
          'content-length':result.output.data.length,'cache-control':'private, no-store','x-content-type-options':'nosniff'});
        res.end(result.output.data);return true;
      }
      send(res,200,{ok:true,...result});return true;
    }
    if(route===API+'upload'&&req.method==='POST'){
      const url=new URL(req.url,'https://cmmtools.invalid');
      const name=safeName(url.searchParams.get('name'));
      const bytes=await readBinary(req);
      const meta=validateUpload(name,bytes);
      send(res,200,{ok:true,...await runner(user.id,{action:'upload',name:meta.name},bytes)});return true;
    }
    throw failure('Method not allowed.',405);
  }catch(error){
    const status=[400,403,404,405,409,413,503].includes(error?.statusCode)?error.statusCode:503;
    send(res,status,{ok:false,error:error?.statusCode?error.message:'Windows Premium Studio is unavailable. Check that the Edge agent is connected.'});return true;
  }
}
module.exports={enabled,allowed,authorized,validateUpload,validateAction,safeName,run,handle,htmlPage,readBinary};

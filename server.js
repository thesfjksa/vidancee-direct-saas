const http = require('node:http');
const os = require('node:os');

const PROCESS_STARTED_AT = Date.now();
function runtimeSnapshot() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    externalMb: Math.round(mem.external / 1024 / 1024),
    freeSystemMb: Math.round(os.freemem() / 1024 / 1024),
    load1: Number(os.loadavg()[0].toFixed(2)),
  };
}

process.on('uncaughtExceptionMonitor', (error, origin) => {
  console.error('[runtime] uncaught exception monitor', origin, error);
  console.error('[runtime] snapshot', runtimeSnapshot());
});
process.on('unhandledRejection', (reason) => {
  console.error('[runtime] unhandled rejection', reason);
  console.error('[runtime] snapshot', runtimeSnapshot());
});
process.on('SIGTERM', () => {
  console.warn('[runtime] SIGTERM received', runtimeSnapshot());
});
process.on('SIGINT', () => {
  console.warn('[runtime] SIGINT received', runtimeSnapshot());
});
process.on('beforeExit', (code) => {
  console.warn('[runtime] beforeExit', code, runtimeSnapshot());
});

const { URL } = require('node:url');
const fs = require('node:fs');
const { hideVendors, hideVendorsInBody } = require('./src/vendor_names.js');
const path = require('node:path');
const { fork } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const Busboy = require('busboy');
const { SmartAipiClient, validateSmartReference } = require('./src/provider/smartaipi.js');
const { smartImageModel, smartImageQuote, publicSmartImagePricing, SMART_IMAGE_REFS, SMART_IMAGE_MODELS } = require('./src/smartaipi_images.js');
const { VibiClient } = require('./src/provider/vibi.js');
const { GeminiPromptEnhancer, PromptEnhancementGate, PromptEnhancementJobs, ENHANCEMENT_TIMEOUT_MS, normalizeEnhancement } = require('./src/prompt_enhancer.js');
const promptEnhancementGate = new PromptEnhancementGate();
const promptEnhancementJobs = new PromptEnhancementJobs({gate:promptEnhancementGate});
const { WorkerWakeup } = require('./src/worker_wakeup.js');
const { RuntimeDiagnostics, recordBoot, listBoots, routeLabel } = require('./src/runtime_diagnostics.js');
const { normalizeCartoonRequest, publicCartoonConfig, CARTOON_MODELS } = require('./src/cartoon.js');
const { providerUsage, readProviderStatus } = require('./src/provider_usage.js');
const { logActivity, errorDetails, listActivity, pruneActivity, maskEmail, SUPPORT_KEY_SETTING, newSupportKey, hashSupportKey, supportKeyMatches } = require('./src/activity_log.js');
const authModule = require('./src/auth.js');
// Remembers who made the request, for the activity log.
async function requireUser(req) {
  const user = await authModule.requireUser(req);
  req.activityUserId = user?.id;
  return user;
}
// Job details for support: everything except media bytes; the saved model
// definition is cut down to the fields that matter for debugging.
const JOB_FIELDS='id,user_id,provider,media_type,mode,model,duration,resolution,aspect_ratio,image_quality,prompt,status,credits_cost,provider_cost,provider_cost_unit,provider_job_id,provider_operation,generation_options,error_message,output_url,created_at,submitted_at,started_at,completed_at,refunded_at,updated_at';
function jobSnapshot(row){
  const parse=v=>{try{return v?JSON.parse(v):null;}catch{return v;}};
  const options=parse(row.generation_options);
  if(options?.model&&typeof options.model==='object'){const m=options.model;options.model={providerModelId:m.providerModelId,publicModelId:m.publicModelId,label:m.label,resolutions:m.resolutions,adaptiveFrames:m.adaptiveFrames};}
  return {...row,user_id:Number(row.user_id),credits_cost:Number(row.credits_cost),provider_cost:row.provider_cost==null?null:Number(row.provider_cost),
    generation_options:options,provider_operation:parse(row.provider_operation)};
}
async function supportAuthorized(req,url){
  const supplied=String(req.headers['x-support-key']||url.searchParams.get('key')||'');
  if(!supplied||!dbConfigured())return false;
  return supportKeyMatches(supplied,await getSettingValue(SUPPORT_KEY_SETTING,''));
}
function activityFilters(url){
  const p=name=>url.searchParams.get(name)||undefined;
  return {limit:p('limit'),beforeId:p('before'),sinceMinutes:p('minutes'),level:p('level'),category:p('category'),provider:p('provider'),generationId:p('generation'),userId:p('user'),q:p('q')};
}

// Quotes and status polls run constantly; they are logged only when they fail.
const QUIET_ROUTES = new Set(['/api/model-cost', '/api/upscales/quote']);
function logRequest(req, routePath, res, ms) {
  if (!/^\/(api|admin)\//.test(routePath)) return;
  const status = res.statusCode, error = res.activityError;
  if (req.method === 'GET' && status < 400) return;
  if (QUIET_ROUTES.has(routePath) && status < 400) return;
  if (status === 401 && req.method === 'GET') return;
  logActivity({ level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', category: routePath.startsWith('/admin/') ? 'admin' : 'request',
    event: routeLabel(req.method, routePath).slice(0, 60), userId: req.activityUserId,
    message: req.method + ' ' + routePath + ' → ' + status + ' (' + Math.round(ms) + ' ms)' + (error ? ' · ' + error.message : ''),
    details: error ? errorDetails(error) : null });
}
const diagnostics = new RuntimeDiagnostics().start();
const { appUrl, PRIMARY_URL, RETIRED_HOSTS } = require('./src/app_url.js');
const workerWakeup = new WorkerWakeup({url:process.env.WORKER_WAKE_URL ?? 'https://worker.mehroz.online/live'});
const PRODUCTION_HOSTS=['cmmtools.site','www.cmmtools.site',...RETIRED_HOSTS];
// The default wake URL belongs only to this production deployment; other
// deployments must explicitly configure their own standalone worker's health endpoint.
function wakeAllowed(host='') {
  const origin=appUrl().toLowerCase();
  return process.env.WORKER_WAKE_URL!==undefined || PRODUCTION_HOSTS.includes(host) || PRODUCTION_HOSTS.some(h=>origin==='https://'+h);
}
function wakeWorker() {
  void workerWakeup.wake().then(result=>{
    if(!result.ok&&!result.skipped)console.warn('[worker-wakeup]',result.error);
  });
}
function wakeGenerationWorker(req) {
  if(wakeAllowed(String(req.headers.host||'').toLowerCase().split(':')[0]))wakeWorker();
}
// New work wakes the worker; without a request (the Claude connector) the
// production address decides whether waking is allowed.
function wakeForNewWork(req){
  if(req)wakeGenerationWorker(req);
  else if(wakeAllowed())wakeWorker();
}
// Hostinger stops an idle worker. While any job is running the worker is woken
// every minute, so jobs finish even when no customer tab is polling.
function wakeWhileJobsRun() {
  if(!wakeAllowed())return;
  setInterval(async()=>{
    try {
      const [[row]]=await getPool().query("SELECT 1 AS active FROM generations WHERE status IN ('queued','submitting','submitted','processing') AND refunded_at IS NULL LIMIT 1");
      if(row)wakeWorker();
    } catch {}
  },60000).unref();
}
const { dbConfigured, getPool, initDb, dbHealth } = require('./src/db.js');
const {
  normalizeEmail, validateEmail, hashPassword, verifyPassword,
  createSession, destroySession, userFromRequest,
} = require('./src/auth.js');
const { publicPricing, getCost, ASPECT_RATIOS } = require('./src/pricing.js');
const { H3_AUDIO_CAPABILITY, H3_VIDEO_CAPABILITY, validateH3Media } = require('./src/h3_references.js');
const { publicImagePricing, IMAGE_ASPECT_RATIOS } = require('./src/image_pricing.js');
const { creditMultiplier, roundCredits, sourceToCustomerCredits } = require('./src/billing.js');
const {
  publicPlans,
  getPlanStatus,
  createPlanRequest,
  listPlanRequests,
  decidePlanRequest,
  SUPPORT_WHATSAPP,
  whatsappUrl,
} = require('./src/plans.js');
const { adminPlanOptions, setUserPlan, changeUserCredits, verifyAdminMedia, adminMediaLinks, USER_FIELDS } = require('./src/admin_users.js');
const {
  createGenerationForUser, listUserGenerations, getUserGeneration,
  listUserGenerationReferenceImages, getUserGenerationReferenceImage,
  deleteUserGeneration, serializeGeneration,
} = require('./src/generations.js');
const {
  createImageGenerationForUser,
  listUserImageGenerations,
  getUserImageGeneration,
  deleteUserImageGeneration,
  serializeImageGeneration,
} = require('./src/image_generations.js');
const {
  createVoiceGenerationForUser,
  listUserVoiceGenerations,
  getUserVoiceGeneration,
  deleteUserVoiceGeneration,
  serializeVoiceGeneration,
} = require('./src/voice_generations.js');
const {
  getProviderSettings,
  getAdminProviderSettings,
  updateProviderSettings,
  migrateLegacyProviderEnvSettings,
  getSettingValue,
  setSettingValue,
  deleteSettingValue,
} = require('./src/settings.js');
const { verifyAssetSignature, verifyOutputSignature } = require('./src/provider/assets.js');
const { createUpscaleJob, publicUpscalerConfig, quoteForCustomer } = require('./src/upscaler.js');
const { FalClient } = require('./src/provider/fal.js');
const { VercelGatewayClient } = require('./src/provider/vercel.js');
const { ArgoLinkClient } = require('./src/provider/argolink.js');
const { Api888Client } = require('./src/provider/api888.js');
const { api888MediaModels, isApi888Model, quoteApi888 } = require('./src/api888_models.js');
const { isArgoModel, argoMediaModels } = require('./src/argolink_models.js');
const { comparePrices } = require('./src/compare_prices.js');
const { isHiggsfieldModel, higgsfieldMediaModels, fetchHiggsfieldTiers, validateHiggsfieldReferences } = require('./src/higgsfield_models.js');
const { HiggsfieldClient } = require('./src/provider/higgsfield.js');
const { isSluiceModel, sluiceMediaModels, fetchSluiceCatalog } = require('./src/sluice_models.js');
const { SluiceClient } = require('./src/provider/sluice.js');
const { applyWanCap } = require('./src/wan_pricing.js');
const { submissionFailover, isOutOfCredits } = require('./src/image_failover.js');
const { argoVideoView, wanVideoView, quoteArgoVideo, falReady } = require('./src/argo_hd.js');
const { isGatewayModel, mediaModels, quoteGateway, validateReferences, mp4Seconds } = require('./src/vercel_models.js');
const { serveVideoOutput } = require('./src/video_outputs.js');
const { getImageThumbnail } = require('./src/image_thumbnails.js');
const { attachReusedImageReferences } = require('./src/reference_reuse.js');
const { createConnector } = require('./src/connector.js');
const {
  publicProviderCatalog,
  addMissingImageModels,
  listProviderModels,
  getProviderModelByPublicId,
  setProviderModelEnabled,
  syncProviderModels, setGatewayPrice, ensureGatewayCatalog, ensureArgoCatalog, ensureHiggsfieldCatalog, ensureSluiceCatalog, ensureApi888Catalog,
} = require('./src/provider_models.js');

const customerPage = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const landingPage = fs.readFileSync(path.join(__dirname, 'public', 'landing.html'), 'utf8');
const pricingPage = fs.readFileSync(path.join(__dirname, 'public', 'pricing.html'), 'utf8');
const comparePage = fs.readFileSync(path.join(__dirname, 'public', 'compare.html'), 'utf8');
// Visitors who are not signed in see the landing page at /; the studio is at /app.
const hasSessionCookie = req => /(?:^|;\s*)cmm_session=/.test(String(req.headers.cookie || ''));
// The admin page carries its stylesheets inline: one request instead of three
// before anything can render.
function inlineStylesheets(html) {
  return html.replace(/<link rel="stylesheet" href="\/(brand|admin)\.css(?:\?[^"]*)?">/g, (tag, name) => {
    const css = fs.readFileSync(path.join(__dirname, 'public', name + '.css'), 'utf8');
    return '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style>';
  });
}
const adminPage = inlineStylesheets(fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8'));

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
const allowSignups = !/^(0|false|no|off)$/i.test(String(process.env.ALLOW_SIGNUPS || 'yes'));
const startingCredits = Math.max(0, Number(process.env.STARTING_CREDITS || 0));

if (!adminToken) console.warn('ADMIN_TOKEN is not configured. Admin routes will be unavailable.');

function vibiClient(settings) {
  return new VibiClient({baseUrl:settings.vibiBaseUrl,apiKey:settings.vibiApiKey});
}

function sendJson(res, status, body) {
  // Customers and Claude never see provider names (Admin and support keep them).
  const route = String(res.req?.url || '');
  if (!/^\/(admin|ops)(\/|$|\?)/.test(route)) hideVendorsInBody(body);
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}
function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: https://*.aliyuncs.com; connect-src 'self'",
  });
  res.end(body);
}
// CANONICAL_URL (default https://cmmtools.site for the retired ai.mehroz.online)
// sends people who open another address to the same page on the main one. Provider
// downloads, health checks, OAuth callbacks and API calls are never redirected,
// so jobs and integrations that still use the old address keep working.
function canonicalRedirect(req,routePath,url) {
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim().toLowerCase();
  const target=String(process.env.CANONICAL_URL||(RETIRED_HOSTS.includes(host)?PRIMARY_URL:'')).trim().replace(/\/$/,'');
  if(!target||!['GET','HEAD'].includes(req.method))return null;
  let canonicalHost;
  try{canonicalHost=new URL(target).host.toLowerCase();}catch{return null;}
  if(!host||host===canonicalHost||/^(localhost|127\.|\[?::1)/.test(host))return null;
  if(!['/','/app','/pricing','/compare','/admin-console'].includes(routePath))return null;
  return target+url.pathname+url.search;
}

function publicOrigin(req) {
  const configured = appUrl();
  if (configured) return configured;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || 'https';
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(req.headers.host || '').trim();
  if (!requestHost) throw new Error('APP_URL is required for OAuth callbacks.');
  return proto + '://' + requestHost;
}

function safeError(error) {
  return { ok:false, error:error instanceof Error ? error.message : String(error) };
}
async function readJson(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256*1024) {
      const error=new Error('Request body too large.'); error.statusCode=413; throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error=new Error('Invalid JSON body.'); error.statusCode=400; throw error; }
}

function readGenerationRequest(req) {
  const contentType=String(req.headers['content-type']||'');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return readJson(req);

  return new Promise((resolve,reject)=>{
    const fields={};
    const images=[];
    const videos=[];
    const audios=[];
    let totalBytes=0;
    let settled=false;

    function fail(message,statusCode=400){
      if(settled)return;
      settled=true;
      const error=new Error(message); error.statusCode=statusCode; reject(error);
    }

    let bb;
    try {
      bb=Busboy({
        headers:req.headers,
        limits:{files:24,fileSize:25*1024*1024,fields:40,parts:70},
      });
    } catch(error) {
      error.statusCode=400; return reject(error);
    }

    bb.on('field',(name,value)=>{fields[name]=value;});
    bb.on('file',(name,file,info)=>{
      const isImage=name==='images' || name==='images[]';
      const isVideo=name==='videos' || name==='videos[]';
      const isAudio=name==='audios' || name==='audios[]';
      if(!isImage && !isVideo && !isAudio){ file.resume(); return; }

      const mimeType=String(info.mimeType||'').toLowerCase();
      if(isImage && !['image/jpeg','image/png','image/webp'].includes(mimeType)){
        file.resume(); return fail('Images must be JPEG, PNG, or WebP.');
      }
      if(isVideo && !['video/mp4','video/webm','video/quicktime'].includes(mimeType)){
        file.resume(); return fail('Video references must be MP4, WebM, or MOV.');
      }
      if(isAudio && !['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave','audio/vnd.wave'].includes(mimeType)){
        file.resume(); return fail('Sound references must be MP3 or WAV.');
      }

      const chunks=[]; let bytes=0;
      file.on('data',(chunk)=>{
        bytes+=chunk.length; totalBytes+=chunk.length;
        if(totalBytes>100*1024*1024) fail('Combined reference upload is too large.',413);
        if(isImage && bytes>10*1024*1024) fail('Each image must be 10 MB or smaller.',413);
        if(isAudio && bytes>15*1024*1024) fail('Each sound reference must be 15 MB or smaller.',413);
        if(!settled) chunks.push(chunk);
      });
      file.on('limit',()=>fail(isVideo?'Each video reference must be 25 MB or smaller.':'Each image must be 10 MB or smaller.',413));
      file.on('end',()=>{
        if(settled || bytes<=0)return;
        const item={
          filename:String(info.filename||(isVideo?'reference-video':isAudio?'reference-audio':'reference-image')).slice(0,255),
          mimeType,
          data:Buffer.concat(chunks),
        };
        if(isImage)images.push(item);
        else if(isAudio)audios.push(item);
        else videos.push(item);
      });
    });
    bb.on('filesLimit',()=>fail('Too many reference files were uploaded.'));
    bb.on('error',(error)=>{if(!settled){settled=true;reject(error);}});
    bb.on('close',()=>{
      if(settled)return;
      settled=true;
      fields.images=images;
      fields.videos=videos;
      fields.audios=audios;
      resolve(fields);
    });
    req.pipe(bb);
  });
}
function readVoiceCloneRequest(req){
  return new Promise((resolve,reject)=>{
    const fields={};let sample=null,settled=false;
    const fail=(message,statusCode=400)=>{if(settled)return;settled=true;const e=new Error(message);e.statusCode=statusCode;reject(e)};
    let bb;
    try{bb=Busboy({headers:req.headers,limits:{files:1,fileSize:20*1024*1024,fields:10,parts:15}})}
    catch(error){error.statusCode=400;return reject(error)}
    bb.on('field',(name,value)=>{fields[name]=value});
    bb.on('file',(name,file,info)=>{
      if(name!=='file'){file.resume();return}
      const mime=String(info.mimeType||'').toLowerCase();
      if(!['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave','audio/mp4','audio/m4a','audio/ogg','audio/webm'].includes(mime)){
        file.resume();return fail('Voice sample must be a supported audio file.')
      }
      const chunks=[];let bytes=0;
      file.on('data',chunk=>{bytes+=chunk.length;if(!settled)chunks.push(chunk)});
      file.on('limit',()=>fail('Voice sample must be 20 MB or smaller.',413));
      file.on('end',()=>{if(!settled&&bytes>0)sample={filename:String(info.filename||'voice-sample').slice(0,255),mimeType:mime,data:Buffer.concat(chunks)}})
    });
    bb.on('error',error=>{if(!settled){settled=true;reject(error)}});
    bb.on('close',()=>{if(settled)return;settled=true;if(!sample){const e=new Error('Voice sample is required.');e.statusCode=400;return reject(e)}resolve({...fields,sample})});
    req.pipe(bb);
  });
}

function adminAuthorized(req) {
  const supplied=String(req.headers['x-admin-token']||'');
  if (!supplied || !adminToken || supplied.length !== adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(adminToken));
}
const CUSTOMER_PROVIDER_KEYS=['api888','sluice','vgenv','vibi','smartaipi','vercel','argolink','higgsfield','fal'];
// Every studio is on for a customer until the admin turns a source off for them.
function defaultCustomerProviderAccess(){
  return Object.fromEntries(CUSTOMER_PROVIDER_KEYS.map(key=>[key,true]));
}
// Voice Studio used to be opt-in, so saving any customer's Sources stored
// "Voice off" unless it was ticked. Clear those once so Voice follows the
// new default; the admin can turn it off again per customer.
const VOICE_DEFAULT_ON_SETTING='voice_access_default_on_at';
async function enableVoiceForCustomersOnce(){
  if(await getSettingValue(VOICE_DEFAULT_ON_SETTING,''))return 0;
  const [result]=await getPool().execute("DELETE FROM user_provider_access WHERE provider='vibi' AND enabled=0");
  await setSettingValue(VOICE_DEFAULT_ON_SETTING,new Date().toISOString());
  const count=Number(result?.affectedRows||0);
  logActivity({category:'admin',event:'voice_access.default_on',message:'Voice Studio turned on for '+count+' customer(s) who had it off under the old default'});
  return count;
}
// Wan 3.0 on Higgsfield for every customer (17 October 2026): switches left
// off for Higgsfield are cleared once; the admin can turn it off again per customer.
const HIGGSFIELD_ALL_ON_SETTING='higgsfield_access_all_on_at';
async function enableHiggsfieldForCustomersOnce(){
  if(await getSettingValue(HIGGSFIELD_ALL_ON_SETTING,''))return 0;
  const [result]=await getPool().execute("DELETE FROM user_provider_access WHERE provider='higgsfield' AND enabled=0");
  await setSettingValue(HIGGSFIELD_ALL_ON_SETTING,new Date().toISOString());
  const count=Number(result?.affectedRows||0);
  logActivity({category:'admin',event:'higgsfield_access.all_on',message:'Higgsfield (Wan 3.0) turned on for every customer; '+count+' had it off'});
  return count;
}
async function getUserProviderAccess(userId){
  const access=defaultCustomerProviderAccess();
  if(!userId||!dbConfigured())return access;
  const db=getPool();
  const [rows]=await db.execute(
    'SELECT provider,enabled FROM user_provider_access WHERE user_id=?',
    [Number(userId)]
  );
  for(const row of rows){
    const key=String(row.provider||'');
    if(CUSTOMER_PROVIDER_KEYS.includes(key))access[key]=Boolean(row.enabled);
  }
  return access;
}
async function setUserProviderAccess(userId,providers){
  const db=getPool();
  const [users]=await db.execute('SELECT id FROM users WHERE id=? LIMIT 1',[Number(userId)]);
  if(!users[0]){
    const error=new Error('User not found.');error.statusCode=404;throw error;
  }
  const next=providers&&typeof providers==='object'?providers:{};
  for(const key of CUSTOMER_PROVIDER_KEYS){
    if(next[key]===undefined)continue;
    await db.execute(
      `INSERT INTO user_provider_access (user_id,provider,enabled)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),updated_at=UTC_TIMESTAMP()`,
      [Number(userId),key,next[key]?1:0]
    );
  }
  return getUserProviderAccess(userId);
}

// Video, image and upscaler models a customer can use, as Video Studio, Image
// Studio and the Upscaler show them (the Claude connector lists the same).
// A source that is out of credits is left out, so ArgoLink's copy of the same
// model takes its place.
// ArgoLink video models the admin set to render at their own resolution,
// without HD enhancement (public model ids).
const ARGO_HD_OFF_SETTING='argolink_hd_off_models';
async function argoHdOffModels(){
  try{const list=JSON.parse(await getSettingValue(ARGO_HD_OFF_SETTING,'[]')||'[]');return new Set(Array.isArray(list)?list.map(String):[]);}
  catch{return new Set();}
}

// MiniMax H3 on vgenv in Video Studio, beside ArgoLink's and Higgsfield's
// models. Its prices are fixed per duration and resolution. (Seedance Lite on
// Vidancee/CreatePulse was removed on 20 October 2026.)
const DIRECT_VIDEO_MODELS=['minimax_h3'];
function directVideoSourceActive(id,access,providerSettings){
  return id==='minimax_h3'&&Boolean(access.vgenv&&providerSettings.vgenv.active);
}
function directVideoModels(access,providerSettings){
  return publicPricing().filter(m=>DIRECT_VIDEO_MODELS.includes(m.id)&&m.durations.length&&directVideoSourceActive(m.id,access,providerSettings)).map(m=>({
    ...m,
    label:m.label+' · up to '+Math.max(...m.durations.map(d=>d.seconds))+' s',
    defaultDuration:m.durations[0].seconds,
    aspectRatios:ASPECT_RATIOS,defaultAspectRatio:'9:16',
    capabilities:{image:{supported:true,max:6,min:0,roles:['image_references'],requiredRoles:[]},
      video:m.id==='minimax_h3'?H3_VIDEO_CAPABILITY:{supported:false,max:0},
      audio:m.id==='minimax_h3'?H3_AUDIO_CAPABILITY:{supported:false,max:0}},
  }));
}

// Names the admin gave models ({"video:<id>": "Name"}); studios show these
// instead of the source's name.
const MODEL_NAMES_SETTING='model_display_names';
const MODEL_NAME_STUDIOS=['video','image','cartoon'];
async function modelDisplayNames(){
  try{const names=JSON.parse(await getSettingValue(MODEL_NAMES_SETTING,'{}')||'{}');return names&&typeof names==='object'&&!Array.isArray(names)?names:{};}
  catch{return {};}
}
function applyModelNames(studio,models,names){
  return models.map(m=>{const name=names[studio+':'+m.id];return typeof name==='string'&&name.trim()?{...m,label:name.trim()}:m;});
}

async function customerMediaCatalog(access,adminSettings=null,{names=null}={}){
  const catalog=await sourceMediaCatalog(access,adminSettings);
  const custom=names||await modelDisplayNames().catch(()=>({}));
  return {...catalog,video:applyModelNames('video',catalog.video,custom),image:applyModelNames('image',catalog.image,custom)};
}

async function sourceMediaCatalog(access,adminSettings=null){
  const providerSettings=adminSettings||await getAdminProviderSettings();
  let video=[],image=[];
  const creditStatus=await readProviderStatus(getPool()).catch(()=>({}));
  const argoReady=Boolean(access.argolink && providerSettings.argolink.active);
  const usable=source=>!(argoReady&&isOutOfCredits(creditStatus,source));
  if (access.smartaipi && providerSettings.smartaipi.active && usable('smartaipi')) {
    image.push(...publicSmartImagePricing(await getProviderSettings()));
  }
  if(access.vercel && providerSettings.vercel.active && usable('vercel')){
    const catalog=await publicProviderCatalog('vercel',{creditsPerUsd:providerSettings.vercel.customerCreditsPerUsd});
    image=addMissingImageModels(image,catalog.image);
  }
  if(access.argolink && providerSettings.argolink.active){
    const hd=falReady(await getProviderSettings());
    const hdOff=await argoHdOffModels();
    const catalog=await publicProviderCatalog('argolink',{creditsPerUsd:providerSettings.argolink.customerCreditsPerUsd,transform:model=>argoVideoView(model,hd,{hd:!hdOff.has(model.publicModelId)})});
    video=catalog.video;
    image=addMissingImageModels(image,catalog.image);
  }
  if(access.api888 && providerSettings.api888.active){
    const catalog=await publicProviderCatalog('api888',{});
    video.push(...catalog.video);
    image.push(...catalog.image);
  }
  // Higgsfield's Wan 3.0: 480p native; 720p/1080p rendered lower and upscaled by fal.
  if(access.higgsfield && providerSettings.higgsfield.active){
    const hd=falReady(await getProviderSettings());
    const hdOff=await argoHdOffModels();
    const catalog=await publicProviderCatalog('higgsfield',{creditsPerUsd:providerSettings.higgsfield.customerCreditsPerUsd,transform:model=>wanVideoView(model,hd,{hd:!hdOff.has(model.publicModelId)})});
    video=[...video,...catalog.video];
  }
  // Seedance Lite on Sluice: rendered at the chosen resolution, priced at cost.
  if(access.sluice && providerSettings.sluice.active){
    const catalog=await publicProviderCatalog('sluice',{creditsPerUsd:providerSettings.sluice.customerCreditsPerUsd});
    video=[...video,...catalog.video];
  }
  video=[...video,...directVideoModels(access,providerSettings)];
  return {video,image,upscaler:publicUpscalerConfig(Boolean(access.fal && providerSettings.fal.active))};
}

// The API vendor behind a model id, for the admin.
function modelVendor(id){
  if(isApi888Model(id))return '888API';
  if(isArgoModel(id))return 'ArgoLink';
  if(isHiggsfieldModel(id))return 'Higgsfield';
  if(isSluiceModel(id))return 'Sluice';
  if(isGatewayModel(id))return 'Vercel AI Gateway';
  if(smartImageModel(id))return 'SmartAIPI';
  if(id==='minimax_h3')return 'vgenv';
  return '';
}

// Every model a studio can show (sources the admin has turned on), with the
// source's name and the admin's name, for Admin → Provider → Model names.
async function adminModelNameList(){
  const everyone=defaultCustomerProviderAccess();
  const [catalog,names,hdOff]=await Promise.all([sourceMediaCatalog(everyone),modelDisplayNames(),argoHdOffModels()]);
  const cartoon=publicPricing();
  const rows=[];
  for(const [studio,list] of [['video',catalog.video],['image',catalog.image],['cartoon',cartoon]]){
    for(const m of list)rows.push({key:studio+':'+m.id,studio,id:m.id,vendor:modelVendor(m.id),defaultName:m.label,name:names[studio+':'+m.id]||'',
      ...(studio==='video'&&(isArgoModel(m.id)||isHiggsfieldModel(m.id))?{hdEnhance:!hdOff.has(m.id)}:{})});
  }
  return rows;
}

// Example price of every model at its default settings, for the public
// Pricing page (no sign-in needed). Cached for 10 minutes.
// Seedance 2.5 on ArgoLink looks expensive next to the rest, so the Pricing
// page leaves it out; Seedance Lite (Sluice) stays.
const PRICING_PAGE_HIDDEN=['argo_seedance_2_5'];
let priceExamplesCache=null;
async function priceExamples(){
  if(priceExamplesCache&&Date.now()-priceExamplesCache.at<10*60*1000)return priceExamplesCache.data;
  const catalog=await customerMediaCatalog(defaultCustomerProviderAccess());
  const video=[],image=[];
  for(const m of catalog.video){
    // Not listed on the Pricing page; the studios still offer it.
    if(PRICING_PAGE_HIDDEN.includes(m.id))continue;
    let seconds=m.defaultDuration||m.durations?.[0]?.seconds||null,resolution=m.defaultResolution||null,credits=null;
    if(!m.dynamicCost){
      const list=(m.resolutions?.length?((m.resolutions.find(r=>r.id===resolution)||m.resolutions[0]).durations):m.durations)||[];
      const d=list.find(x=>x.seconds===seconds)||list[0];credits=Number(d?.cost)||null;seconds=d?.seconds??seconds;
    }else{
      try{credits=(await quoteModelForUser(null,{model:m.id,mediaType:'video',duration:seconds,resolution,aspectRatio:m.defaultAspectRatio,generateAudio:m.supportsAudio===true})).cost;}catch{}
    }
    if(credits>0)video.push({name:m.label,seconds,resolution,credits,...(m.warning?{warning:m.warning}:{})});
  }
  for(const m of catalog.image){
    let credits=Number(m.cost)||null;
    if(!credits&&m.costTable){const values=Object.values(m.costTable).map(Number).filter(n=>n>0);credits=values.length?Math.min(...values):null;}
    if(credits>0)image.push({name:m.label,credits});
  }
  const data={video,image,upscaler:catalog.upscaler?.enabled||false};
  priceExamplesCache={at:Date.now(),data};
  return data;
}

// CMM Tools vs other platforms for the /compare page, at live prices. Cached for 10 minutes.
let priceComparisonCache=null;
async function priceComparison(){
  if(priceComparisonCache&&Date.now()-priceComparisonCache.at<10*60*1000)return priceComparisonCache.data;
  const data=await comparePrices(async c=>(await quoteModelForUser(null,{model:c.model,mediaType:'video',duration:c.seconds,resolution:c.resolution,aspectRatio:'16:9',generateAudio:c.audio})).cost);
  if(data.rows.length)priceComparisonCache={at:Date.now(),data};
  return data;
}

const httpError=(statusCode,message)=>Object.assign(new Error(message),{statusCode});

// Live price of an ArgoLink or AI Gateway model ({cost,isEstimate}).
async function quoteModelForUser(userId,body){
  const access=await getUserProviderAccess(userId);
  const mediaType=body.mediaType==='image'?'image':'video';
  const providerSettings=await getAdminProviderSettings();
  if(mediaType==='video'&&DIRECT_VIDEO_MODELS.includes(String(body.model))){
    if(!directVideoSourceActive(String(body.model),access,providerSettings))throw httpError(403,'This model source is unavailable for your account.');
    return {cost:getCost(String(body.model),Number(body.duration),body.resolution||null),isEstimate:false};
  }
  if(isApi888Model(body.model)){
    if(!access.api888||!providerSettings.api888.active)throw httpError(403,'This provider is not enabled.');
    const model=await getProviderModelByPublicId('api888',String(body.model),mediaType);
    if(!model?.ready)throw httpError(404,'888API model not ready.');
    const quote=quoteApi888(model,body,providerSettings.api888.creditsPerCny);
    return {cost:quote.cost,isEstimate:false};
  }
  if(isArgoModel(body.model)){
    if(!access.argolink||!providerSettings.argolink.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId('argolink',String(body.model),mediaType);
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    const quote=mediaType==='video'?await quoteArgoStudioVideo(model,body,await getProviderSettings()):quoteGateway(model,body,providerSettings.argolink.customerCreditsPerUsd);
    return {cost:quote.cost,isEstimate:quote.isEstimate};
  }
  if(isSluiceModel(body.model)&&mediaType==='video'){
    if(!access.sluice||!providerSettings.sluice.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId('sluice',String(body.model),'video');
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    const quote=quoteGateway(model,body,providerSettings.sluice.customerCreditsPerUsd);
    return {cost:quote.cost,isEstimate:quote.isEstimate};
  }
  if(isHiggsfieldModel(body.model)&&mediaType==='video'){
    if(!access.higgsfield||!providerSettings.higgsfield.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId('higgsfield',String(body.model),'video');
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    const quote=await quoteHiggsfieldVideo(model,body,await getProviderSettings());
    return {cost:quote.cost,isEstimate:quote.isEstimate};
  }
  if(isGatewayModel(body.model)){
    if(!access.vercel||!providerSettings.vercel.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId('vercel',String(body.model),mediaType);
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    const quote=quoteGateway(model,body,providerSettings.vercel.customerCreditsPerUsd);
    return {cost:quote.cost,isEstimate:quote.isEstimate};
  }
  throw httpError(404,'Live pricing is unavailable for this model.');
}

// Higgsfield's Wan 3.0: 480p native; 720p and 1080p rendered lower and
// upscaled by fal (HD enhancement) unless the admin turned HD enhance off for
// the model. Sold at cost (wan_pricing.js).
async function quoteHiggsfieldVideo(model,body,settings){
  return applyWanCap(model.publicModelId,quoteArgoVideo(model,body,settings,{hd:!(await argoHdOffModels()).has(model.publicModelId),view:wanVideoView,creditsPerUsd:settings.higgsfieldCustomerCreditsPerUsd}));
}
// Seedance Lite (Sluice) in Cartoon Studio: a fixed price per duration at the
// default resolution, the image fee, and the ratios the model makes.
async function sluiceCartoonPricing(providerSettings){
  const out=[];
  for(const row of await publicProviderCatalog('sluice',{}).then(c=>c.video).catch(()=>[])){
    const model=await getProviderModelByPublicId('sluice',row.id,'video');
    if(!model?.ready)continue;
    const price=body=>quoteGateway(model,body,providerSettings.sluice.customerCreditsPerUsd).cost;
    const ratio=model.defaultAspectRatio;
    out.push({id:model.publicModelId,label:model.label.split(' · ')[0],aspectRatios:model.aspectRatios,
      durations:model.durations.map(seconds=>({seconds,cost:price({duration:seconds,aspectRatio:ratio})})),
      referenceSurcharge:price({duration:model.durations[0],aspectRatio:ratio,images:[{}]})-price({duration:model.durations[0],aspectRatio:ratio})});
  }
  return out;
}

// Wan 3.0's per-second prices from Higgsfield's estimates (nothing is charged).
async function syncHiggsfieldPrices(){
  const s=await getProviderSettings();
  const client=new HiggsfieldClient({apiKey:s.higgsfieldApiKey});
  let tiers;
  try{tiers=await fetchHiggsfieldTiers((path,input)=>client.estimate(path,input));}
  catch(error){
    logActivity({level:'error',category:'admin',event:'higgsfield.prices_sync_failed',provider:'higgsfield',message:'Wan 3.0 prices could not be read: '+error.message,details:errorDetails(error)});
    throw error;
  }
  const models=await syncProviderModels('higgsfield',higgsfieldMediaModels(tiers));
  logActivity({category:'admin',event:'higgsfield.prices_synced',provider:'higgsfield',message:'Wan 3.0 prices synced from Higgsfield estimates',details:{tiers,description:tiers.description||null}});
  return {models,tiers};
}
async function quoteArgoStudioVideo(model,body,settings){
  return applyWanCap(model.publicModelId,quoteArgoVideo(model,body,settings,{hd:!(await argoHdOffModels()).has(model.publicModelId)}));
}

// Video Studio and Cartoon Studio submissions (the website and the Claude connector).
async function submitVideoGeneration(user,body,req=null){
  // Preview hints are for /api/model-cost only; a job is priced from its files.
  if(body&&typeof body==='object'){delete body.previewVideoSeconds;delete body.previewHasReferences;}
  const providerSettings=await getProviderSettings();
  if (!providerSettings.allowProviderCharges) {
    throw httpError(503,'Generation submissions are currently paused.');
  }

  const requestedModel=String(body.model||'');
  const customerAccess=await getUserProviderAccess(user.id);
  let generation=null;
  // Cartoon Studio runs on MiniMax H3 (vgenv) or Seedance Lite (Sluice).
  const cartoonOptions=body.cartoonStyle?normalizeCartoonRequest(body):null;

  if(!cartoonOptions&&isApi888Model(requestedModel)){
    if(!customerAccess.api888||!providerSettings.api888Enabled||!providerSettings.api888ApiKey||!(providerSettings.api888CreditsPerCny>0))throw httpError(503,'888API video generation is unavailable.');
    const model=await getProviderModelByPublicId('api888',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'888API model not ready.');
    validateReferences(model,body);
    const quote=quoteApi888(model,body,providerSettings.api888CreditsPerCny);
    generation=await createGenerationForUser(user.id,{...body,...quote},{provider:'api888',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceCny,providerCostUnit:'cny',generationOptions:{...quote,model}});
  }
  if(!cartoonOptions&&isArgoModel(requestedModel)){
    if(!customerAccess.argolink||!providerSettings.argoLinkEnabled||!providerSettings.argoLinkApiKey)throw httpError(503,'This video model is currently unavailable.');
    const model=await getProviderModelByPublicId('argolink',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'This video model is currently unavailable.');
    validateReferences(model,body);
    // 720p/1080p may be rendered lower and upscaled by fal (HD enhancement).
    const quote=await quoteArgoStudioVideo(model,body,providerSettings);
    generation=await createGenerationForUser(user.id,{...body,...quote},{provider:'argolink',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd',generationOptions:{...quote,model},
    });
  }

  // Seedance Lite on Sluice, in Video Studio and Cartoon Studio (the style is
  // kept on the job and added to the prompt when it is sent).
  if(isSluiceModel(requestedModel)){
    if(!customerAccess.sluice||!providerSettings.sluiceEnabled||!providerSettings.sluiceApiKey)throw httpError(503,'This video model is currently unavailable.');
    const model=await getProviderModelByPublicId('sluice',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'This video model is currently unavailable.');
    validateReferences(model,body);
    const quote=quoteGateway(model,body,providerSettings.sluiceCustomerCreditsPerUsd);
    generation=await createGenerationForUser(user.id,{...body,...quote},{provider:'sluice',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd',generationOptions:{...quote,model,...(cartoonOptions||{})},
    });
  }

  if(!cartoonOptions&&isHiggsfieldModel(requestedModel)){
    if(!customerAccess.higgsfield||!providerSettings.higgsfieldEnabled||!providerSettings.higgsfieldApiKey)throw httpError(503,'This video model is currently unavailable.');
    const model=await getProviderModelByPublicId('higgsfield',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'This video model is currently unavailable.');
    validateReferences(model,body);
    validateHiggsfieldReferences(model,body,{mp4Seconds});
    const quote=await quoteHiggsfieldVideo(model,body,providerSettings);
    generation=await createGenerationForUser(user.id,{...body,...quote},{provider:'higgsfield',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd',generationOptions:{...quote,model},
    });
  }

  // Video Studio runs on ArgoLink and Higgsfield, and MiniMax H3 on vgenv.
  if (!generation && !cartoonOptions && !DIRECT_VIDEO_MODELS.includes(requestedModel)) throw httpError(400,'This video model is not available. Choose a model from the list.');

  if (!generation) {
    if (requestedModel==='minimax_h3') {
      if (!customerAccess.vgenv || !providerSettings.vgenvEnabled || !providerSettings.vgenvApiKey) {
        throw httpError(503,'This model is currently unavailable.');
      }
    }
    // Video Studio's MiniMax H3 also takes sound clips and a reference video (src/h3_references.js).
    // Every direct model runs on vgenv now (MiniMax H3).
    const options=cartoonOptions?{provider:'vgenv',generationOptions:cartoonOptions}
      :{provider:'vgenv',validateMedia:(audios,videos,images)=>validateH3Media(audios,videos,images,{mp4Seconds})};
    generation=await createGenerationForUser(user.id,body,options);
  }

  wakeForNewWork(req);
  return generation;
}

// Image Studio submissions (the website and the Claude connector).
async function submitImageGeneration(user,body,req=null){
  const providerSettings=await getProviderSettings();
  if (!providerSettings.allowProviderCharges) {
    throw httpError(503,'Generation submissions are currently paused.');
  }

  await attachReusedImageReferences(getPool(),user.id,body);
  let requestedModel=String(body.model||'');
  const customerAccess=await getUserProviderAccess(user.id);
  let generation=null;

  // AI Gateway and SmartAIPI come first; while one is out of credits its
  // models run on the same ArgoLink model instead.
  const firstSource=isGatewayModel(requestedModel)?'vercel':smartImageModel(requestedModel)?'smartaipi':null;
  if(firstSource){
    const label=firstSource==='vercel'?(await getProviderModelByPublicId('vercel',requestedModel,'image'))?.label:smartImageModel(requestedModel).label;
    const swap=await submissionFailover(getPool(),{source:firstSource,label,body,settings:providerSettings,access:customerAccess});
    if(swap){
      requestedModel=swap.model.publicModelId;
      for(const key of ['imageSize','quality'])if(key in swap.body)body[key]=swap.body[key];else delete body[key];
    }
  }

  if(isGatewayModel(requestedModel)){
    if(!customerAccess.vercel||!providerSettings.vercelEnabled||!providerSettings.vercelApiKey)throw httpError(503,'This image model is currently unavailable.');
    const model=await getProviderModelByPublicId('vercel',requestedModel,'image');
    if(!model?.ready)throw httpError(404,'This image model is currently unavailable.');
    validateReferences(model,body);
    const quote=quoteGateway(model,body,providerSettings.vercelCustomerCreditsPerUsd);
    generation=await createImageGenerationForUser(user.id,{...body,aspectRatio:quote.aspectRatio},{
      provider:'vercel',dynamicModel:true,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd-estimate',imageQuality:quote.quality,
      generationOptions:{...quote,model},
    });
  }

  if(isApi888Model(requestedModel)){
    if(!customerAccess.api888||!providerSettings.api888Enabled||!providerSettings.api888ApiKey||!(providerSettings.api888CreditsPerCny>0))throw httpError(503,'888API image generation is unavailable.');
    const model=await getProviderModelByPublicId('api888',requestedModel,'image');
    if(!model?.ready)throw httpError(404,'888API image model not ready.');
    if((body.images||[]).length||body.reuseImageIds?.length)throw httpError(400,'888API image editing is not yet available.');
    validateReferences(model,body);
    const quote=quoteApi888(model,body,providerSettings.api888CreditsPerCny);
    generation=await createImageGenerationForUser(user.id,{...body,aspectRatio:quote.aspectRatio},{
      provider:'api888',dynamicModel:true,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceCny,providerCostUnit:'cny',
      generationOptions:{...quote,model}});
  }
  if(isArgoModel(requestedModel)){
    if(!customerAccess.argolink||!providerSettings.argoLinkEnabled||!providerSettings.argoLinkApiKey)throw httpError(503,'This image model is currently unavailable.');
    const model=await getProviderModelByPublicId('argolink',requestedModel,'image');
    if(!model?.ready)throw httpError(404,'This image model is currently unavailable.');
    validateReferences(model,body);
    const quote=quoteGateway(model,body,providerSettings.argoLinkCustomerCreditsPerUsd);
    generation=await createImageGenerationForUser(user.id,{...body,aspectRatio:quote.aspectRatio},{
      provider:'argolink',dynamicModel:true,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd',imageQuality:quote.quality,
      generationOptions:{...quote,model},
    });
  }

  if (smartImageModel(requestedModel)) {
    if (!customerAccess.smartaipi || !providerSettings.smartAipiEnabled || !providerSettings.smartAipiApiKey) {
      throw httpError(503,'This image model is currently unavailable.');
    }
    const quote=smartImageQuote(requestedModel,String(body.aspectRatio||body.aspect_ratio||''),providerSettings,body.quality??'medium');
    for(const image of (Array.isArray(body.images)?body.images:[]))validateSmartReference(image?.data);
    generation=await createImageGenerationForUser(user.id,body,{
      provider:'smartaipi',dynamicModel:true,referenceCapabilities:SMART_IMAGE_REFS,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd-estimate',imageQuality:quote.quality,
    });
  }

  if (!generation) throw httpError(503,'This image model is currently unavailable.');
  wakeForNewWork(req);
  return generation;
}

// Upscaler submissions (the website and the Claude connector).
async function submitUpscale(user,{resolution,source},req=null){
  const settings=await getProviderSettings();
  if (!settings.allowProviderCharges) throw httpError(503,'Generation submissions are currently paused.');
  const access=await getUserProviderAccess(user.id);
  if (!access.fal || !settings.falEnabled || !settings.falApiKey) throw httpError(503,'The video upscaler is currently unavailable.');
  const row=await createUpscaleJob(user.id,{resolution,source},settings);
  wakeForNewWork(req);
  return row;
}

function userPayload(user) {
  return {
    id:Number(user.id), email:user.email, credits:Number(user.credits),
    plan_code:user.plan_code || null,
    role:user.role, status:user.status, created_at:user.created_at,
    updated_at:user.updated_at || null,
  };
}
function requireDatabase() {
  if (!dbConfigured()) {
    const error=new Error('MySQL is not configured yet.'); error.statusCode=503; throw error;
  }
}
// Finished outputs never change under the same generation URL, so browsers may
// reuse them instead of re-downloading every image and video on each visit.
const IMMUTABLE_MEDIA_CACHE='private, max-age=31536000, immutable';
const MEDIA_PROXY_HEADER_TIMEOUT_MS=Math.max(5000,Number(process.env.MEDIA_PROXY_HEADER_TIMEOUT_MS||30000));
async function proxyMedia(req,res,row,type) {
  const target = type === 'poster' ? row.poster_url : row.output_url;
  if (!target) return sendJson(res,404,{ok:false,error:'Media not available.'});

  const headers={};
  if (req.headers.range) headers.range=req.headers.range;
  // Abort the provider download when the viewer disconnects (browsers cancel
  // video range requests constantly) or the provider stops responding.
  const controller=new AbortController();
  const abortUpstream=()=>controller.abort();
  res.once('close',abortUpstream);
  const headerTimer=setTimeout(abortUpstream,MEDIA_PROXY_HEADER_TIMEOUT_MS);
  let upstream;
  try {
    upstream=await fetch(target,{headers,redirect:'follow',signal:controller.signal});
  } catch {
    res.removeListener('close',abortUpstream);
    if (res.destroyed) return;
    return sendJson(res,502,{ok:false,error:'Provider media fetch failed.'});
  } finally {
    clearTimeout(headerTimer);
  }
  if (!upstream.ok && upstream.status !== 206) {
    res.removeListener('close',abortUpstream);
    controller.abort();
    return sendJson(res,502,{ok:false,error:'Provider media fetch failed.'});
  }

  const pass=['content-type','content-length','content-range','accept-ranges','etag','last-modified'];
  for (const name of pass) {
    const value=upstream.headers.get(name);
    if (value) res.setHeader(name,value);
  }
  res.setHeader('cache-control','private, max-age=3600');
  res.statusCode=upstream.status;
  if (!upstream.body) return res.end();
  // pipeline() handles stream errors; a bare pipe() let a provider connection
  // reset escape as an unhandled 'error' event and crash the web process.
  try {
    await pipeline(Readable.fromWeb(upstream.body),res);
  } catch (error) {
    controller.abort();
    if (!res.destroyed) res.destroy();
    if (error?.name!=='AbortError' && error?.code!=='ERR_STREAM_PREMATURE_CLOSE' && error?.code!=='ABORT_ERR') {
      console.warn('[media-proxy] provider stream ended early:',error?.cause?.code||error?.code||error?.message||error);
    }
  } finally {
    res.removeListener('close',abortUpstream);
  }
}

// The Claude connector (MCP server, its sign-in and download links).
const connector=createConnector({
  getPool, sendJson, sendHtml, readJson, publicOrigin, requireDatabase, requireUser, adminAuthorized,
  userFromRequest:authModule.userFromRequest, sessionTokenHash:authModule.sessionTokenHash,
  logActivity, getSettingValue, setSettingValue, proxyMedia, serveVideoOutput,
  catalog:async userId=>customerMediaCatalog(await getUserProviderAccess(userId)),
  quote:quoteModelForUser,
  submitVideo:(user,body)=>submitVideoGeneration(user,body),
  submitImage:(user,body)=>submitImageGeneration(user,body),
  submitUpscale:(user,input)=>submitUpscale(user,input),
  wake:()=>{if(wakeAllowed())wakeWorker();},
});

const server=http.createServer(async (req,res)=>{
  const requestStarted=performance.now();
  const url=new URL(req.url||'/', 'http://' + (req.headers.host||'localhost'));
  const routePath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  res.once('finish',()=>{const ms=performance.now()-requestStarted;diagnostics.recordRequest(req.method,req.url,ms,res.statusCode);logRequest(req,routePath,res,ms);});
  const canonical=canonicalRedirect(req,routePath,url);
  if(canonical){res.writeHead(301,{location:canonical,'cache-control':'no-store'});return res.end();}

  try {
    const studioAssets={
      '/brand.css':['brand.css','text/css; charset=utf-8'],
      '/studio.css':['studio.css','text/css; charset=utf-8'],
      '/admin.css':['admin.css','text/css; charset=utf-8'],
      '/assets/cmmtools-logo.png':['assets/cmmtools-logo.png','image/png'],
      '/assets/cmmtools-logo-sm.png':['assets/cmmtools-logo-sm.png','image/png'],
      '/assets/cmmtools-icon.png':['assets/cmmtools-icon.png','image/png'],
      '/assets/cmmtools-mcp-icon.png':['assets/cmmtools-mcp-icon.png','image/png'],
      '/favicon.ico':['assets/cmmtools-icon.png','image/png'],
      '/assets/fonts/inter-latin-wght.woff2':['assets/fonts/inter-latin-wght.woff2','font/woff2'],
    };
    // MCP Apps client for the CMM Tools card in Claude, loaded from Claude's
    // sandbox origin as a module script (needs CORS).
    if ((req.method==='GET'||req.method==='HEAD') && routePath==='/vendor/mcp-ext-apps-1.7.5.js') {
      const data=fs.readFileSync(path.join(__dirname,'vendor','mcp-ext-apps-1.7.5.js'));
      res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','content-length':data.length,'cache-control':'public, max-age=31536000, immutable',
        'access-control-allow-origin':'*','cross-origin-resource-policy':'cross-origin','x-content-type-options':'nosniff'});
      return res.end(req.method==='HEAD'?undefined:data);
    }
    if ((req.method==='GET'||req.method==='HEAD') && studioAssets[routePath]) {
      const [file,contentType]=studioAssets[routePath];
      const data=fs.readFileSync(path.join(__dirname,'public',file));
      res.writeHead(200,{'content-type':contentType,'content-length':data.length,'cache-control':'public, max-age=3600','x-content-type-options':'nosniff'});
      return res.end(req.method==='HEAD'?undefined:data);
    }
    if (req.method==='GET' && routePath==='/') return sendHtml(res,200,hasSessionCookie(req)?customerPage:landingPage);
    if (req.method==='GET' && routePath==='/app') return sendHtml(res,200,customerPage);
    if (req.method==='GET' && routePath==='/pricing') return sendHtml(res,200,pricingPage);
    if (req.method==='GET' && routePath==='/compare') return sendHtml(res,200,comparePage);
    if (req.method==='GET' && routePath==='/admin-console') return sendHtml(res,200,adminPage);
    if (await connector.handle(req,res,url,routePath)) return;

    // Reference files for providers. HEAD is answered too: some downloaders
    // check a file with HEAD before fetching it (Node sends no body for HEAD).
    const providerAssetMatch=routePath.match(/^\/provider-assets\/([0-9a-f-]{36})\/(\d+)$/i);
    if ((req.method==='GET'||req.method==='HEAD') && providerAssetMatch) {
      requireDatabase();
      const generationId=providerAssetMatch[1];
      const position=Number(providerAssetMatch[2]);
      const signature=String(url.searchParams.get('sig')||'');
      if (!verifyAssetSignature(generationId,position,signature)) {
        return sendJson(res,403,{ok:false,error:'Invalid provider asset signature.'});
      }
      const db=getPool();
      const [rows]=await db.execute(
        'SELECT filename,mime_type,image_data FROM generation_images WHERE generation_id=? AND position_index=? LIMIT 1',
        [generationId,position]
      );
      const image=rows[0];
      if (!image) return sendJson(res,404,{ok:false,error:'Provider asset not found.'});
      res.statusCode=200;
      res.setHeader('content-type',image.mime_type);
      res.setHeader('content-length',image.image_data.length);
      res.setHeader('cache-control','private, max-age=300');
      res.setHeader('x-content-type-options','nosniff');
      return res.end(req.method==='HEAD'?undefined:image.image_data);
    }

    // A finished video for the upscaler to download (signed link, no login).
    const providerOutputMatch=routePath.match(/^\/provider-outputs\/([0-9a-f-]{36})$/i);
    if(req.method==='GET'&&providerOutputMatch){
      requireDatabase();
      const id=providerOutputMatch[1];
      if(!verifyOutputSignature(id,String(url.searchParams.get('sig')||'')))return sendJson(res,403,{ok:false,error:'Invalid provider asset signature.'});
      // Also serves a stored video before its job completes: ArgoLink HD
      // enhancement hands its first render to the upscaler this way.
      const [[row]]=await getPool().execute("SELECT g.id,g.output_url,g.poster_url,o.generation_id AS stored FROM generations g LEFT JOIN generation_video_outputs o ON o.generation_id=g.id WHERE g.id=? AND g.media_type='video' LIMIT 1",[id]);
      if(!row?.stored&&!row?.output_url)return sendJson(res,404,{ok:false,error:'Provider asset not found.'});
      if(row.stored){
        try{return await serveVideoOutput(getPool(),req,res,row.id);}
        catch(error){if(res.headersSent){res.destroy();return;}throw error;}
      }
      return proxyMedia(req,res,row,'video');
    }

    const providerMediaMatch=routePath.match(/^\/provider-media\/([0-9a-f-]{36})\/(\d+)$/i);
    if((req.method==='GET'||req.method==='HEAD')&&providerMediaMatch){
      requireDatabase();
      const id=providerMediaMatch[1],position=Number(providerMediaMatch[2]);
      if(!verifyAssetSignature(id,position,String(url.searchParams.get('sig')||'')))return sendJson(res,403,{ok:false,error:'Invalid provider asset signature.'});
      const [[media]]=await getPool().execute('SELECT mime_type,media_data FROM generation_media WHERE generation_id=? AND position_index=? LIMIT 1',[id,position]);
      if(!media)return sendJson(res,404,{ok:false,error:'Provider asset not found.'});
      res.writeHead(200,{'content-type':media.mime_type,'content-length':media.media_data.length,'cache-control':'private, max-age=300','x-content-type-options':'nosniff'});
      return res.end(req.method==='HEAD'?undefined:media.media_data);
    }

    if (req.method==='GET' && routePath==='/live') {
      return sendJson(res,200,{
        ok:true,
        app:'mehroz-ai',
        startedAt:new Date(PROCESS_STARTED_AT).toISOString(),
        runtime:{...runtimeSnapshot(),...diagnostics.summary()},
      });
    }

    if (req.method==='GET' && routePath==='/health') {
      const database=await dbHealth();
      let generationBackendReady=false;
      let generationEnabled=false;
      let imageGenerationReady=false;
      if (database.connected) {
        const providerSettings=await getAdminProviderSettings();
        generationBackendReady=Boolean(
          providerSettings.vgenv.active ||
          providerSettings.vibi.active || providerSettings.smartaipi.active || providerSettings.vercel.active || providerSettings.argolink.active || providerSettings.higgsfield.active || providerSettings.sluice.active
        );
        imageGenerationReady=Boolean(providerSettings.vercel.active || providerSettings.argolink.active || (providerSettings.smartaipi.active && providerSettings.smartaipi.models.some(m=>m.enabled && Object.values(m.qualitySourceUsd).some(n=>n>0))));
        generationEnabled=Boolean(providerSettings.allowProviderCharges);
      }
      return sendJson(res,200,{
        ok:true,
        app:'mehroz-ai',
        milestone:5,
        node:process.version,
        database,
        services:{
          queueRevision:1,
          mediaGatewayRevision:1,
          imageCanvasRevision:1,
          workerWakeup:workerWakeup.status(),
          generationBackendReady,
          imageGenerationReady,
          workerEnabled:/^(1|true|yes|on)$/i.test(String(process.env.WORKER_ENABLED||'true')),
          workerMode:'isolated-child',
          workerOnline:Boolean(workerChild && workerChild.exitCode===null),
          generationEnabled,
        },
        config:{
          adminTokenConfigured:Boolean(adminToken),
          signupsEnabled:allowSignups,
        },
        runtime:{...runtimeSnapshot(),...diagnostics.summary()},
      });
    }

    if (req.method==='GET' && routePath==='/api/compare-prices') {
      if(!dbConfigured())return sendJson(res,200,{ok:true,rows:[],plans:[]});
      try{return sendJson(res,200,{ok:true,...await priceComparison()});}
      catch{return sendJson(res,200,{ok:true,rows:[],plans:[]});}
    }

    if (req.method==='GET' && routePath==='/api/price-examples') {
      if(!dbConfigured())return sendJson(res,200,{ok:true,video:[],image:[]});
      try{return sendJson(res,200,{ok:true,...await priceExamples()});}
      catch{return sendJson(res,200,{ok:true,video:[],image:[]});}
    }

    if (req.method==='GET' && routePath==='/api/config') {
      // Video Studio: ArgoLink, Higgsfield and MiniMax H3 (vgenv). Cartoon Studio: MiniMax H3 (vgenv). Image Studio: AI Gateway and SmartAIPI first,
      // then ArgoLink models they do not offer. Voice Studio: Vibi.
      let videoPricing=[];
      let imagePricing=[];
      let cartoonPricing=[];
      let voiceConfig={enabled:false};
      let promptEnhancerConfig={enabled:false,maxPromptChars:8000,revision:5,async:true,timeoutMs:ENHANCEMENT_TIMEOUT_MS};
      let customerProviderAccess=defaultCustomerProviderAccess();
      let cartoonEnabled=false;
      let upscalerConfig=publicUpscalerConfig(false);

      if (dbConfigured()) {
        try {
          const currentUser=await userFromRequest(req);
          if(currentUser)customerProviderAccess=await getUserProviderAccess(currentUser.id);
          const providerSettings=await getAdminProviderSettings();
          promptEnhancerConfig.enabled=Boolean(currentUser?.status==='active' && providerSettings.promptEnhancer.active);
          const h3Active=Boolean(customerProviderAccess.vgenv && providerSettings.vgenv.active);
          const names=await modelDisplayNames().catch(()=>({}));
          cartoonPricing=applyModelNames('cartoon',[
            ...(customerProviderAccess.sluice&&providerSettings.sluice.active?await sluiceCartoonPricing(providerSettings):[]),
            ...publicPricing().filter(model=>model.id==='minimax_h3'&&h3Active)],names);
          cartoonEnabled=cartoonPricing.length>0;

          const media=await customerMediaCatalog(customerProviderAccess,providerSettings,{names});
          videoPricing=media.video;
          imagePricing=media.image;
          upscalerConfig=media.upscaler;

          if (customerProviderAccess.vibi && providerSettings.vibi.active) {
            voiceConfig={enabled:true,cloningAvailable:true,maxTextChars:10000,cloneMaxBytes:20*1024*1024};
          }
        } catch {
          // Keep public config usable during transient database/provider-setting issues.
        }
      }

      return sendJson(res,200,{
        ok:true,
        signupsEnabled:allowSignups,
        pricing:videoPricing,
        aspectRatios:ASPECT_RATIOS,
        imagePricing,
        imageAspectRatios:IMAGE_ASPECT_RATIOS,
        voice:voiceConfig,
        promptEnhancer:promptEnhancerConfig,
        providerAccess:customerProviderAccess,
        cartoon:publicCartoonConfig(cartoonEnabled,cartoonPricing),
        upscaler:upscalerConfig,
        plans:publicPlans(),
        support:{whatsapp:SUPPORT_WHATSAPP,whatsappUrl:whatsappUrl('Hi CMM Tools, I need help with ')},
      });
    }

    if (req.method==='POST' && routePath==='/api/prompts/enhance') {
      requireDatabase();
      const user=await requireUser(req);
      if(user.status!=='active')return sendJson(res,403,{ok:false,error:'Your account is not active.'});
      const settings=await getProviderSettings();
      if(!settings.allowProviderCharges || !settings.promptEnhancerEnabled || !settings.promptEnhancerApiKey) {
        return sendJson(res,503,{ok:false,error:'Prompt enhancer is currently unavailable. Turn it off to use your original prompt.'});
      }
      const body=await readJson(req);
      normalizeEnhancement(body); // Reject invalid input before consuming a request slot.
      if(body.async===true) {
        // Failures are logged (without the prompt) so they can be diagnosed.
        const job=promptEnhancementJobs.start(user.id,body,()=>new GeminiPromptEnhancer({apiKey:settings.promptEnhancerApiKey}).enhance(body).catch(error=>{
          logActivity({level:'warn',category:'provider',event:'enhancer.failed',userId:user.id,provider:'gemini',message:error.message,details:{statusCode:error.statusCode,mediaType:body.mediaType}});
          throw error;
        }));
        return sendJson(res,job.status==='processing'?202:200,{ok:true,...job});
      }
      const result=await promptEnhancementGate.run(user.id,()=>new GeminiPromptEnhancer({apiKey:settings.promptEnhancerApiKey}).enhance(body));
      return sendJson(res,200,{ok:true,...result});
    }

    const enhancementRequestMatch=routePath.match(/^\/api\/prompts\/enhance\/requests\/([a-f0-9-]{36})$/i);
    if (req.method==='GET' && enhancementRequestMatch) {
      requireDatabase();
      const user=await requireUser(req);
      if(user.status!=='active')return sendJson(res,403,{ok:false,error:'Your account is not active.'});
      const job=promptEnhancementJobs.getByRequest(user.id,enhancementRequestMatch[1]);
      if(!job)return sendJson(res,404,{ok:false,error:'The enhancement request could not be found. Your prompt has been kept.'});
      return sendJson(res,200,{ok:true,...job});
    }

    if (req.method==='GET' && /^\/api\/prompts\/enhance\/[a-f0-9-]{36}$/i.test(routePath)) {
      requireDatabase();
      const user=await requireUser(req);
      if(user.status!=='active')return sendJson(res,403,{ok:false,error:'Your account is not active.'});
      const job=promptEnhancementJobs.get(user.id,routePath.split('/').pop());
      if(!job)return sendJson(res,404,{ok:false,error:'This enhancement expired or the service restarted. Your prompt has been kept. Generate again to retry.'});
      return sendJson(res,200,{ok:true,...job});
    }

    if (req.method==='POST' && routePath==='/api/model-cost') {
      requireDatabase();
      const costUser=await requireUser(req);
      return sendJson(res,200,{ok:true,...await quoteModelForUser(costUser.id,await readJson(req))});
    }

    if (req.method==='POST' && routePath==='/api/auth/register') {
      requireDatabase();
      if (!allowSignups) return sendJson(res,403,{ok:false,error:'Signups are disabled.'});
      const body=await readJson(req);
      const email=normalizeEmail(body.email);
      if (!validateEmail(email)) return sendJson(res,400,{ok:false,error:'Enter a valid email address.'});
      const passwordHash=await hashPassword(body.password);
      const db=getPool();
      try {
        const [result]=await db.execute(
          'INSERT INTO users (email,password_hash,credits) VALUES (?,?,?)',
          [email,passwordHash,startingCredits],
        );
        await createSession(res,result.insertId);
        const [rows]=await db.execute('SELECT * FROM users WHERE id=?',[result.insertId]);
        return sendJson(res,201,{ok:true,user:userPayload(rows[0])});
      } catch(error) {
        if (error && error.code==='ER_DUP_ENTRY') return sendJson(res,409,{ok:false,error:'An account with this email already exists.'});
        throw error;
      }
    }

    if (req.method==='POST' && routePath==='/api/auth/login') {
      requireDatabase();
      const body=await readJson(req);
      const email=normalizeEmail(body.email);
      const db=getPool();
      const [rows]=await db.execute('SELECT * FROM users WHERE email=? LIMIT 1',[email]);
      const user=rows[0];
      if (!user || user.status!=='active' || !(await verifyPassword(body.password,user.password_hash))) {
        return sendJson(res,401,{ok:false,error:'Invalid email or password.'});
      }
      req.activityUserId=user.id;
      await createSession(res,user.id);
      return sendJson(res,200,{ok:true,user:userPayload(user)});
    }

    if (req.method==='POST' && routePath==='/api/auth/logout') {
      requireDatabase();
      await destroySession(req,res);
      return sendJson(res,200,{ok:true});
    }

    if (req.method==='GET' && routePath==='/api/me') {
      requireDatabase();
      const user=await userFromRequest(req);
      if (!user) return sendJson(res,401,{ok:false,error:'Not signed in.'});
      return sendJson(res,200,{ok:true,user:userPayload(user)});
    }

    if (req.method==='GET' && routePath==='/api/dashboard') {
      requireDatabase();
      const user=await requireUser(req);
      const db=getPool();
      const [statusRows]=await db.execute(
        `SELECT status, COUNT(*) AS total FROM generations WHERE user_id=? GROUP BY status`,
        [user.id],
      );
      const generationCounts={};
      for (const row of statusRows) generationCounts[row.status]=Number(row.total);
      const [creditRows]=await db.execute(
        `SELECT id, generation_id, amount, type, note, created_at
         FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 8`,
        [user.id],
      );
      return sendJson(res,200,{
        ok:true,
        user:userPayload(user),
        stats:{
          total:Object.values(generationCounts).reduce((sum,value)=>sum+Number(value||0),0),
          completed:Number(generationCounts.completed||0),
          active:Number(generationCounts.queued||0)+Number(generationCounts.submitting||0)+Number(generationCounts.submitted||0)+Number(generationCounts.processing||0),
          failed:Number(generationCounts.failed||0)+Number(generationCounts.submit_error||0),
        },
        recentCredits:creditRows,
      });
    }

    if (req.method==='GET' && routePath==='/api/plan-status') {
      requireDatabase();
      const user=await requireUser(req);
      return sendJson(res,200,{ok:true,...(await getPlanStatus(user.id))});
    }

    if (req.method==='POST' && routePath==='/api/plan-requests') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readJson(req);
      const request=await createPlanRequest(user.id,body.planCode);
      return sendJson(res,201,{ok:true,request});
    }

    if (req.method==='GET' && routePath==='/api/credits') {
      requireDatabase();
      const user=await requireUser(req);
      const db=getPool();
      const [rows]=await db.execute(
        `SELECT id, generation_id, amount, type, note, created_at
         FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100`,
        [user.id],
      );
      return sendJson(res,200,{ok:true,credits:Number(user.credits),transactions:rows});
    }

    if (req.method==='POST' && routePath==='/api/account/password') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readJson(req);
      const current=String(body.currentPassword||'');
      const next=String(body.newPassword||'');
      if (next.length<8) return sendJson(res,400,{ok:false,error:'New password must be at least 8 characters.'});
      const db=getPool();
      const [rows]=await db.execute('SELECT password_hash FROM users WHERE id=? LIMIT 1',[user.id]);
      if (!rows[0] || !(await verifyPassword(current,rows[0].password_hash))) {
        return sendJson(res,401,{ok:false,error:'Current password is incorrect.'});
      }
      const nextHash=await hashPassword(next);
      await db.execute('UPDATE users SET password_hash=?, updated_at=UTC_TIMESTAMP() WHERE id=?',[nextHash,user.id]);
      await db.execute('DELETE FROM sessions WHERE user_id=?',[user.id]);
      await createSession(res,user.id);
      return sendJson(res,200,{ok:true});
    }

    if (req.method==='GET' && routePath==='/api/voice-options') {
      requireDatabase();
      const user=await requireUser(req);
      const access=await getUserProviderAccess(user.id);
      const settings=await getProviderSettings();
      if(!access.vibi||!settings.vibiEnabled||!settings.vibiApiKey)return sendJson(res,503,{ok:false,error:'Voice generation is currently unavailable.'});
      const provider=String(url.searchParams.get('provider')||'elevenlabs')==='minimax'?'minimax':'elevenlabs';
      const client=vibiClient(settings);
      const models=await client.getModels(provider);
      let voices=[];
      if(provider==='minimax'){
        const remote=await client.getMiniMaxSystemVoices({page:1,pageSize:100});
        voices=(remote.voice_list||[]).map(v=>({id:String(v.voice_id||v.uniq_id||''),name:String(v.voice_name||'Voice'),previewUrl:v.sample_audio||null,cloned:false}));
        const db=getPool();
        const [clones]=await db.execute("SELECT id,provider_clone_id,voice_name,sample_audio_url,status FROM user_voice_clones WHERE user_id=? AND provider='vibi' AND status='done' ORDER BY created_at DESC",[user.id]);
        voices.unshift(...clones.filter(v=>v.provider_clone_id).map(v=>({id:String(v.provider_clone_id),name:String(v.voice_name),previewUrl:v.sample_audio_url||null,cloned:true,localId:Number(v.id)})));
      }else{
        const remote=await client.getDefaultVoices({pageSize:100});
        voices=(remote.voices||[]).map(v=>({id:String(v.voice_id||''),name:String(v.name||'Voice'),previewUrl:v.preview_url||null,cloned:false}));
      }
      return sendJson(res,200,{ok:true,provider,models,voices});
    }

    if (req.method==='POST' && routePath==='/api/voice-cost') {
      requireDatabase();
      const user=await requireUser(req);
      const access=await getUserProviderAccess(user.id);
      const settings=await getProviderSettings();
      if(!access.vibi||!settings.vibiEnabled||!settings.vibiApiKey)return sendJson(res,503,{ok:false,error:'Voice generation is currently unavailable.'});
      const body=await readJson(req);
      const text=String(body.text||'').trim();
      if(!text)return sendJson(res,400,{ok:false,error:'Text is required.'});
      const sourceEstimate=Math.max(1,text.length);
      return sendJson(res,200,{ok:true,cost:Number(sourceToCustomerCredits(sourceEstimate)),estimated:true});
    }

    if (req.method==='GET' && routePath==='/api/voice-generations') {
      requireDatabase();
      const user=await requireUser(req);
      return sendJson(res,200,{ok:true,generations:await listUserVoiceGenerations(user.id,60)});
    }

    if (req.method==='POST' && routePath==='/api/voice-generations') {
      requireDatabase();
      const user=await requireUser(req);
      const settings=await getProviderSettings();
      if(!settings.allowProviderCharges)return sendJson(res,503,{ok:false,error:'Generation submissions are currently paused.'});
      const access=await getUserProviderAccess(user.id);
      if(!access.vibi||!settings.vibiEnabled||!settings.vibiApiKey)return sendJson(res,503,{ok:false,error:'Voice generation is currently unavailable.'});
      const body=await readJson(req);
      const text=String(body.text||'').trim();
      const provider=String(body.provider||'elevenlabs')==='minimax'?'minimax':'elevenlabs';
      const voiceId=String(body.voiceId||'').trim();
      const modelId=String(body.modelId||'').trim();
      const languageCode=String(body.languageCode||(provider==='minimax'?'English':'en')).trim();
      if(!text||!voiceId||!modelId)return sendJson(res,400,{ok:false,error:'Text, voice and model are required.'});
      if(text.length>10000)return sendJson(res,400,{ok:false,error:'Text is too long for this voice request.'});
      const voiceSettings=provider==='minimax'
        ?{speed:Number(body.speed||1),pitch:Number(body.pitch||0),vol:Number(body.volume||1)}
        :{stability:Number(body.stability??0.5),similarity_boost:Number(body.similarityBoost??0.75),style:Number(body.style||0),use_speaker_boost:body.useSpeakerBoost!==false,speed:Number(body.speed||1)};
      const sourceEstimate=Math.max(1,text.length);
      const generation=await createVoiceGenerationForUser(user.id,{text,model:String(body.voiceName||'Voice')},{
        provider:'vibi',
        model:String(body.voiceName||'Voice'),
        costOverride:sourceToCustomerCredits(sourceEstimate),
        providerCost:sourceEstimate,
        providerCostUnit:'credits',
        providerParams:{voiceId,modelId,provider,languageCode,voiceSettings}
      });
      wakeGenerationWorker(req);
      const db=getPool();
      const [users]=await db.execute('SELECT * FROM users WHERE id=?',[user.id]);
      return sendJson(res,201,{ok:true,generation,user:userPayload(users[0])});
    }

    const voiceGenMatch=routePath.match(/^\/api\/voice-generations\/([0-9a-f-]{36})$/i);
    const voiceDeleteMatch=req.method==='DELETE'?voiceGenMatch:req.method==='POST'?routePath.match(/^\/api\/voice-generations\/([0-9a-f-]{36})\/delete$/i):null;
    if (voiceDeleteMatch) {
      requireDatabase();const user=await requireUser(req);
      await deleteUserVoiceGeneration(user.id,voiceDeleteMatch[1]);
      return sendJson(res,200,{ok:true,deleted:true,id:voiceDeleteMatch[1]});
    }

    const voiceMediaMatch=routePath.match(/^\/api\/voice-generations\/([0-9a-f-]{36})\/media$/i);
    if (req.method==='GET' && voiceMediaMatch) {
      requireDatabase();const user=await requireUser(req);
      const row=await getUserVoiceGeneration(user.id,voiceMediaMatch[1]);
      if(!row)return sendJson(res,404,{ok:false,error:'Voice generation not found.'});
      return proxyMedia(req,res,row,'video');
    }

    if (req.method==='GET' && routePath==='/api/voice-clones') {
      requireDatabase();const user=await requireUser(req);const db=getPool();
      const [rows]=await db.execute("SELECT id,voice_name,language_tag,gender,status,sample_audio_url,cover_url,error_message,created_at FROM user_voice_clones WHERE user_id=? AND provider='vibi' ORDER BY created_at DESC",[user.id]);
      return sendJson(res,200,{ok:true,clones:rows.map(r=>({...r,id:Number(r.id)}))});
    }

    if (req.method==='POST' && routePath==='/api/voice-clones') {
      requireDatabase();
      const user=await requireUser(req);
      const settings=await getProviderSettings();
      const access=await getUserProviderAccess(user.id);
      if(!access.vibi||!settings.vibiEnabled||!settings.vibiApiKey)return sendJson(res,503,{ok:false,error:'Voice cloning is currently unavailable.'});
      const body=await readVoiceCloneRequest(req);
      const name=String(body.voice_name||'').trim();
      if(!name)return sendJson(res,400,{ok:false,error:'Voice name is required.'});
      const cloneCost=Number(settings.vibiCloneCustomerCost||0);
      const db=getPool();
      const conn=await db.getConnection();
      try{
        await conn.beginTransaction();
        const [users]=await conn.execute('SELECT credits FROM users WHERE id=? FOR UPDATE',[user.id]);
        if(!users[0]||Number(users[0].credits)<cloneCost){const e=new Error('Not enough credits.');e.statusCode=402;throw e}
        if(cloneCost>0)await conn.execute('UPDATE users SET credits=credits-? WHERE id=?',[cloneCost,user.id]);
        const [result]=await conn.execute(
          "INSERT INTO user_voice_clones (user_id,provider,voice_name,language_tag,gender,preview_text,status,credits_cost,sample_filename,sample_mime_type,sample_data) VALUES (?,'vibi',?,?,?,?, 'queued',?,?,?,?)",
          [user.id,name,String(body.language_tag||'English'),String(body.gender||'Male'),String(body.preview_text||'Hello').slice(0,200),cloneCost,body.sample.filename,body.sample.mimeType,body.sample.data]
        );
        if(cloneCost>0)await conn.execute("INSERT INTO credit_transactions (user_id,generation_id,amount,type,note) VALUES (?,NULL,?,'voice_clone_debit',?)",[user.id,-cloneCost,'Reserved for voice cloning']);
        await conn.commit();
        wakeGenerationWorker(req);
        return sendJson(res,201,{ok:true,clone:{id:Number(result.insertId),voice_name:name,status:'queued'}});
      }catch(error){await conn.rollback();throw error}finally{conn.release()}
    }

    if (req.method==='GET' && routePath==='/api/image-generations') {
      requireDatabase();
      const user=await requireUser(req);
      const generations=await listUserImageGenerations(user.id,60);
      if(generations.some(row=>['queued','submitting','submitted','processing'].includes(row.status)))wakeGenerationWorker(req);
      return sendJson(res,200,{ok:true,generations});
    }

    if (req.method==='POST' && routePath==='/api/image-generations') {
      requireDatabase();
      const user=await requireUser(req);
      const generation=await submitImageGeneration(user,await readGenerationRequest(req),req);
      const [users]=await getPool().execute('SELECT * FROM users WHERE id=?',[user.id]);
      return sendJson(res,201,{ok:true,generation,user:userPayload(users[0])});
    }

    const imageGenMatch=routePath.match(/^\/api\/image-generations\/([0-9a-f-]{36})$/i);
    if (req.method==='GET' && imageGenMatch) {
      requireDatabase();
      const user=await requireUser(req);
      const row=await getUserImageGeneration(user.id,imageGenMatch[1]);
      if (!row) return sendJson(res,404,{ok:false,error:'Image generation not found.'});
      if(['queued','submitting','submitted','processing'].includes(row.status))wakeGenerationWorker(req);
      const referenceImages=await listUserGenerationReferenceImages(user.id,row.id);
      return sendJson(res,200,{ok:true,generation:{...serializeImageGeneration(row),reference_images:referenceImages}});
    }

    const imageDeleteMatch=req.method==='DELETE'?imageGenMatch:req.method==='POST'?routePath.match(/^\/api\/image-generations\/([0-9a-f-]{36})\/delete$/i):null;
    if (imageDeleteMatch) {
      requireDatabase();
      const user=await requireUser(req);
      await deleteUserImageGeneration(user.id,imageDeleteMatch[1]);
      return sendJson(res,200,{ok:true,deleted:true,id:imageDeleteMatch[1]});
    }

    const imageMediaMatch=routePath.match(/^\/api\/image-generations\/([0-9a-f-]{36})\/(media|thumbnail)$/i);
    if (req.method==='GET' && imageMediaMatch) {
      requireDatabase();
      const user=await requireUser(req);
      const row=await getUserImageGeneration(user.id,imageMediaMatch[1]);
      if (!row) return sendJson(res,404,{ok:false,error:'Image generation not found.'});
      if (imageMediaMatch[2]==='thumbnail' && row.output_url) {
        // Gallery cards use a small WebP preview; without one, fall through to the original.
        const thumb=await getImageThumbnail(getPool(),row);
        if (thumb) {
          res.writeHead(200,{'content-type':thumb.mimeType,'content-length':thumb.data.length,
            'cache-control':IMMUTABLE_MEDIA_CACHE,'x-content-type-options':'nosniff'});
          return res.end(thumb.data);
        }
      }
      if (row.output_url==='db:image') {
        const [outputs]=await getPool().execute('SELECT mime_type,image_data FROM generation_image_outputs WHERE generation_id=?',[row.id]);
        const output=outputs[0];
        if(!output)return sendJson(res,404,{ok:false,error:'Generated image is unavailable.'});
        const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[output.mime_type]||'png';
        res.writeHead(200,{'content-type':output.mime_type,'content-length':output.image_data.length,
          'content-disposition':'inline; filename="cmm-tools-image-'+row.id.slice(0,8)+'.'+extension+'"',
          'cache-control':IMMUTABLE_MEDIA_CACHE,'x-content-type-options':'nosniff'});
        return res.end(output.image_data);
      }
      return proxyMedia(req,res,row,'video');
    }

    if (req.method==='GET' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      const generations=await listUserGenerations(user.id,50);
      if(generations.some(row=>['queued','submitting','submitted','processing'].includes(row.status)))wakeGenerationWorker(req);
      return sendJson(res,200,{ok:true,generations});
    }

    if (req.method==='POST' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readGenerationRequest(req);
      const generation=await submitVideoGeneration(user,body,req);
      const [users]=await getPool().execute('SELECT * FROM users WHERE id=?',[user.id]);
      return sendJson(res,201,{ok:true,generation,user:userPayload(users[0])});
    }

    if (req.method==='POST' && routePath==='/api/upscales/quote') {
      requireDatabase();
      const user=await requireUser(req);
      const settings=await getProviderSettings();
      const access=await getUserProviderAccess(user.id);
      if (!access.fal || !settings.falEnabled || !settings.falApiKey) return sendJson(res,503,{ok:false,error:'The video upscaler is currently unavailable.'});
      const quote=await quoteForCustomer(user.id,await readJson(req),settings);
      return sendJson(res,200,{ok:true,cost:quote.cost});
    }

    if (req.method==='POST' && routePath==='/api/upscales') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readGenerationRequest(req);
      const video=Array.isArray(body.videos)?body.videos[0]:null;
      const sourceId=String(body.sourceGenerationId||'');
      if (video && sourceId) return sendJson(res,400,{ok:false,error:'Choose either a library video or an upload.'});
      const row=await submitUpscale(user,{resolution:body.resolution,source:video?{video}:{generationId:sourceId}},req);
      const [users]=await getPool().execute('SELECT * FROM users WHERE id=?',[user.id]);
      return sendJson(res,201,{ok:true,generation:serializeGeneration(row),user:userPayload(users[0])});
    }

    const genMatch=routePath.match(/^\/api\/generations\/([0-9a-f-]{36})$/i);
    if (req.method==='GET' && genMatch) {
      requireDatabase();
      const user=await requireUser(req);
      const row=await getUserGeneration(user.id,genMatch[1]);
      if (!row) return sendJson(res,404,{ok:false,error:'Generation not found.'});
      const referenceImages=await listUserGenerationReferenceImages(user.id,genMatch[1]);
      return sendJson(res,200,{ok:true,generation:{...serializeGeneration(row),reference_images:referenceImages}});
    }

    const genDeleteMatch=req.method==='DELETE'?genMatch:req.method==='POST'?routePath.match(/^\/api\/generations\/([0-9a-f-]{36})\/delete$/i):null;
    if (genDeleteMatch) {
      requireDatabase();
      const user=await requireUser(req);
      await deleteUserGeneration(user.id,genDeleteMatch[1]);
      return sendJson(res,200,{ok:true,deleted:true,id:genDeleteMatch[1]});
    }

    const referenceImageMatch=routePath.match(/^\/api\/generations\/([0-9a-f-]{36})\/reference-images\/(\d+)$/i);
    if (req.method==='GET' && referenceImageMatch) {
      requireDatabase();
      const user=await requireUser(req);
      const image=await getUserGenerationReferenceImage(user.id,referenceImageMatch[1],Number(referenceImageMatch[2]));
      if (!image) return sendJson(res,404,{ok:false,error:'Reference image not found.'});
      res.statusCode=200;
      res.setHeader('content-type',image.mime_type);
      res.setHeader('content-length',image.image_data.length);
      res.setHeader('cache-control','private, max-age=3600');
      res.setHeader('x-content-type-options','nosniff');
      return res.end(image.image_data);
    }

    const mediaMatch=routePath.match(/^\/api\/generations\/([0-9a-f-]{36})\/media$/i);
    if (req.method==='GET' && mediaMatch) {
      requireDatabase();
      const user=await requireUser(req);
      const row=await getUserGeneration(user.id,mediaMatch[1]);
      if (!row) return sendJson(res,404,{ok:false,error:'Generation not found.'});
      const type=url.searchParams.get('type')==='poster'?'poster':'video';
      if(type==='video'&&row.output_url==='db:video'){
        try{return await serveVideoOutput(getPool(),req,res,row.id);}
        catch(error){if(res.headersSent){res.destroy();return;}throw error;}
      }
      // vgenv's storage (Alibaba Cloud, Shanghai) is too slow to stream through
      // the host; until the worker has copied the video, the browser loads
      // vgenv's signed link directly.
      if(type==='video'&&row.provider==='vgenv'&&/^https:\/\/[a-z0-9.-]+\.aliyuncs\.com\//i.test(String(row.output_url||''))){
        res.writeHead(302,{location:row.output_url,'cache-control':'private, no-store','referrer-policy':'no-referrer'});
        return res.end();
      }
      return proxyMedia(req,res,row,type);
    }

    // Read-only support access (activity log and job details) with the support
    // key created in Admin → Activity. Emails are masked; nothing can be changed.
    if (routePath.startsWith('/ops/')) {
      if (req.method!=='GET') return sendJson(res,405,{ok:false,error:'Read only.'});
      if (!(await supportAuthorized(req,url))) return sendJson(res,401,{ok:false,error:'A valid support key is required.'});
      const db=getPool();
      const mask=entry=>({...entry,email:entry.email?maskEmail(entry.email):null});
      if (routePath==='/ops/activity') {
        return sendJson(res,200,{ok:true,entries:(await listActivity(db,activityFilters(url))).map(mask)});
      }
      if (routePath==='/ops/generations') {
        const status=url.searchParams.get('status'),provider=url.searchParams.get('provider');
        const where=[],args=[];
        if(status){where.push('status=?');args.push(status);}
        if(provider){where.push('provider=?');args.push(provider);}
        const n=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||30));
        const [rows]=await db.query('SELECT '+JOB_FIELDS+' FROM generations '+(where.length?'WHERE '+where.join(' AND '):'')+' ORDER BY created_at DESC LIMIT '+n,args);
        return sendJson(res,200,{ok:true,generations:rows.map(jobSnapshot)});
      }
      const opsJob=routePath.match(/^\/ops\/generations\/([0-9a-f-]{36})$/i);
      if (opsJob) {
        const [[row]]=await db.execute('SELECT '+JOB_FIELDS+' FROM generations WHERE id=?',[opsJob[1]]);
        if(!row)return sendJson(res,404,{ok:false,error:'Generation not found.'});
        return sendJson(res,200,{ok:true,generation:jobSnapshot(row),activity:(await listActivity(db,{generationId:row.id,limit:500})).map(mask)});
      }
      if (routePath==='/ops/health') {
        return sendJson(res,200,{ok:true,web:{...runtimeSnapshot(),...diagnostics.details()},boots:await listBoots(db).catch(()=>[]),settings:await getAdminProviderSettings()});
      }
      return sendJson(res,404,{ok:false,error:'Not found.'});
    }

    // Customer media for the admin page, by signed link (media tags cannot send the admin header).
    const adminMediaMatch=routePath.match(/^\/admin-media\/([0-9a-f-]{36})$/i);
    if (req.method==='GET' && adminMediaMatch) {
      requireDatabase();
      const id=adminMediaMatch[1],type=String(url.searchParams.get('type')||'');
      if(!['video','poster','image','thumbnail','audio'].includes(type)||!verifyAdminMedia(adminToken,id,type,url.searchParams.get('exp'),url.searchParams.get('sig')))
        return sendJson(res,403,{ok:false,error:'This link has expired. Refresh the admin page.'});
      const [rows]=await getPool().execute('SELECT * FROM generations WHERE id=? LIMIT 1',[id]);
      const row=rows[0];
      if(!row||!row.output_url)return sendJson(res,404,{ok:false,error:'Media not found.'});
      if(type==='image'||type==='thumbnail'){
        if(type==='thumbnail'){const thumb=await getImageThumbnail(getPool(),row);
          if(thumb){res.writeHead(200,{'content-type':thumb.mimeType,'content-length':thumb.data.length,'cache-control':'private, max-age=3600','x-content-type-options':'nosniff'});return res.end(thumb.data);}}
        if(row.output_url==='db:image'){
          const [outputs]=await getPool().execute('SELECT mime_type,image_data FROM generation_image_outputs WHERE generation_id=?',[row.id]);
          if(!outputs[0])return sendJson(res,404,{ok:false,error:'Generated image is unavailable.'});
          res.writeHead(200,{'content-type':outputs[0].mime_type,'content-length':outputs[0].image_data.length,'cache-control':'private, max-age=3600','x-content-type-options':'nosniff'});
          return res.end(outputs[0].image_data);
        }
        return proxyMedia(req,res,row,'video');
      }
      if(type==='video'&&row.output_url==='db:video'){
        try{return await serveVideoOutput(getPool(),req,res,row.id);}
        catch(error){if(res.headersSent){res.destroy();return;}throw error;}
      }
      if(type==='video'&&row.provider==='vgenv'&&/^https:\/\/[a-z0-9.-]+\.aliyuncs\.com\//i.test(String(row.output_url||''))){
        res.writeHead(302,{location:row.output_url,'cache-control':'private, no-store','referrer-policy':'no-referrer'});return res.end();
      }
      return proxyMedia(req,res,row,type==='poster'?'poster':'video');
    }

    if (routePath.startsWith('/admin/')) {
      if (!adminToken) return sendJson(res,503,{ok:false,error:'ADMIN_TOKEN is not configured in hPanel.'});
      if (!adminAuthorized(req)) return sendJson(res,401,{ok:false,error:'Unauthorized'});

      if (req.method==='POST' && routePath==='/admin/vibi/check') {
        requireDatabase();
        const settings=await getProviderSettings();
        if(!settings.vibiApiKey)return sendJson(res,400,{ok:false,error:'Vibi API key is not configured.'});
        const me=await vibiClient(settings).getMe();
        return sendJson(res,200,{ok:true,connected:true,creditBalance:Number(me.credit_balance||0),account:me.email||null});
      }

      if (req.method==='POST' && routePath==='/admin/prompt-enhancer/check') {
        requireDatabase();
        const settings=await getProviderSettings();
        if(!settings.promptEnhancerApiKey)return sendJson(res,400,{ok:false,error:'Prompt enhancer API key is not configured.'});
        const result=await new GeminiPromptEnhancer({apiKey:settings.promptEnhancerApiKey}).check();
        return sendJson(res,200,{ok:true,...result});
      }

      if(req.method==='POST'&&routePath==='/admin/vercel/check'){
        requireDatabase();const s=await getProviderSettings();
        let credits;
        try{credits=await new VercelGatewayClient({apiKey:s.vercelApiKey}).credits();}
        catch(error){return sendJson(res,502,{ok:false,error:error.message+(error.providerMessage?' Vercel says: '+error.providerMessage:'')});}
        return sendJson(res,200,{ok:true,balance:credits.balance,totalUsed:credits.totalUsed});
      }
      if(req.method==='POST'&&routePath==='/admin/vercel/sync'){
        requireDatabase();const s=await getProviderSettings();
        const live=await new VercelGatewayClient({apiKey:s.vercelApiKey}).catalog();
        const models=await syncProviderModels('vercel',mediaModels(live));
        return sendJson(res,200,{ok:true,models,total:models.length,ready:models.filter(m=>m.ready&&m.enabled&&m.available).length});
      }
      if(req.method==='POST'&&routePath==='/admin/fal/check'){
        requireDatabase();const s=await getProviderSettings();
        await new FalClient({apiKey:s.falApiKey}).verifyKey();
        return sendJson(res,200,{ok:true});
      }
      if(req.method==='POST'&&routePath==='/admin/api888/check'){
        requireDatabase();const s=await getProviderSettings();
        const catalog=await new Api888Client({apiKey:s.api888ApiKey}).models();
        return sendJson(res,200,{ok:true,accessibleModels:catalog.data.length});
      }
      if(req.method==='POST'&&routePath==='/admin/api888/sync'){
        requireDatabase();const s=await getProviderSettings();
        const catalog=await new Api888Client({apiKey:s.api888ApiKey}).models();
        const models=await syncProviderModels('api888',api888MediaModels(catalog));
        return sendJson(res,200,{ok:true,total:models.length,adapterSupported:models.filter(m=>m.adapterSupported).length,
          note:'Catalog imported. Models require a valid token, CNY conversion and an explicit provider enable switch before customer generation.'});
      }
      if(req.method==='POST'&&routePath==='/admin/argolink/check'){
        requireDatabase();const s=await getProviderSettings();
        const balance=await new ArgoLinkClient({apiKey:s.argoLinkApiKey}).balance();
        return sendJson(res,200,{ok:true,balance});
      }
      if(req.method==='POST'&&routePath==='/admin/argolink/sync'){
        requireDatabase();
        const live=await new ArgoLinkClient().catalog();
        const models=await syncProviderModels('argolink',argoMediaModels(live));
        return sendJson(res,200,{ok:true,models,total:models.length,ready:models.filter(m=>m.ready&&m.enabled&&m.available).length});
      }
      if(req.method==='POST'&&routePath==='/admin/sluice/check'){
        requireDatabase();const s=await getProviderSettings();
        return sendJson(res,200,{ok:true,balance:await new SluiceClient({apiKey:s.sluiceApiKey}).balance()});
      }
      if(req.method==='POST'&&routePath==='/admin/sluice/sync'){
        requireDatabase();
        const models=await syncProviderModels('sluice',sluiceMediaModels(await fetchSluiceCatalog()));
        return sendJson(res,200,{ok:true,models,total:models.length,ready:models.filter(m=>m.ready&&m.enabled&&m.available).length});
      }
      if(req.method==='POST'&&routePath==='/admin/higgsfield/check'){
        requireDatabase();const s=await getProviderSettings();
        await new HiggsfieldClient({apiKey:s.higgsfieldApiKey}).verifyKey();
        return sendJson(res,200,{ok:true});
      }
      if(req.method==='POST'&&routePath==='/admin/higgsfield/sync'){
        requireDatabase();
        const {models,tiers}=await syncHiggsfieldPrices();
        return sendJson(res,200,{ok:true,models,tiers,total:models.length,ready:models.filter(m=>m.ready&&m.enabled&&m.available).length});
      }
      const gatewayPriceMatch=routePath.match(/^\/admin\/vercel\/models\/(\d+)\/price$/);
      if(req.method==='POST'&&gatewayPriceMatch){
        requireDatabase();const body=await readJson(req);
        const model=await setGatewayPrice(Number(gatewayPriceMatch[1]),body.price);
        return sendJson(res,200,{ok:true,model});
      }

      if (req.method==='POST' && routePath==='/admin/smartaipi/check') {
        requireDatabase();
        const settings=await getProviderSettings();
        if(!settings.smartAipiApiKey)return sendJson(res,400,{ok:false,error:'SmartAIPI API key is not configured.'});
        const available=await new SmartAipiClient({baseUrl:settings.smartAipiBaseUrl,apiKey:settings.smartAipiApiKey}).listModels();
        return sendJson(res,200,{ok:true,connected:true,models:SMART_IMAGE_MODELS.map(m=>({id:m.apiModel,available:available.includes(m.apiModel)}))});
      }

      if (req.method==='GET' && routePath==='/admin/activity') {
        requireDatabase();
        return sendJson(res,200,{ok:true,entries:await listActivity(getPool(),activityFilters(url))});
      }
      if (req.method==='GET' && routePath==='/admin/model-names') {
        requireDatabase();
        return sendJson(res,200,{ok:true,models:await adminModelNameList()});
      }
      if (req.method==='POST' && routePath==='/admin/model-names') {
        requireDatabase();
        const body=await readJson(req);
        const changes=body.names&&typeof body.names==='object'&&!Array.isArray(body.names)?body.names:{};
        const hdChanges=body.hd&&typeof body.hd==='object'&&!Array.isArray(body.hd)?body.hd:{};
        for(const id of Object.keys(hdChanges))if(!isArgoModel(id)&&!isHiggsfieldModel(id))return sendJson(res,400,{ok:false,error:'HD enhance applies to ArgoLink and Higgsfield video models only.'});
        const names=await modelDisplayNames();
        for(const [key,value] of Object.entries(changes)){
          const [studio,...rest]=String(key).split(':');
          if(!MODEL_NAME_STUDIOS.includes(studio)||!/^[A-Za-z0-9._:\/-]{1,190}$/.test(rest.join(':')))return sendJson(res,400,{ok:false,error:'Unknown model '+key+'.'});
          const name=String(value??'').replace(/\s+/g,' ').trim();
          if(name.length>80)return sendJson(res,400,{ok:false,error:'Model names can be up to 80 characters.'});
          if(name)names[key]=name;else delete names[key];
        }
        await setSettingValue(MODEL_NAMES_SETTING,JSON.stringify(names));
        if(Object.keys(hdChanges).length){
          const hdOff=await argoHdOffModels();
          for(const [id,on] of Object.entries(hdChanges)){if(on===false)hdOff.add(id);else hdOff.delete(id);}
          await setSettingValue(ARGO_HD_OFF_SETTING,JSON.stringify([...hdOff]));
          logActivity({category:'admin',event:'argolink.hd_enhance',provider:'argolink',message:'HD enhance changed for '+Object.keys(hdChanges).length+' model(s)',details:hdChanges});
        }
        if(Object.keys(changes).length)logActivity({category:'admin',event:'model_names.saved',message:'Model names updated ('+Object.keys(changes).length+' change'+(Object.keys(changes).length===1?'':'s')+')',details:changes});
        return sendJson(res,200,{ok:true,models:await adminModelNameList()});
      }
      if (req.method==='GET' && routePath==='/admin/support-key') {
        requireDatabase();
        const hash=await getSettingValue(SUPPORT_KEY_SETTING,'');
        return sendJson(res,200,{ok:true,active:Boolean(hash),createdAt:hash?await getSettingValue(SUPPORT_KEY_SETTING+'_created',''):null});
      }
      if (req.method==='POST' && routePath==='/admin/support-key') {
        requireDatabase();
        const key=newSupportKey();
        await setSettingValue(SUPPORT_KEY_SETTING,hashSupportKey(key));
        await setSettingValue(SUPPORT_KEY_SETTING+'_created',new Date().toISOString());
        logActivity({level:'warn',category:'admin',event:'support_key.created',message:'Read-only support key created'});
        return sendJson(res,200,{ok:true,key});
      }
      if (req.method==='POST' && routePath==='/admin/support-key/revoke') {
        requireDatabase();
        await deleteSettingValue(SUPPORT_KEY_SETTING);await deleteSettingValue(SUPPORT_KEY_SETTING+'_created');
        logActivity({level:'warn',category:'admin',event:'support_key.revoked',message:'Read-only support key revoked'});
        return sendJson(res,200,{ok:true,active:false});
      }

      if (req.method==='GET' && routePath==='/admin/provider-settings') {
        requireDatabase();
        return sendJson(res,200,{ok:true,settings:await getAdminProviderSettings()});
      }

      if ((req.method==='POST' || req.method==='PUT') && routePath==='/admin/provider-settings') {
        requireDatabase();
        const body=await readJson(req);
        const settings=await updateProviderSettings(body);
        // Keys and passwords are masked by the activity log.
        logActivity({category:'admin',event:'settings.saved',message:'Provider settings saved',details:{changes:body}});
        // A new Higgsfield key: read Wan 3.0's prices right away, so the model appears.
        let higgsfieldSync=null;
        if(String(body.higgsfieldApiKey||'').trim()){
          try{const r=await syncHiggsfieldPrices();higgsfieldSync={ok:true,ready:r.models.some(m=>m.ready)};}
          catch(error){higgsfieldSync={ok:false,error:error.message};}
        }
        return sendJson(res,200,{ok:true,settings,higgsfieldSync});
      }

      if (req.method==='GET' && routePath==='/admin/provider-models') {
        requireDatabase();
        const provider=String(url.searchParams.get('provider')||'vercel');
        if (!['vercel','argolink','higgsfield','sluice','api888'].includes(provider)) return sendJson(res,400,{ok:false,error:'Unsupported provider.'});
        const models=await listProviderModels(provider);
        return sendJson(res,200,{ok:true,models});
      }

      const providerModelMatch=routePath.match(/^\/admin\/provider-models\/(\d+)$/);
      if (req.method==='POST' && providerModelMatch) {
        requireDatabase();
        const body=await readJson(req);
        const provider=String(body.provider||'vercel');
        if(!['vercel','argolink','higgsfield','sluice'].includes(provider))return sendJson(res,400,{ok:false,error:'Unsupported provider.'});
        const model=await setProviderModelEnabled(provider,Number(providerModelMatch[1]),body.enabled===true);
        return sendJson(res,200,{ok:true,model});
      }

      if (req.method==='GET' && routePath==='/admin/provider-usage') {
        requireDatabase();
        const providers=await providerUsage(getPool(),await getProviderSettings(),await getAdminProviderSettings());
        return sendJson(res,200,{ok:true,providers,checkedAt:new Date().toISOString()});
      }

      if (req.method==='GET' && routePath==='/admin/diagnostics') {
        let boots=[];
        if(dbConfigured())boots=await listBoots(getPool()).catch(error=>[{error:error.message}]);
        return sendJson(res,200,{ok:true,web:{...runtimeSnapshot(),...diagnostics.details()},boots});
      }

      if (req.method==='GET' && routePath==='/admin/stats') {
        requireDatabase();
        const db=getPool();
        const [[userStats]] = await db.query(
          `SELECT COUNT(*) AS users,
                  COALESCE(SUM(credits),0) AS user_credits,
                  SUM(status='active') AS active_users
           FROM users`
        );
        const [[genStats]] = await db.query(
          `SELECT COUNT(*) AS generations,
                  SUM(status='completed') AS completed,
                  SUM(status IN ('queued','submitting','submitted','processing')) AS active,
                  SUM(status IN ('failed','submit_error')) AS failed,
                  COALESCE(SUM(credits_cost),0) AS credits_charged
           FROM generations`
        );
        return sendJson(res,200,{ok:true,stats:{
          users:Number(userStats.users||0),
          activeUsers:Number(userStats.active_users||0),
          userCredits:Number(userStats.user_credits||0),
          generations:Number(genStats.generations||0),
          completed:Number(genStats.completed||0),
          active:Number(genStats.active||0),
          failed:Number(genStats.failed||0),
          creditsCharged:Number(genStats.credits_charged||0),
        }});
      }

      if (req.method==='GET' && routePath==='/admin/config') {
        const providerSettings=await getAdminProviderSettings();
        return sendJson(res,200,{ok:true,
          pricing:publicPricing(),
          aspectRatios:ASPECT_RATIOS,
          imagePricing:publicImagePricing(),
          imageAspectRatios:IMAGE_ASPECT_RATIOS,
          signupsEnabled:allowSignups,
          workerEnabled:/^(1|true|yes|on)$/i.test(String(process.env.WORKER_ENABLED||'true')),
          providers:{
            vgenv:providerSettings.vgenv.configured,
            vibi:providerSettings.vibi.configured,
            smartaipi:providerSettings.smartaipi.configured,
            vercel:providerSettings.vercel.configured,
            argolink:providerSettings.argolink.configured,
            fal:providerSettings.fal.configured,
          },
          providerEnabled:{
            vgenv:providerSettings.vgenv.enabled,
            vibi:providerSettings.vibi.enabled,
            smartaipi:providerSettings.smartaipi.enabled,
            vercel:providerSettings.vercel.enabled,
            argolink:providerSettings.argolink.enabled,
            higgsfield:providerSettings.higgsfield.enabled,
            sluice:providerSettings.sluice.enabled,
            fal:providerSettings.fal.enabled,
          },
          providerActive:{
            vgenv:providerSettings.vgenv.active,
            vibi:providerSettings.vibi.active,
            smartaipi:providerSettings.smartaipi.active,
            vercel:providerSettings.vercel.active,
            argolink:providerSettings.argolink.active,
            higgsfield:providerSettings.higgsfield.active,
            sluice:providerSettings.sluice.active,
            fal:providerSettings.fal.active,
          },
          vgenvMaxInflight:providerSettings.vgenv.maxInflight,
          vibiMaxInflight:providerSettings.vibi.maxInflight,
          smartAipiMaxInflight:providerSettings.smartaipi.maxInflight,
          vercelMaxInflight:providerSettings.vercel.maxInflight,
          argoLinkMaxInflight:providerSettings.argolink.maxInflight,
          higgsfieldMaxInflight:providerSettings.higgsfield.maxInflight,
          sluiceMaxInflight:providerSettings.sluice.maxInflight,
          falMaxInflight:providerSettings.fal.maxInflight,
          customerCreditMultiplier:creditMultiplier(),
          plans:publicPlans(),
          generationEnabled:providerSettings.allowProviderCharges,
        });
      }

      if (req.method==='GET' && routePath==='/admin/users') {
        requireDatabase();
        const db=getPool();
        const q=String(url.searchParams.get('q')||'').trim();
        const status=String(url.searchParams.get('status')||'').trim();
        const clauses=[]; const params=[];
        if (q) {
          clauses.push('(email LIKE ? OR CAST(id AS CHAR)=?)');
          params.push('%'+q+'%',q);
        }
        if (status==='active'||status==='disabled') { clauses.push('status=?'); params.push(status); }
        const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
        const [rows]=await db.query(
          'SELECT id,email,credits,plan_code,role,status,created_at,updated_at FROM users'+where+' ORDER BY created_at DESC LIMIT 200',
          params,
        );
        const accessRows=await db.query(
          'SELECT user_id,provider,enabled FROM user_provider_access WHERE user_id IN ('+
          (rows.length?rows.map(()=>'?').join(','):'NULL')+')',
          rows.map(row=>Number(row.id))
        );
        const accessByUser=new Map();
        for(const row of accessRows[0]||[]){
          const id=Number(row.user_id);
          if(!accessByUser.has(id))accessByUser.set(id,defaultCustomerProviderAccess());
          accessByUser.get(id)[String(row.provider)]=Boolean(row.enabled);
        }
        return sendJson(res,200,{ok:true,users:rows.map(row=>({
          ...userPayload(row),
          provider_access:accessByUser.get(Number(row.id))||defaultCustomerProviderAccess(),
        }))});
      }

      if (req.method==='GET' && routePath==='/admin/plans') return sendJson(res,200,{ok:true,plans:adminPlanOptions()});

      const userDetailMatch=routePath.match(/^\/admin\/users\/(\d+)$/);
      if (req.method==='GET' && userDetailMatch) {
        requireDatabase();
        const db=getPool(),userId=Number(userDetailMatch[1]);
        const [users]=await db.execute('SELECT '+USER_FIELDS+' FROM users WHERE id=? LIMIT 1',[userId]);
        if(!users[0])return sendJson(res,404,{ok:false,error:'User not found.'});
        const [counts]=await db.execute("SELECT COALESCE(media_type,'video') AS media_type,status,COUNT(*) AS total,COALESCE(SUM(CASE WHEN refunded_at IS NULL THEN credits_cost ELSE 0 END),0) AS credits FROM generations WHERE user_id=? GROUP BY COALESCE(media_type,'video'),status",[userId]);
        const [ledger]=await db.execute('SELECT id,generation_id,amount,type,note,created_at FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 50',[userId]);
        const [requests]=await db.execute('SELECT id,plan_code,price_pkr,credits,status,created_at FROM plan_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 10',[userId]);
        const summary={total:0,completed:0,failed:0,active:0,creditsSpent:0,byType:{}};
        for(const r of counts){const n=Number(r.total);summary.total+=n;summary.byType[r.media_type]=(summary.byType[r.media_type]||0)+n;
          if(r.status==='completed'){summary.completed+=n;summary.creditsSpent+=Number(r.credits);}
          else if(['failed','submit_error'].includes(r.status))summary.failed+=n;else summary.active+=n;}
        summary.creditsSpent=roundCredits(summary.creditsSpent);
        return sendJson(res,200,{ok:true,user:{...userPayload(users[0]),provider_access:await getUserProviderAccess(userId)},summary,
          ledger:ledger.map(r=>({...r,amount:Number(r.amount)})),planRequests:requests,plans:adminPlanOptions()});
      }

      const userPlanMatch=routePath.match(/^\/admin\/users\/(\d+)\/plan$/);
      if (req.method==='POST' && userPlanMatch) {
        requireDatabase();
        const body=await readJson(req);
        const result=await setUserPlan(getPool(),Number(userPlanMatch[1]),body.plan,{grantCredits:body.grantCredits===true,note:body.note});
        logActivity({category:'admin',event:'user.plan_changed',userId:Number(userPlanMatch[1]),message:'Plan '+(result.previousPlan||'none')+' → '+(result.user.plan_code||'none')+(result.creditsGranted?' with '+result.creditsGranted+' credits':'')});
        return sendJson(res,200,{ok:true,user:userPayload(result.user),creditsGranted:result.creditsGranted});
      }

      const userProviderMatch=routePath.match(/^\/admin\/users\/(\d+)\/providers$/);
      if ((req.method==='POST'||req.method==='PUT') && userProviderMatch) {
        requireDatabase();
        const body=await readJson(req);
        const access=await setUserProviderAccess(Number(userProviderMatch[1]),body.providers||body);
        return sendJson(res,200,{ok:true,provider_access:access});
      }

      const userPatchMatch=routePath.match(/^\/admin\/users\/(\d+)$/);
      // POST is the browser method; PATCH stays for older clients.
      if ((req.method==='PATCH'||req.method==='POST') && userPatchMatch) {
        requireDatabase();
        const body=await readJson(req);
        const db=getPool();
        const userId=Number(userPatchMatch[1]);
        const [rows]=await db.execute('SELECT * FROM users WHERE id=? LIMIT 1',[userId]);
        if (!rows[0]) return sendJson(res,404,{ok:false,error:'User not found.'});

        const updates=[]; const params=[];
        if (body.status!==undefined) {
          if (!['active','disabled'].includes(String(body.status))) return sendJson(res,400,{ok:false,error:'Invalid user status.'});
          updates.push('status=?'); params.push(String(body.status));
        }
        if (body.role!==undefined) {
          if (!['user','admin'].includes(String(body.role))) return sendJson(res,400,{ok:false,error:'Invalid user role.'});
          updates.push('role=?'); params.push(String(body.role));
        }
        if (!updates.length) return sendJson(res,400,{ok:false,error:'No user fields supplied.'});
        params.push(userId);
        await db.execute('UPDATE users SET '+updates.join(', ')+', updated_at=UTC_TIMESTAMP() WHERE id=?',params);
        const [updated]=await db.execute('SELECT id,email,credits,plan_code,role,status,created_at,updated_at FROM users WHERE id=?',[userId]);
        return sendJson(res,200,{ok:true,user:userPayload(updated[0])});
      }

      if (req.method==='POST' && routePath==='/admin/users/credits') {
        requireDatabase();
        const body=await readJson(req);
        const identifier=String(body.identifier||'').trim();
        const amount=roundCredits(Number(body.amount));
        if (!identifier) return sendJson(res,400,{ok:false,error:'User ID or email is required.'});
        if (!Number.isFinite(amount)||amount===0) return sendJson(res,400,{ok:false,error:'amount must be a non-zero number'});

        const db=getPool(); const conn=await db.getConnection();
        try {
          await conn.beginTransaction();
          const isId=/^\d+$/.test(identifier);
          const [users]=isId
            ? await conn.execute('SELECT * FROM users WHERE id=? FOR UPDATE',[Number(identifier)])
            : await conn.execute('SELECT * FROM users WHERE email=? FOR UPDATE',[normalizeEmail(identifier)]);
          const user=users[0];
          if (!user) { await conn.rollback(); return sendJson(res,404,{ok:false,error:'User not found.'}); }
          if (Number(user.credits)+amount<0) { await conn.rollback(); return sendJson(res,400,{ok:false,error:'Credit adjustment would make balance negative.'}); }
          await conn.execute('UPDATE users SET credits=credits+? WHERE id=?',[amount,user.id]);
          await conn.execute(
            "INSERT INTO credit_transactions (user_id,amount,type,note) VALUES (?,?,'admin_adjustment',?)",
            [user.id,amount,String(body.note||'Admin credit adjustment').slice(0,255)],
          );
          await conn.commit();
          const [updated]=await db.execute('SELECT id,email,credits,plan_code,role,status,created_at FROM users WHERE id=?',[user.id]);
          return sendJson(res,200,{ok:true,user:userPayload(updated[0])});
        } catch(error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
      }

      const creditMatch=routePath.match(/^\/admin\/users\/(\d+)\/credits$/);
      if (req.method==='POST' && creditMatch) {
        requireDatabase();
        const body=await readJson(req);
        const result=await changeUserCredits(getPool(),Number(creditMatch[1]),{amount:body.amount,mode:body.mode==='set'?'set':'add',note:body.note});
        logActivity({category:'admin',event:'user.credits_changed',userId:Number(creditMatch[1]),message:'Credits '+(result.delta>=0?'+':'')+result.delta+' → balance '+Number(result.user.credits)});
        return sendJson(res,200,{ok:true,user:userPayload(result.user),delta:result.delta});
      }

      if (req.method==='GET' && routePath==='/admin/plan-requests') {
        requireDatabase();
        const status=String(url.searchParams.get('status')||'').trim();
        return sendJson(res,200,{ok:true,requests:await listPlanRequests(status)});
      }

      const planRequestActionMatch=routePath.match(/^\/admin\/plan-requests\/(\d+)$/);
      if (req.method==='POST' && planRequestActionMatch) {
        requireDatabase();
        const body=await readJson(req);
        const result=await decidePlanRequest(Number(planRequestActionMatch[1]),body.action);
        return sendJson(res,200,{ok:true,result});
      }

      if (req.method==='GET' && routePath==='/admin/credits') {
        requireDatabase();
        const db=getPool();
        const userId=Number(url.searchParams.get('user_id')||0);
        const params=[]; let where='';
        if (userId>0) { where=' WHERE c.user_id=?'; params.push(userId); }
        const [rows]=await db.query(
          `SELECT c.id,c.user_id,u.email,c.generation_id,c.amount,c.type,c.note,c.created_at
           FROM credit_transactions c JOIN users u ON u.id=c.user_id`+where+`
           ORDER BY c.created_at DESC LIMIT 200`,
          params,
        );
        return sendJson(res,200,{ok:true,transactions:rows});
      }

      if (req.method==='GET' && routePath==='/admin/generations') {
        requireDatabase();
        const db=getPool();
        const status=String(url.searchParams.get('status')||'').trim();
        const q=String(url.searchParams.get('q')||'').trim();
        const clauses=[]; const params=[];
        if (status) { clauses.push('g.status=?'); params.push(status); }
        if (q) { clauses.push('(u.email LIKE ? OR g.id=? OR CAST(g.provider_job_id AS CHAR)=? OR g.prompt LIKE ?)'); params.push('%'+q+'%',q,q,'%'+q+'%'); }
        const filterUser=Number(url.searchParams.get('user_id')||0);
        if (filterUser>0) { clauses.push('g.user_id=?'); params.push(filterUser); }
        const mediaType=String(url.searchParams.get('media_type')||'');
        if (['video','image','audio'].includes(mediaType)) { clauses.push("COALESCE(g.media_type,'video')=?"); params.push(mediaType); }
        const limit=Math.min(Math.max(Number(url.searchParams.get('limit'))||200,1),200);
        const offset=Math.max(Number(url.searchParams.get('offset'))||0,0);
        const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
        const [rows]=await db.query(
          `SELECT
             g.id,g.user_id,g.provider,g.media_type,g.provider_job_id,g.mode,g.model,g.duration,g.resolution,g.aspect_ratio,
             g.prompt,g.status,g.credits_cost,g.provider_cost,g.provider_cost_unit,g.output_url,g.poster_url,
             g.error_message,g.submitted_at,g.started_at,g.completed_at,g.refunded_at,g.created_at,g.updated_at,g.generation_options,
             u.email
           FROM generations g
           JOIN users u ON u.id=g.user_id`+where+`
           ORDER BY g.created_at DESC LIMIT `+(limit+1)+` OFFSET `+offset,
          params,
        );
        const hasMore=rows.length>limit;if(hasMore)rows.length=limit;
        return sendJson(res,200,{ok:true,hasMore,generations:rows.map(row=>({
          ...serializeGeneration(row),
          ...adminMediaLinks(adminToken,row),
          user_id:Number(row.user_id),
          // Admin sees the source's own message (customers get it without vendor names).
          error_message:row.error_message,
          user_email:row.email,
          provider:row.provider,
          media_type:row.media_type || 'video',
          provider_job_id:row.provider_job_id,
        }))});
      }

      return sendJson(res,404,{ok:false,error:'Admin route not found.'});
    }

    return sendJson(res,404,{ok:false,error:'Not found'});
  } catch(error) {
    console.error(error);
    res.activityError=error;
    return sendJson(res,error.statusCode||500,safeError(error));
  }
});

server.requestTimeout=Math.max(30000,Number(process.env.HTTP_REQUEST_TIMEOUT_MS||120000));
server.headersTimeout=Math.max(15000,Number(process.env.HTTP_HEADERS_TIMEOUT_MS||65000));
server.keepAliveTimeout=Math.max(5000,Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS||10000));
server.on('clientError',(error,socket)=>{
  console.error('[runtime] HTTP client error',error?.code||'',error?.message||error);
  if(socket?.writable)socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
// A server that could not open its port serves nothing; exit so the host
// starts a fresh process instead of keeping this one alive.
server.on('error',(error)=>{console.error('HTTP server failed:',error);process.exitCode=1;if(!server.listening)setTimeout(()=>process.exit(1),250).unref();});


let workerChild=null;
let workerRestartTimer=null;
let shuttingDown=false;

function startWorkerChild(){
  if (!/^(1|true|yes|on)$/i.test(String(process.env.WORKER_ENABLED||'true'))) {
    console.log('[worker-child] disabled by WORKER_ENABLED');
    return;
  }
  if (workerChild || shuttingDown) return;

  const workerPath=path.join(__dirname,'worker.js');
  console.log('[worker-child] starting',workerPath);

  workerChild=fork(workerPath,[],{
    env:{...process.env,MEHROZ_WORKER_CHILD:'1'},
    stdio:['ignore','inherit','inherit','ipc'],
  });

  workerChild.on('message',msg=>{
    if(msg && msg.type==='ready') console.log('[worker-child] ready pid='+workerChild.pid);
  });

  workerChild.on('error',error=>{
    console.error('[worker-child] process error',error);
  });

  workerChild.on('exit',(code,signal)=>{
    console.error('[worker-child] exited',{code,signal});
    workerChild=null;
    if(shuttingDown) return;
    clearTimeout(workerRestartTimer);
    workerRestartTimer=setTimeout(startWorkerChild,3000);
    if(workerRestartTimer.unref) workerRestartTimer.unref();
  });
}

function stopWorkerChild(){
  shuttingDown=true;
  clearTimeout(workerRestartTimer);
  if(workerChild){
    try{workerChild.kill('SIGTERM')}catch{}
  }
}

// Listening for a signal stops Node from exiting on it, so shutdown is done
// here: stop the worker child, finish requests in progress, then exit.
const SHUTDOWN_GRACE_MS=Math.max(0,Number(process.env.WEB_SHUTDOWN_GRACE_MS||10000));
function shutdown(signal){
  if(shuttingDown)return;
  console.warn('[runtime] shutting down on',signal);
  stopWorkerChild();
  server.close(()=>process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(()=>process.exit(0),SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

function bootstrap() {
  // Start HTTP immediately so Hostinger can route traffic even if MySQL is
  // temporarily unavailable or misconfigured.
  server.listen(port,host,()=>console.log('mehroz-ai milestone 5 listening on '+host+':'+port));

  if (!dbConfigured()) {
    console.warn('MySQL not configured yet. Public UI will load, but account/generation APIs are unavailable.');
    return;
  }

  initDb()
    .then(async () => {
      console.log('MySQL schema ready.');
      await recordBoot(getPool(),'web').catch(error=>console.error('Boot record failed:',error.message));
      logActivity({category:'system',event:'web.started',message:'Web app started (pid '+process.pid+')'});
      const migrated=await migrateLegacyProviderEnvSettings();
      if (migrated) console.log('Legacy provider settings migrated into Admin-managed storage.');
      await enableVoiceForCustomersOnce().catch(error=>console.error('Voice access default failed:',error.message));
      await enableHiggsfieldForCustomersOnce().catch(error=>console.error('Higgsfield access for all failed:',error.message));
      await ensureGatewayCatalog().catch(error=>console.error('Gateway catalog initialization failed:',error.message));
      await ensureArgoCatalog().catch(error=>console.error('ArgoLink catalog initialization failed:',error.message));
      await ensureApi888Catalog().catch(error=>console.error('888API catalog initialization failed:',error.message));
      await ensureHiggsfieldCatalog().catch(error=>console.error('Higgsfield catalog initialization failed:',error.message));
      await ensureSluiceCatalog(()=>fetchSluiceCatalog()).catch(error=>console.error('Sluice catalog initialization failed:',error.message));
      startWorkerChild();
      wakeWhileJobsRun();
      connector.prune().catch(()=>{});
      setInterval(()=>connector.prune().catch(()=>{}),6*3600*1000).unref();
    })
    .catch((error) => {
      console.error('MySQL initialization failed:',error);
      console.error('Web server remains online; inspect /health for database diagnostics.');
    });
}

bootstrap();
module.exports=server;


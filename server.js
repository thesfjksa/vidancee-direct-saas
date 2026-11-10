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
      if(row||await hasActiveRenderTest(getPool()))wakeWorker();
    } catch {}
  },60000).unref();
}
const { dbConfigured, getPool, initDb, dbHealth } = require('./src/db.js');
const {
  normalizeEmail, validateEmail, hashPassword, verifyPassword,
  createSession, destroySession, userFromRequest,
} = require('./src/auth.js');
const { publicPricing, getCost, ASPECT_RATIOS, H3_MODEL_IDS, isH3Model } = require('./src/pricing.js');
const { H3_REFS, H3_AUDIO_CAPABILITY, H3_VIDEO_CAPABILITY, validateH3Media } = require('./src/h3_references.js');
const { trimReferenceVideos, validateAividVideoReferences } = require('./src/reference_trim.js');
const { presignUpload, collectDirectUploads, removeDirectUploads } = require('./src/direct_uploads.js');
const { isFalImageModel, verifyFalCatalogKey, PROVIDER: FAL_IMAGE_PROVIDER } = require('./src/fal_images.js');
const { publicImagePricing, IMAGE_ASPECT_RATIOS } = require('./src/image_pricing.js');
const { creditMultiplier, roundCredits, sourceToCustomerCredits, BOOSTED_PRICE_RATE, customerRate, priceRate, applyPriceRate, scalePrices } = require('./src/billing.js');
const {
  publicPlans,
  getPlanStatus,
  createPlanRequest,
  listPlanRequests,
  decidePlanRequest,
  SUPPORT_WHATSAPP,
  whatsappUrl,
} = require('./src/plans.js');
const { adminPlanOptions, setUserPlan, changeUserCredits, verifyAdminMedia, adminMediaLinks, adminGenerationInputs, INPUT_TYPE, USER_FIELDS } = require('./src/admin_users.js');
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
  saveGoogleDriveOAuthCredentials,
  deleteSettingValue,
} = require('./src/settings.js');
const { verifyAssetSignature, verifyOutputSignature } = require('./src/provider/assets.js');
const { createUpscaleJob, publicUpscalerConfig, quoteForCustomer } = require('./src/upscaler.js');
const { VercelGatewayClient } = require('./src/provider/vercel.js');
const { ArgoLinkClient } = require('./src/provider/argolink.js');
const { Api888Client } = require('./src/provider/api888.js');
const { recoverApi888Video } = require('./src/api888_recovery.js');
const { api888MediaModels, isApi888Model, quoteApi888 } = require('./src/api888_models.js');
const { loadApi888Health, isApi888Available, isApi888PublicAvailable } = require('./src/api888_health.js');
const { auditApi888Import } = require('./src/api888_audit.js');
const { isArgoModel, argoMediaModels } = require('./src/argolink_models.js');
const { comparePrices } = require('./src/compare_prices.js');
const { perSecondPrices } = require('./src/per_second_prices.js');
const { isHiggsfieldModel, higgsfieldMediaModels, fetchHiggsfieldTiers, validateHiggsfieldReferences } = require('./src/higgsfield_models.js');
const { HiggsfieldClient } = require('./src/provider/higgsfield.js');
const { isSluiceModel, sluiceMediaModels, fetchSluiceCatalog } = require('./src/sluice_models.js');
const { isLongAiModel, longAiMediaModel } = require('./src/longai_models.js');
const { isWxksaiModel, wxksaiMediaModels, unverifiedDopeCandidateVisible } = require('./src/wxksai_models.js');
const { createDopePerformance } = require('./src/dope_performance.js');
const getDopePerformance = createDopePerformance();
const { storedModelId, customerModelLabel, customerProviderAccess: publicDopeAccess } = require('./src/dope_brand.js');
const { isRetiredModel } = require('./src/retired_models.js');
const { WxksaiClient } = require('./src/provider/wxksai.js');
const { LongAiClient } = require('./src/provider/longai.js');
const { loadVideoMarketplace, checkVideoModel, signVideoKeyCheck, verifyVideoKeyCheck } = require('./src/longai_video_tests.js');
const { validateRenderRequest, findRenderTest, listRenderTests, hasActiveRenderTest, queueRenderTest } = require('./src/longai_render_tests.js');
const { SluiceClient } = require('./src/provider/sluice.js');
const { isVidanceeModel, vidanceeMediaModels, vidanceeCreditsForDuration } = require('./src/vidancee_models.js');
const { VidanceeClient } = require('./src/provider/vidancee.js');
const { applyWanCap } = require('./src/wan_pricing.js');
const { submissionFailover, isOutOfCredits } = require('./src/image_failover.js');
const { argoVideoView, wanVideoView, quoteArgoVideo, falReady } = require('./src/argo_hd.js');
const { isGatewayModel, mediaModels, quoteGateway, validateReferences, mp4Seconds } = require('./src/vercel_models.js');
const { serveVideoOutput } = require('./src/video_outputs.js');
const { sendVideoBackup } = require('./src/video_backup.js');
const { configuredStorage, keyFromMarker, redirectToObject, storageConfiguration, saveStorageSettings, SETTINGS: STORAGE_SETTINGS } = require('./src/object_storage.js');
const {GoogleDriveStore,configuredDrive,driveConfiguration,driveIdFromMarker,authUrl,exchangeCode,oauthConfig,validateOAuthClient,OAUTH_ID_SETTING,OAUTH_SECRET_SETTING}=require('./src/google_drive.js');
const {videoMigrationStats}=require('./src/google_drive_migration.js');
const { getImageThumbnail } = require('./src/image_thumbnails.js');
const { attachReusedImageReferences } = require('./src/reference_reuse.js');
const { createConnector } = require('./src/connector.js');
const {
  publicProviderCatalog,
  addMissingImageModels,
  listProviderModels,
  getProviderModelByPublicId,
  setProviderModelEnabled,
  syncProviderModels, setGatewayPrice, ensureGatewayCatalog, ensureArgoCatalog, ensureHiggsfieldCatalog, ensureSluiceCatalog, ensureVidanceeCatalog, ensureApi888Catalog,
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
// Videos play from, and reference files upload to, the cloud storage bucket
// through short-lived links, so the page must allow its origin for media and
// connections. Without it the browser blocked playback and direct uploads.
let storageCspOrigin='';
function refreshStorageCspOrigin(){
  storageConfiguration().then(cfg=>{
    try{storageCspOrigin=cfg.configured?new URL(cfg.endpoint).origin:'';}catch{storageCspOrigin='';}
  }).catch(()=>{});
}
function pageCsp(){
  const storage=['https://*.r2.cloudflarestorage.com',storageCspOrigin].filter(Boolean).join(' ');
  return "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob: "+storage+
    "; media-src 'self' blob: https://*.aliyuncs.com "+storage+"; connect-src 'self' "+storage;
}
function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'content-security-policy': pageCsp(),
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
  if(!['/','/app','/developers','/developers/docs','/pricing','/compare','/admin-console'].includes(routePath))return null;
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
const CUSTOMER_PROVIDER_KEYS=['aivid','api888','sluice','vidancee','longai','wxksai','vgenv','vibi','smartaipi','vercel','argolink','higgsfield','fal'];
// Customer video and image sources are available by default. Admin per-user
// overrides can still turn an individual source off; global provider and
// per-model enable/availability checks remain separate and authoritative.
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
// Owner request (25 Oct 2026): MiniMax H3 comes from vgenv for everyone; the
// 888API MiniMax models were removed. Customers who had vgenv off get it once.
const VGENV_ALL_ON_SETTING='vgenv_access_all_on_at';
async function enableVgenvForCustomersOnce(){
  if(await getSettingValue(VGENV_ALL_ON_SETTING,''))return 0;
  const [result]=await getPool().execute("DELETE FROM user_provider_access WHERE provider='vgenv' AND enabled=0");
  await setSettingValue(VGENV_ALL_ON_SETTING,new Date().toISOString());
  const count=Number(result?.affectedRows||0);
  logActivity({category:'admin',event:'vgenv_access.all_on',message:'vgenv (MiniMax H3) turned on for every customer; '+count+' had it off'});
  return count;
}
// Owner request (25 Oct 2026): 888API is on for every customer. It used to be
// opt-in, so switches left off are cleared once; the admin can turn it off
// again per customer.
const API888_ALL_ON_SETTING='api888_access_all_on_at';
async function enableApi888ForCustomersOnce(){
  if(await getSettingValue(API888_ALL_ON_SETTING,''))return 0;
  const [result]=await getPool().execute("DELETE FROM user_provider_access WHERE provider='api888' AND enabled=0");
  await setSettingValue(API888_ALL_ON_SETTING,new Date().toISOString());
  const count=Number(result?.affectedRows||0);
  logActivity({category:'admin',event:'api888_access.all_on',message:'888API turned on for every customer; '+count+' had it off'});
  return count;
}
// Owner request (9 Nov 2026): Dope models are available in Sources for all
// existing and future customers. Prior Dope opt-out rows came from a
// customer-default-off policy; clear them exactly once so existing customers
// also inherit the new on-by-default setting. Preserve later Admin opt-outs.
const DOPE_ALL_ON_SETTING='dope_access_all_on_20261109_at';
async function enableDopeForCustomersOnce(){
  if(await getSettingValue(DOPE_ALL_ON_SETTING,''))return 0;
  const [result]=await getPool().execute("DELETE FROM user_provider_access WHERE provider='wxksai' AND enabled=0");
  await setSettingValue(DOPE_ALL_ON_SETTING,new Date().toISOString());
  const count=Number(result?.affectedRows||0);
  logActivity({category:'admin',event:'dope_access.all_on',
    message:'Dope source available to every customer; '+count+' old off-setting(s) reset'});
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
// models: Base, Cinematic and Origin. Their prices are fixed per duration and
// resolution. (Seedance Lite on
// Vidancee/Vidancee was removed on 20 October 2026.)
const DIRECT_VIDEO_MODELS=H3_MODEL_IDS;
function directVideoSourceActive(id,access,providerSettings){
  return isH3Model(id)&&Boolean(access.vgenv&&providerSettings.vgenv.active);
}
function directVideoModels(access,providerSettings){
  return publicPricing().filter(m=>DIRECT_VIDEO_MODELS.includes(m.id)&&m.durations.length&&directVideoSourceActive(m.id,access,providerSettings)).map(m=>({
    ...m,
    label:m.label+' · up to '+Math.max(...m.durations.map(d=>d.seconds))+' s',
    defaultDuration:m.durations[0].seconds,
    aspectRatios:ASPECT_RATIOS,defaultAspectRatio:'9:16',
    capabilities:{image:{supported:true,max:6,min:0,roles:['image_references'],requiredRoles:[]},
      video:isH3Model(m.id)?H3_VIDEO_CAPABILITY:{supported:false,max:0},
      audio:isH3Model(m.id)?H3_AUDIO_CAPABILITY:{supported:false,max:0}},
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
  return models.map(m=>{
    // Prior admin overrides used the historical provider-prefixed public ID.
    // Preserve them, but never leak that old source name in the customer label.
    const override=names[studio+':'+m.id] || (m.id.startsWith('dope_') ? names[studio+':'+storedModelId(m.id)] : '');
    return typeof override==='string'&&override.trim() ? {...m,label:m.id.startsWith('dope_') ? customerModelLabel(override.trim()) : override.trim()} : m;
  });
}

async function customerMediaCatalog(access,adminSettings=null,{names=null}={}){
  const catalog=await sourceMediaCatalog(access,adminSettings);
  const custom=names||await modelDisplayNames().catch(()=>({}));
  return {...catalog,
    video:applyModelNames('video',catalog.video,custom).filter(model=>!isRetiredModel(model)),
    image:applyModelNames('image',catalog.image,custom).filter(model=>!isRetiredModel(model)),
  };
}

async function sourceMediaCatalog(access,adminSettings=null){
  const providerSettings=adminSettings||await getAdminProviderSettings();
  let video=[],image=[],falReferenceModels=[];
  const safeCatalog=async(source,load)=>{
    try{return await load();}
    catch(error){
      logActivity({level:'error',category:'system',event:'catalog.source_failed',provider:source,
        message:'A provider catalog could not be loaded',details:{error:String(error?.message||'error').slice(0,300)}});
      return {video:[],image:[]};
    }
  };
  const creditStatus=await readProviderStatus(getPool()).catch(()=>({}));
  const argoReady=Boolean(access.argolink && providerSettings.argolink.active);
  const usable=source=>!(argoReady&&isOutOfCredits(creditStatus,source));
  if (access.smartaipi && providerSettings.smartaipi.active && usable('smartaipi')) {
    const catalog=await safeCatalog('smartaipi',async()=>({image:publicSmartImagePricing(await getProviderSettings())}));
    image.push(...catalog.image);
  }
  if(access.vercel && providerSettings.vercel.active && usable('vercel')){
    const catalog=await safeCatalog('vercel',()=>publicProviderCatalog('vercel',{creditsPerUsd:providerSettings.vercel.customerCreditsPerUsd}));
    image=addMissingImageModels(image,catalog.image);
  }
  // fal.ai image models: same customer switch and credit rate as the fal source.
  if(access.fal && providerSettings.fal.active){
    const catalog=await safeCatalog(FAL_IMAGE_PROVIDER,()=>publicProviderCatalog(FAL_IMAGE_PROVIDER,{creditsPerUsd:providerSettings.fal.customerCreditsPerUsd}));
    // Keep the reference variants even when another provider already has
    // the same model family in the picker.
    falReferenceModels=catalog.image.filter(model=>model.capabilities?.image?.supported);
    image=addMissingImageModels(image,catalog.image.filter(model=>!model.capabilities?.image?.supported));
  }
  if(access.argolink && providerSettings.argolink.active){
    const hd=falReady(await getProviderSettings());
    const hdOff=await argoHdOffModels();
    const catalog=await safeCatalog('argolink',()=>publicProviderCatalog('argolink',{creditsPerUsd:providerSettings.argolink.customerCreditsPerUsd,transform:model=>argoVideoView(model,hd,{hd:!hdOff.has(model.publicModelId)})}));
    video=catalog.video;
    image=addMissingImageModels(image,catalog.image);
  }
  if(access.api888 && providerSettings.api888.active){
    const catalog=await safeCatalog('api888',()=>publicProviderCatalog('api888',{}));
    // Hide models 888API does not currently mark "available" (当前可用).
    const health=await loadApi888Health().catch(()=>null);
    const live=model=>isApi888PublicAvailable(health,model.id);
    video.push(...catalog.video.filter(live));
    image.push(...catalog.image.filter(live));
  }
  // Higgsfield's Wan 3.0: 480p native; 720p/1080p rendered lower and upscaled by fal.
  if(access.higgsfield && providerSettings.higgsfield.active){
    const hd=falReady(await getProviderSettings());
    const hdOff=await argoHdOffModels();
    const catalog=await safeCatalog('higgsfield',()=>publicProviderCatalog('higgsfield',{creditsPerUsd:providerSettings.higgsfield.customerCreditsPerUsd,transform:model=>wanVideoView(model,hd,{hd:!hdOff.has(model.publicModelId)})}));
    video=[...video,...catalog.video];
  }
  // Seedance Lite on Sluice: rendered at the chosen resolution, priced at cost.
  if(access.sluice && providerSettings.sluice.active){
    const catalog=await safeCatalog('sluice',()=>publicProviderCatalog('sluice',{creditsPerUsd:providerSettings.sluice.customerCreditsPerUsd}));
    video=[...video,...catalog.video];
  }
  if(access.wxksai && providerSettings.wxksai.active){
    const catalog=await safeCatalog('wxksai',()=>publicProviderCatalog('wxksai'));
    video.push(...catalog.video.filter(model=>isWxksaiModel(model.id)));
  }
  if(access.longai && providerSettings.longai.active){
    const catalog=await safeCatalog('longai',()=>publicProviderCatalog('longai'));
    video=[...video,...catalog.video.filter(model=>isLongAiModel(model.id))];
  }
  // Omni Flash on Vidancee: a flat price per clip length, at cost.
  if(access.vidancee && providerSettings.vidancee.active){
    const catalog=await safeCatalog('vidancee',()=>publicProviderCatalog('vidancee',{creditsPerUsd:providerSettings.vidancee.customerCreditsPerUsd}));
    video=[...video,...catalog.video];
  }
  // Premium AIVID choices remain in Video Studio even when an already paired
  // RDP agent temporarily disconnects. The AIVID quote/queue gates still
  // refuse a paid submission unless the Edge agent and source are ready.
  if(access.aivid){
    const config=await require('./src/aivid_settings.js').getAividSettings().catch(()=>null);
    video.push(...require('./src/aivid_models.js').customerCatalog(config));
  }
  video=[...video,...directVideoModels(access,providerSettings)];
  return {
    video:video.filter(model=>!isRetiredModel(model)),
    image:[...image,...falReferenceModels].filter(model=>!isRetiredModel(model)),
    upscaler:publicUpscalerConfig(Boolean(access.fal && providerSettings.fal.active)),
  };
}

// The API vendor behind a model id, for the admin.
function modelVendor(id){
  if(isWxksaiModel(id))return 'Dope';
  if(require('./src/aivid_models.js').isAividModel(id))return 'AIVID';
  if(isApi888Model(id))return '888API';
  if(isArgoModel(id))return 'ArgoLink';
  if(isHiggsfieldModel(id))return 'Higgsfield';
  if(isSluiceModel(id))return 'Sluice';
  if(isVidanceeModel(id))return 'Vidancee';
  if(isFalImageModel(id))return 'fal.ai';
  if(isGatewayModel(id))return 'Vercel AI Gateway';
  if(smartImageModel(id))return 'SmartAIPI';
  if(isH3Model(id))return 'vgenv';
  return '';
}

// Every model a studio can show (sources the admin has turned on), with the
// source's name and the admin's name, for Admin → Provider → Model names.
async function adminModelNameList(){
  const everyone=defaultCustomerProviderAccess();
  const [catalog,names,hdOff]=await Promise.all([sourceMediaCatalog(everyone),modelDisplayNames(),argoHdOffModels()]);
  const cartoon=publicPricing().filter(model => CARTOON_MODELS.includes(model.id));
  const rows=[];
  for(const [studio,list] of [['video',catalog.video],['image',catalog.image],['cartoon',cartoon]]){
    for(const m of list)rows.push({key:studio+':'+m.id,studio,id:m.id,vendor:modelVendor(m.id),defaultName:m.label,name:names[studio+':'+m.id]||names[studio+':'+storedModelId(m.id)]||'',
      ...(studio==='video'&&(isArgoModel(m.id)||isHiggsfieldModel(m.id))?{hdEnhance:!hdOff.has(m.id)}:{})});
  }
  return rows;
}

// Example price of every model at its default settings, for the public
// Pricing page (no sign-in needed). Cached for 10 minutes.
// Seedance 2.5 on ArgoLink looks expensive next to the rest, so the Pricing
// page leaves it out; Seedance Lite (Sluice) stays.
const PRICING_PAGE_HIDDEN=['argo_seedance_2_5','aivid_seedance_2_0_mini','aivid_seedance_2_0','aivid_seedance_2_0_fast','aivid_seedance_2_5'];
let priceExamplesCache=null;
async function priceExamples(){
  if(priceExamplesCache&&Date.now()-priceExamplesCache.at<10*60*1000)return priceExamplesCache.data;
  const rate=priceRate(null);
  const catalog=scalePrices(await customerMediaCatalog(defaultCustomerProviderAccess()),rate);
  const quote=async body=>{const q=await quoteModelForUser(null,body);return {...q,cost:applyPriceRate(q.cost,rate)};};
  const video=[],image=[],perSecond=[];
  for(const m of catalog.video){
    // Not listed on the Pricing page; the studios still offer it.
    if(PRICING_PAGE_HIDDEN.includes(m.id))continue;
    let seconds=m.defaultDuration||m.durations?.[0]?.seconds||null,resolution=m.defaultResolution||null,credits=null;
    if(!m.dynamicCost){
      const list=(m.resolutions?.length?((m.resolutions.find(r=>r.id===resolution)||m.resolutions[0]).durations):m.durations)||[];
      const d=list.find(x=>x.seconds===seconds)||list[0];credits=Number(d?.cost)||null;seconds=d?.seconds??seconds;
    }else{
      try{credits=(await quote({model:m.id,mediaType:'video',duration:seconds,resolution,aspectRatio:m.defaultAspectRatio,generateAudio:m.supportsAudio===true})).cost;}catch{}
    }
    if(credits>0)video.push({name:m.label,seconds,resolution,credits,...(m.warning?{warning:m.warning}:{})});
    if(/^Seedance 2\.5\b/.test(m.label))perSecond.push(...await perSecondPrices(m,quote));
  }
  for(const m of catalog.image){
    let credits=Number(m.cost)||null;
    if(!credits&&m.costTable){const values=Object.values(m.costTable).map(Number).filter(n=>n>0);credits=values.length?Math.min(...values):null;}
    if(credits>0)image.push({name:m.label,credits});
  }
  const data={video,image,perSecond,upscaler:catalog.upscaler?.enabled||false};
  priceExamplesCache={at:Date.now(),data};
  return data;
}

// CMM Tools vs other platforms for the /compare page, at live prices. Cached for 10 minutes.
let priceComparisonCache=null;
async function priceComparison(){
  if(priceComparisonCache&&Date.now()-priceComparisonCache.at<10*60*1000)return priceComparisonCache.data;
  const data=await comparePrices(async c=>applyPriceRate((await quoteModelForUser(null,{model:c.model,mediaType:'video',duration:c.seconds,resolution:c.resolution,aspectRatio:'16:9',generateAudio:c.audio})).cost,priceRate(null)));
  if(data.rows.length)priceComparisonCache={at:Date.now(),data};
  return data;
}

const httpError=(statusCode,message)=>Object.assign(new Error(message),{statusCode});

// Live price of an ArgoLink or AI Gateway model ({cost,isEstimate}).
// A customer's price multiplier (the 5% increase, times boosted pricing if on).
async function userPriceRate(userId){
  if(!userId)return priceRate(null);
  const [rows]=await getPool().execute('SELECT price_rate FROM users WHERE id=? LIMIT 1',[userId]);
  return priceRate(rows[0]);
}
// The price a signed-in customer is shown, at their own rate.
async function customerQuote(userId,body){
  const [quote,rate]=await Promise.all([quoteModelForUser(userId,body),userPriceRate(userId)]);
  return {...quote,cost:applyPriceRate(quote.cost,rate)};
}

async function quoteModelForUser(userId,body){
  if(isRetiredModel(String(body.model||'')))throw httpError(404,'This model is no longer available.');
  const access=await getUserProviderAccess(userId);
  const mediaType=body.mediaType==='image'?'image':'video';
  const providerSettings=await getAdminProviderSettings();
  if(mediaType==='video'&&DIRECT_VIDEO_MODELS.includes(String(body.model))){
    if(!directVideoSourceActive(String(body.model),access,providerSettings))throw httpError(403,'This model source is unavailable for your account.');
    return {cost:getCost(String(body.model),Number(body.duration),body.resolution||null),isEstimate:false};
  }
  if(mediaType==='video'&&require('./src/aivid_models.js').isAividModel(body.model)){
    if(!access.aivid)throw httpError(403,'Premium models are not enabled for your account.');
    return require('./src/aivid_models.js').quoteAivid(await require('./src/aivid_settings.js').getAividSettings(),body,{preview:true});
  }
  if(isWxksaiModel(body.model) && mediaType==='video'){
    if(!access.wxksai || !providerSettings.wxksai.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId('wxksai',String(body.model),'video');
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    // The price preview has no uploaded media bytes yet. Validate the chosen
    // settings and any supplied media, but don't require an image just to see
    // the fixed clip price. Paid submissions use strict validation below.
    validateReferences(model,body,{forQuote:true});
    const quote=quoteGateway(model,body,providerSettings.wxksai.creditsPerUsd);
    return {cost:quote.cost,isEstimate:false};
  }
  if(isApi888Model(body.model)){
    if(!access.api888||!providerSettings.api888.active)throw httpError(403,'This provider is not enabled.');
    const model=await getProviderModelByPublicId('api888',String(body.model),mediaType);
    if(!model?.ready)throw httpError(404,'888API model not ready.');
    const quote=quoteApi888(model,body);
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
  if(isLongAiModel(body.model)&&mediaType==='video'){
    if(!access.longai||!providerSettings.longai.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId('longai',body.model,'video');
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    validateReferences(model,body);
    const quote=quoteGateway(model,body,providerSettings.longai.customerCreditsPerUsd);
    return {cost:quote.cost,isEstimate:quote.isEstimate};
  }
  if(isVidanceeModel(body.model)&&mediaType==='video'){
    if(!access.vidancee||!providerSettings.vidancee.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId('vidancee',String(body.model),'video');
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    const quote=quoteGateway(model,body,providerSettings.vidancee.customerCreditsPerUsd);
    return {cost:quote.cost,isEstimate:quote.isEstimate};
  }
  if(isHiggsfieldModel(body.model)&&mediaType==='video'){
    if(!access.higgsfield||!providerSettings.higgsfield.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId('higgsfield',String(body.model),'video');
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    const quote=await quoteHiggsfieldVideo(model,body,await getProviderSettings());
    return {cost:quote.cost,isEstimate:quote.isEstimate};
  }
  if(isFalImageModel(body.model)&&mediaType==='image'){
    if(!access.fal||!providerSettings.fal.active)throw httpError(403,'This model source is unavailable for your account.');
    const model=await getProviderModelByPublicId(FAL_IMAGE_PROVIDER,String(body.model),'image');
    if(!model?.ready)throw httpError(404,'This model is currently unavailable.');
    const quote=quoteGateway(model,body,providerSettings.fal.customerCreditsPerUsd);
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

// Adds the bucket's CORS rule so customers' browsers can upload references
// directly. Returns true on success; false (and a log entry) when the R2 token
// may not change bucket settings, in which case the owner adds the rule.
async function enableBrowserUploads(){
  const store=await configuredStorage({requireEnabled:false}).catch(()=>null);
  if(!store)return false;
  const origins=[...new Set([appUrl()||PRIMARY_URL,PRIMARY_URL])];
  try{await store.allowBrowserUploads(origins);await setSettingValue('r2_cors_ok','true');return true;}
  catch(error){
    await setSettingValue('r2_cors_ok','false').catch(()=>{});
    logActivity({level:'warn',category:'system',event:'r2.cors_failed',message:'Add the CORS rule to the bucket in Cloudflare to enable direct browser uploads.',details:{storageStatus:error.storageStatus||null}});
    return false;
  }
}

// The longest reference video (total, or per clip) a video model accepts.
async function referenceVideoLimit(id){
  const {aividModel,aividReferenceVideoLimit}=require('./src/aivid_models.js');
  const premium=aividModel(id);
  if(premium)return aividReferenceVideoLimit(premium);
  if(isH3Model(id))return {clipSeconds:H3_REFS.maxSeconds};
  const provider=isWxksaiModel(id)?'wxksai':isApi888Model(id)?'api888':isArgoModel(id)?'argolink':isHiggsfieldModel(id)?'higgsfield':isGatewayModel(id)?'vercel':null;
  if(!provider)return {};
  const model=await getProviderModelByPublicId(provider,id,'video').catch(()=>null);
  const caps=model?.referenceCapabilities||{};
  return {totalSeconds:Number(caps.video?.maxTotalSeconds||caps.videoMaxTotalSeconds||model?.inputLimits?.video?.max_duration_seconds)||null};
}

// Video Studio and Cartoon Studio submissions (the website and the Claude connector).
async function submitVideoGeneration(user,body,req=null,apiRequest=null){
  const createVideo=(userId,input,options={})=>createGenerationForUser(userId,input,{...options,apiRequest});
  // Preview hints are for /api/model-cost only; a job is priced from its files.
  if(body&&typeof body==='object'){delete body.previewVideoSeconds;delete body.previewHasReferences;}
  const providerSettings=await getProviderSettings();
  if (!providerSettings.allowProviderCharges) {
    throw httpError(503,'Generation submissions are currently paused.');
  }

  const requestedModel=String(body.model||'');
  if(isRetiredModel(requestedModel))throw httpError(404,'This model is no longer available.');
  const customerAccess=await getUserProviderAccess(user.id);
  let generation=null;
  // Cut reference videos that are longer than the model accepts.
  const referenceNotices=Array.isArray(body.videos)&&body.videos.length&&!body.cartoonStyle
    ?trimReferenceVideos(body.videos,await referenceVideoLimit(requestedModel)):[];
  // Cartoon Studio runs on MiniMax H3 (vgenv) or Seedance Lite (Sluice).
  const cartoonOptions=body.cartoonStyle?normalizeCartoonRequest(body):null;

  if(!cartoonOptions&&require('./src/aivid_models.js').isAividModel(requestedModel)){
    if(!customerAccess.aivid)throw httpError(403,'Premium models are not enabled for your account.');
    const config=await require('./src/aivid_settings.js').getAividSettings();
    const {aividModel,capabilities,quoteAivid,aividReferenceVideoLimit}=require('./src/aivid_models.js');
    const spec=aividModel(requestedModel);
    validateAividVideoReferences(body.videos,aividReferenceVideoLimit(spec));
    const quote=await quoteAivid(config,body);
    generation=await createVideo(user.id,{...body,...quote},{provider:'aivid',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:capabilities(spec),aividManualHandoff:config.manualHandoff,
      validatePreparedReferences:({images,videos,audios})=>require('./src/provider/aivid.js').validateJob(body,[...images,...videos.map(r=>({...r,kind:'video'})),...audios.map(r=>({...r,kind:'audio'}))]),
      costOverride:quote.cost,providerCost:quote.sourceCredits,providerCostUnit:'aivid_credits',maxCustomerCredits:body.maxCustomerCredits,
      generationOptions:{quotedSourceCredits:quote.sourceCredits,sourceUsd:quote.sourceUsd,sourceUsdPerAividCredit:0.12,model:requestedModel}});
  }
  if(!cartoonOptions&&isApi888Model(requestedModel)){
    if(!customerAccess.api888||!providerSettings.api888Enabled||!providerSettings.api888ApiKey)throw httpError(503,'888API video generation is unavailable.');
    const model=await getProviderModelByPublicId('api888',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'888API model not ready.');
    if(!isApi888Available(await loadApi888Health().catch(()=>null),model.providerModelId))
      throw httpError(503,'Model under maintenance. Please choose another model.');
    validateReferences(model,body);
    const quote=quoteApi888(model,body);
    generation=await createVideo(user.id,{...body,...quote},{provider:'api888',dynamicModel:true,
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
    generation=await createVideo(user.id,{...body,...quote},{provider:'argolink',dynamicModel:true,
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
    generation=await createVideo(user.id,{...body,...quote},{provider:'sluice',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd',generationOptions:{...quote,model,...(cartoonOptions||{})},
    });
  }

  if(!cartoonOptions&&isWxksaiModel(requestedModel)){
    if(!customerAccess.wxksai||!providerSettings.wxksaiEnabled||!providerSettings.wxksaiApiKey)throw httpError(503,'This video model is currently unavailable.');
    const model=await getProviderModelByPublicId('wxksai',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'This video model is currently unavailable.');
    validateReferences(model,body);
    const quote=quoteGateway(model,body,providerSettings.wxksaiCustomerCreditsPerUsd);
    generation=await createVideo(user.id,{...body,model:storedModelId(requestedModel),...quote},{provider:'wxksai',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd',generationOptions:{...quote,model},
    });
  }
  if(!cartoonOptions&&isLongAiModel(requestedModel)){
    if(!customerAccess.longai||!providerSettings.longAiEnabled||!providerSettings.longAiApiKey)throw httpError(503,'This video model is currently unavailable.');
    const model=await getProviderModelByPublicId('longai',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'This video model is currently unavailable.');
    validateReferences(model,body);
    const quote=quoteGateway(model,body,providerSettings.longAiCustomerCreditsPerUsd);
    generation=await createVideo(user.id,{...body,...quote},{provider:'longai',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd',generationOptions:{...quote,model},
    });
  }

  // Omni Flash on Vidancee (Video Studio only).
  if(!cartoonOptions&&isVidanceeModel(requestedModel)){
    if(!customerAccess.vidancee||!providerSettings.vidanceeEnabled||(!providerSettings.vidanceeEmail||!providerSettings.vidanceePassword))throw httpError(503,'This video model is currently unavailable.');
    const model=await getProviderModelByPublicId('vidancee',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'This video model is currently unavailable.');
    validateReferences(model,body);
    const quote=quoteGateway(model,body,providerSettings.vidanceeCustomerCreditsPerUsd);
    generation=await createVideo(user.id,{...body,...quote},{provider:'vidancee',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:vidanceeCreditsForDuration(quote.duration),providerCostUnit:'vidancee_credits',generationOptions:{...quote,model},
    });
  }

  if(!cartoonOptions&&isHiggsfieldModel(requestedModel)){
    if(!customerAccess.higgsfield||!providerSettings.higgsfieldEnabled||!providerSettings.higgsfieldApiKey)throw httpError(503,'This video model is currently unavailable.');
    const model=await getProviderModelByPublicId('higgsfield',requestedModel,'video');
    if(!model?.ready)throw httpError(404,'This video model is currently unavailable.');
    validateReferences(model,body);
    validateHiggsfieldReferences(model,body,{mp4Seconds});
    const quote=await quoteHiggsfieldVideo(model,body,providerSettings);
    generation=await createVideo(user.id,{...body,...quote},{provider:'higgsfield',dynamicModel:true,
      defaultResolution:quote.resolution,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd',generationOptions:{...quote,model},
    });
  }

  // Video Studio runs on ArgoLink and Higgsfield, and MiniMax H3 on vgenv.
  if (!generation && !cartoonOptions && !DIRECT_VIDEO_MODELS.includes(requestedModel)) throw httpError(400,'This video model is not available. Choose a model from the list.');

  if (!generation) {
    if (isH3Model(requestedModel)) {
      if (!customerAccess.vgenv || !providerSettings.vgenvEnabled || !providerSettings.vgenvApiKey) {
        throw httpError(503,'This model is currently unavailable.');
      }
    }
    // Video Studio's MiniMax H3 also takes sound clips and a reference video (src/h3_references.js).
    // Every direct model runs on vgenv now (MiniMax H3).
    const options=cartoonOptions?{provider:'vgenv',generationOptions:cartoonOptions}
      :{provider:'vgenv',validateMedia:(audios,videos,images)=>validateH3Media(audios,videos,images,{mp4Seconds})};
    generation=await createVideo(user.id,body,options);
  }

  wakeForNewWork(req);
  if(generation&&referenceNotices.length)generation.reference_notices=referenceNotices;
  return generation;
}

// Image Studio submissions (the website and the Claude connector).
async function submitImageGeneration(user,body,req=null,apiRequest=null){
  const createImage=(userId,input,options={})=>createImageGenerationForUser(userId,input,{...options,apiRequest});
  const providerSettings=await getProviderSettings();
  if (!providerSettings.allowProviderCharges) {
    throw httpError(503,'Generation submissions are currently paused.');
  }

  await attachReusedImageReferences(getPool(),user.id,body);
  let requestedModel=String(body.model||'');
  if(isRetiredModel(requestedModel))throw httpError(404,'This model is no longer available.');
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
    generation=await createImage(user.id,{...body,aspectRatio:quote.aspectRatio},{
      provider:'vercel',dynamicModel:true,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd-estimate',imageQuality:quote.quality,
      generationOptions:{...quote,model},
    });
  }

  if(isFalImageModel(requestedModel)){
    if(!customerAccess.fal||!providerSettings.falEnabled||!providerSettings.falApiKey)throw httpError(503,'This image model is currently unavailable.');
    const model=await getProviderModelByPublicId(FAL_IMAGE_PROVIDER,requestedModel,'image');
    if(!model?.ready)throw httpError(404,'This image model is currently unavailable.');
    // Only the uploaded and restored files determine the charged price.
    const input={...body,previewHasReferences:false,reuseImageIds:undefined};
    validateReferences(model,input);
    const quote=quoteGateway(model,input,providerSettings.falCustomerCreditsPerUsd);
    generation=await createImage(user.id,{...input,aspectRatio:quote.aspectRatio},{
      provider:FAL_IMAGE_PROVIDER,dynamicModel:true,referenceCapabilities:model.referenceCapabilities,
      costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:quote.isEstimate?'usd-estimate':'usd',
      imageQuality:quote.quality,
      generationOptions:{...quote,model},
    });
  }

  if(isApi888Model(requestedModel)){
    if(!customerAccess.api888||!providerSettings.api888Enabled||!providerSettings.api888ApiKey)throw httpError(503,'888API image generation is unavailable.');
    const model=await getProviderModelByPublicId('api888',requestedModel,'image');
    if(!model?.ready)throw httpError(404,'888API image model not ready.');
    if(!isApi888Available(await loadApi888Health().catch(()=>null),model.providerModelId))
      throw httpError(503,'Model under maintenance. Please choose another model.');
    if((body.images||[]).length||body.reuseImageIds?.length)throw httpError(400,'888API image editing is not yet available.');
    validateReferences(model,body);
    const quote=quoteApi888(model,body);
    generation=await createImage(user.id,{...body,aspectRatio:quote.aspectRatio},{
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
    generation=await createImage(user.id,{...body,aspectRatio:quote.aspectRatio},{
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
    generation=await createImage(user.id,body,{
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
  catalog:async userId=>scalePrices(await customerMediaCatalog(await getUserProviderAccess(userId)),await userPriceRate(userId)),
  quote:customerQuote,
  submitVideo:(user,body)=>submitVideoGeneration(user,body),
  submitImage:(user,body)=>submitImageGeneration(user,body),
  submitUpscale:(user,input)=>submitUpscale(user,input),
  wake:()=>{if(wakeAllowed())wakeWorker();},
});

// Public customer API uses the same account permissions, prices and queue as the studio.
const customerApi=require('./src/customer_api.js').createCustomerApi({
  getPool,requireDatabase,requireUser,readJson,readGenerationRequest,sendJson,publicOrigin,
  catalog:async userId=>scalePrices(await customerMediaCatalog(await getUserProviderAccess(userId)),await userPriceRate(userId)),
  quote:customerQuote,submitVideo:submitVideoGeneration,submitImage:submitImageGeneration,
  getVideo:getUserGeneration,getImage:getUserImageGeneration,listVideos:listUserGenerations,listImages:listUserImageGenerations,
  serveMedia:async(row,req,res)=>{
    if(row.output_url==='db:video')return serveVideoOutput(getPool(),req,res,row.id);
    if(row.output_url==='db:image'){
      const [outputs]=await getPool().execute('SELECT mime_type,image_data FROM generation_image_outputs WHERE generation_id=?',[row.id]);
      await require('./src/object_storage.js').hydrateBlobs(outputs,'image_data');
      const output=outputs[0];
      if(!output)throw httpError(404,'Generated image is unavailable.');
      res.writeHead(200,{'content-type':output.mime_type,'content-length':output.image_data.length,'cache-control':'private, no-store','x-content-type-options':'nosniff'});
      return res.end(output.image_data);
    }
    const key=keyFromMarker(row.output_url);
    if(key){
      const storage=await configuredStorage({requireEnabled:false});
      if(!storage)throw httpError(503,'Output storage is unavailable.');
      return redirectToObject(storage,key,res,{contentType:row.media_type==='image'?'image/png':'video/mp4',filename:'cmm-tools-'+row.id+'.'+(row.media_type==='image'?'png':'mp4'),download:true});
    }
    const driveId=driveIdFromMarker(row.output_url);
    if(driveId)return (await configuredDrive({requireEnabled:false})).streamVideo(driveId,req,res);
    return proxyMedia(req,res,row,'video');
  },
});
const developerPage=fs.readFileSync(path.join(__dirname,'public','developers.html'),'utf8');
const developerDocsPage=fs.readFileSync(path.join(__dirname,'public','developer-docs.html'),'utf8');

const server=http.createServer(async (req,res)=>{
  const requestStarted=performance.now();
  const url=new URL(req.url||'/', 'http://' + (req.headers.host||'localhost'));
  const routePath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  res.once('finish',()=>{const ms=performance.now()-requestStarted;diagnostics.recordRequest(req.method,req.url,ms,res.statusCode);logRequest(req,routePath,res,ms);});
  const canonical=canonicalRedirect(req,routePath,url);
  if(canonical){res.writeHead(301,{location:canonical,'cache-control':'no-store'});return res.end();}

  try {
    if (await require('./src/aivid_rdp_http.js').handle(req,res,routePath,{readJson,requireDatabase})) return;
    if (await require('./src/aivid_rdp_viewer.js').handle(req,res,routePath,{requireUser,requireDatabase})) return;
    const studioAssets={
      '/brand.css':['brand.css','text/css; charset=utf-8'],
      '/developers.css':['developers.css','text/css; charset=utf-8'],
      '/studio.css':['studio.css','text/css; charset=utf-8'],
      '/dope-performance.js':['dope-performance.js','text/javascript; charset=utf-8'],
      '/admin.css':['admin.css','text/css; charset=utf-8'],
      '/aivid-admin.js':['aivid-admin.js','text/javascript; charset=utf-8'],
      '/provider-admin.js':['provider-admin.js','text/javascript; charset=utf-8'],
      '/longai-admin.js':['longai-admin.js','text/javascript; charset=utf-8'],
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
    if (req.method==='GET' && routePath==='/developers') return sendHtml(res,200,developerPage);
    if (req.method==='GET' && routePath==='/developers/docs') return sendHtml(res,200,developerDocsPage);
    if (await customerApi.handle(req,res,url,routePath)) return;
    if (req.method==='GET' && routePath==='/app') return sendHtml(res,200,customerPage);
    if (req.method==='GET' && routePath==='/pricing') return sendHtml(res,200,pricingPage);
    if (req.method==='GET' && routePath==='/compare') return sendHtml(res,200,comparePage);
    if (req.method==='GET' && routePath==='/admin-console') return sendHtml(res,200,adminPage);

    // Google OAuth redirects cannot carry the x-admin-token header. A strong,
    // single-use, short-lived state is issued only from authenticated Admin.
    if(req.method==='GET'&&routePath==='/admin/google-drive/callback'){
      const page=message=>sendHtml(res,200,'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>CMM Tools Google Drive</title><body style="font:16px system-ui;max-width:600px;margin:70px auto;padding:20px"><h2>Google Drive connection</h2><p>'+message+'</p><a href="/admin-console">Back to Admin</a></body></html>');
      const state=String(url.searchParams.get('state')||'');
      const code=String(url.searchParams.get('code')||'');
      const stored=await getSettingValue('gdrive_oauth_state','');
      let pending=null;
      try{pending=JSON.parse(stored||'null');}catch{}
      const stateHash=crypto.createHash('sha256').update(state).digest('hex');
      if(!pending||!state||!code||pending.hash!==stateHash||Date.now()>pending.expiresAt)
        return sendJson(res,400,{ok:false,error:'Invalid or expired Google Drive authorization. Restart from Admin.'});
      await setSettingValue('gdrive_oauth_state','');
      try{
        const config=await oauthConfig();
        if(!pending.clientHash||pending.clientHash!==crypto.createHash('sha256').update(config.clientId).digest('hex'))
          return sendJson(res,400,{ok:false,error:'Google OAuth client changed during authorization. Start again from Admin.'});
        const refreshToken=await exchangeCode(code,{config});
        const drive=new GoogleDriveStore({...config,refreshToken});
        const existingFolder=await getSettingValue('gdrive_folder_id','');
        let folderId=null;
        if(existingFolder){
          try{
            const existing=await drive.metadata(existingFolder);
            if(existing.mimeType==='application/vnd.google-apps.folder'&&!existing.trashed)folderId=existingFolder;
          }catch{}
          if(!folderId){
            const [[count]]=await getPool().query("SELECT COUNT(*) AS total FROM generations WHERE output_url LIKE 'gdrive:%'");
            if(Number(count.total)>0)throw new Error('Cannot switch to a different Google Drive while existing customer videos are stored in the previously connected account.');
          }
        }
        if(!folderId)folderId=await drive.createFolder();
        await setSettingValue('gdrive_refresh_token',refreshToken,{secret:true});
        await setSettingValue('gdrive_folder_id',folderId);
        await setSettingValue('gdrive_enabled','true');
        await setSettingValue('gdrive_migration_enabled','true');
        logActivity({category:'admin',event:'gdrive.connected',message:'Private Google Drive video storage connected; migration enabled.'});
        return page('Connected successfully. New generated videos will be saved privately to Google Drive. Existing MySQL videos will migrate gradually in the separate worker. Return to Admin → Storage to monitor.');
      }catch(error){
        logActivity({level:'error',category:'admin',event:'gdrive.connect_failed',message:'Google Drive authorization setup failed',details:{message:error.message}});
        return page('Connection could not be completed. Please return to Admin and check the Drive setup and runtime logs.');
      }
    }

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
      await require('./src/object_storage.js').hydrateBlobs(rows,'image_data');
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
      if(keyFromMarker(row.output_url)){
        try{return await (await configuredStorage({requireEnabled:false})).stream(keyFromMarker(row.output_url),req,res);}
        catch(error){if(res.headersSent){res.destroy();return;}throw error;}
      }
      if(driveIdFromMarker(row.output_url)){
        try{return await (await configuredDrive({requireEnabled:false})).streamVideo(driveIdFromMarker(row.output_url),req,res);}
        catch(error){if(res.headersSent){res.destroy();return;}throw error;}
      }
      return proxyMedia(req,res,row,'video');
    }

    const providerMediaMatch=routePath.match(/^\/provider-media\/([0-9a-f-]{36})\/(\d+)$/i);
    if((req.method==='GET'||req.method==='HEAD')&&providerMediaMatch){
      requireDatabase();
      const id=providerMediaMatch[1],position=Number(providerMediaMatch[2]);
      // Reference-field probe: log which tagged copy a provider downloads.
      if(url.searchParams.get('probe'))logActivity({category:'provider',event:'api888.reference_fetched',generationId:id,provider:'api888',
        message:'Provider downloaded reference via field '+String(url.searchParams.get('probe')).slice(0,40),
        details:{field:String(url.searchParams.get('probe')).slice(0,40),method:req.method,range:req.headers.range||null,userAgent:String(req.headers['user-agent']||'').slice(0,120)}});
      if(!verifyAssetSignature(id,position,String(url.searchParams.get('sig')||'')))return sendJson(res,403,{ok:false,error:'Invalid provider asset signature.'});
      const [[media]]=await getPool().execute('SELECT mime_type,media_data FROM generation_media WHERE generation_id=? AND position_index=? LIMIT 1',[id,position]);
      if(media)await require('./src/object_storage.js').hydrateBlobs(media,'media_data');
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
          providerSettings.vibi.active || providerSettings.smartaipi.active || providerSettings.vercel.active || providerSettings.argolink.active || providerSettings.higgsfield.active || providerSettings.sluice.active || providerSettings.vidancee.active || providerSettings.longai.active
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

    if (req.method==='GET' && routePath==='/api/dope-performance') {
      return sendJson(res,200,await getDopePerformance());
    }

    if (req.method==='GET' && routePath==='/api/config') {
      // Video Studio: ArgoLink, Higgsfield and MiniMax H3 (vgenv). Cartoon Studio: MiniMax H3 (vgenv). Image Studio: AI Gateway and SmartAIPI first,
      // then ArgoLink models they do not offer. Voice Studio: Vibi.
      let videoPricing=[];
      let catalogError=false;
      let imagePricing=[];
      let cartoonPricing=[];
      let voiceConfig={enabled:false};
      let customerProviderAccess=defaultCustomerProviderAccess();
      let cartoonEnabled=false;
      let upscalerConfig=publicUpscalerConfig(false);

      if (dbConfigured()) {
        try {
          const currentUser=await userFromRequest(req);
          if(currentUser)customerProviderAccess=await getUserProviderAccess(currentUser.id);
          const providerSettings=await getAdminProviderSettings();
          const h3Active=Boolean(customerProviderAccess.vgenv && providerSettings.vgenv.active);
          const names=await modelDisplayNames().catch(()=>({}));
          cartoonPricing=applyModelNames('cartoon',[
            ...(customerProviderAccess.sluice&&providerSettings.sluice.active?await sluiceCartoonPricing(providerSettings):[]),
            ...publicPricing().filter(model=>CARTOON_MODELS.includes(model.id)&&h3Active)],names);
          cartoonEnabled=cartoonPricing.length>0;

          const media=await customerMediaCatalog(customerProviderAccess,providerSettings,{names});
          videoPricing=media.video;
          imagePricing=media.image;
          // Customers on boosted pricing see every price at their rate.
          const rate=await userPriceRate(currentUser?.id);
          videoPricing=scalePrices(videoPricing,rate);
          imagePricing=scalePrices(imagePricing,rate);
          cartoonPricing=scalePrices(cartoonPricing,rate);
          upscalerConfig=media.upscaler;

          if (customerProviderAccess.vibi && providerSettings.vibi.active) {
            voiceConfig={enabled:true,cloningAvailable:true,maxTextChars:10000,cloneMaxBytes:20*1024*1024};
          }
        } catch (error) {
          catalogError=true;
          logActivity({level:'error',category:'system',event:'catalog.config_failed',message:'Public model catalog could not be assembled',details:{error:String(error?.message||'error').slice(0,300)}});
          // Keep public config usable during transient database/provider-setting issues.
        }
      }

      return sendJson(res,200,{
        ok:true,
        signupsEnabled:allowSignups,
        pricing:videoPricing,
        catalogError,
        aspectRatios:ASPECT_RATIOS,
        imagePricing,
        imageAspectRatios:IMAGE_ASPECT_RATIOS,
        voice:voiceConfig,
        providerAccess:publicDopeAccess(customerProviderAccess),
        cartoon:publicCartoonConfig(cartoonEnabled,cartoonPricing),
        upscaler:upscalerConfig,
        plans:publicPlans(),
        support:{whatsapp:SUPPORT_WHATSAPP,whatsappUrl:whatsappUrl('Hi CMM Tools, I need help with ')},
      });
    }

    // Explicitly retire the old routes so cached clients receive JSON instead
    // of falling through to the web app. Never call the former Gemini service.
    if (routePath === '/api/prompts/enhance' || routePath.startsWith('/api/prompts/enhance/')) {
      return sendJson(res,410,{ok:false,error:'Prompt enhancement is no longer available. Use your original prompt.'});
    }

    if (req.method==='POST' && routePath==='/api/model-cost') {
      requireDatabase();
      const costUser=await requireUser(req);
      return sendJson(res,200,{ok:true,...await customerQuote(costUser.id,await readJson(req))});
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
      return sendJson(res,200,{ok:true,cost:Number(applyPriceRate(sourceToCustomerCredits(sourceEstimate),await userPriceRate(user.id))),estimated:true});
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
      let cloneCost=Number(settings.vibiCloneCustomerCost||0);
      const db=getPool();
      const conn=await db.getConnection();
      try{
        await conn.beginTransaction();
        const [users]=await conn.execute('SELECT credits,price_rate FROM users WHERE id=? FOR UPDATE',[user.id]);
        if(users[0])cloneCost=applyPriceRate(cloneCost,priceRate(users[0]));
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
        await require('./src/object_storage.js').hydrateBlobs(outputs,'image_data');
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

    if (req.method==='GET' && routePath==='/api/generations/backup') {
      requireDatabase();
      const user=await requireUser(req);
      return await sendVideoBackup(getPool(),res,user.id);
    }

    // A presigned link for the browser to upload a reference video or sound
    // straight to cloud storage (409 when unavailable: the page then sends
    // the file with the form instead).
    if (req.method==='POST' && routePath==='/api/uploads/presign') {
      requireDatabase();
      const user=await requireUser(req);
      return sendJson(res,200,{ok:true,...await presignUpload(user.id,await readJson(req))});
    }

    if (req.method==='POST' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readGenerationRequest(req);
      const uploadedKeys=await collectDirectUploads(body,user.id);
      // A direct upload proves the bucket's CORS rule works (added by hand).
      if(uploadedKeys.length)getSettingValue('r2_cors_ok','').then(v=>v==='true'||setSettingValue('r2_cors_ok','true')).catch(()=>{});
      try{
        const generation=await submitVideoGeneration(user,body,req);
        const [users]=await getPool().execute('SELECT * FROM users WHERE id=?',[user.id]);
        return sendJson(res,201,{ok:true,generation,user:userPayload(users[0])});
      }finally{removeDirectUploads(uploadedKeys).catch(()=>{});}
    }

    if (req.method==='POST' && routePath==='/api/upscales/quote') {
      requireDatabase();
      const user=await requireUser(req);
      const settings=await getProviderSettings();
      const access=await getUserProviderAccess(user.id);
      if (!access.fal || !settings.falEnabled || !settings.falApiKey) return sendJson(res,503,{ok:false,error:'The video upscaler is currently unavailable.'});
      const quote=await quoteForCustomer(user.id,await readJson(req),settings);
      return sendJson(res,200,{ok:true,cost:applyPriceRate(quote.cost,await userPriceRate(user.id))});
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
      if(type==='video'&&keyFromMarker(row.output_url)){
        const store=await configuredStorage({requireEnabled:false});
        if(!store)return sendJson(res,503,{ok:false,error:'Video storage is not configured.'});
        return redirectToObject(store,keyFromMarker(row.output_url),res,{contentType:'video/mp4',
          filename:'cmm-tools-'+String(row.id).slice(0,8)+'.mp4',download:url.searchParams.get('download')==='1'});
      }
      if(type==='video'&&driveIdFromMarker(row.output_url)){
        try{return await (await configuredDrive({requireEnabled:false})).streamVideo(driveIdFromMarker(row.output_url),req,res);}
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
      // Read-only storage check for a video: what the bucket holds and what a
      // customer's playback link returns (first bytes only, never the file).
      const opsMedia=routePath.match(/^\/ops\/generations\/([0-9a-f-]{36})\/media-check$/i);
      if (opsMedia) {
        const [[row]]=await db.execute('SELECT id,output_url FROM generations WHERE id=?',[opsMedia[1]]);
        if(!row)return sendJson(res,404,{ok:false,error:'Generation not found.'});
        const key=keyFromMarker(row.output_url);
        if(!key)return sendJson(res,200,{ok:true,outputUrl:String(row.output_url||'').slice(0,40),stored:'not in cloud storage'});
        const store=await configuredStorage({requireEnabled:false});
        const head=await store.head(key).catch(error=>({error:error.message}));
        const sniff=async(url,init={})=>{
          try{
            const r=await fetch(url,{...init,headers:{range:'bytes=0-63',...(init.headers||{})},signal:AbortSignal.timeout(20000)});
            const bytes=Buffer.from(await r.arrayBuffer()).subarray(0,64);
            return {status:r.status,contentType:r.headers.get('content-type'),contentRange:r.headers.get('content-range'),
              disposition:r.headers.get('content-disposition'),acceptRanges:r.headers.get('accept-ranges'),
              hasFtyp:bytes.includes(Buffer.from('ftyp')),firstBytes:bytes.toString('latin1').replace(/[^\x20-\x7e]/g,'.')};
          }catch(error){return {error:error.message};}
        };
        const name='cmm-tools-'+row.id.slice(0,8)+'.mp4';
        // File structure and codecs (the server reads the whole object once).
        let structure=null;
        if(url.searchParams.get('deep')==='1'&&head?.size>0&&head.size<=64*1024*1024){
          try{
            const data=Buffer.from(await (await store.get(key)).arrayBuffer());
            const {readBoxes}=require('./src/mp4_trim.js');
            const top=readBoxes(data);
            const moov=top.find(b=>b.type==='moov');
            const tracks=(moov?.children||[]).filter(b=>b.type==='trak').map(trak=>{
              const stbl=['mdia','minf','stbl'].reduce((b,t)=>b?.children?.find(c=>c.type===t),trak);
              const stsd=stbl?.children?.find(c=>c.type==='stsd');
              const hdlr=trak.children.find(c=>c.type==='mdia')?.children?.find(c=>c.type==='hdlr');
              return {handler:hdlr?hdlr.data.toString('latin1',8,12):null,codec:stsd?stsd.data.toString('latin1',12,16):null};
            });
            structure={boxes:top.map(b=>b.type+':'+b.size),seconds:mp4Seconds(data),tracks,
              tail:data.subarray(-48).toString('latin1').replace(/[^\x20-\x7e]/g,'.')};
          }catch(error){structure={error:error.message};}
        }
        return sendJson(res,200,{ok:true,key,head,structure,
          stream:await sniff(store.presign(key,{contentType:'video/mp4',disposition:'inline; filename="'+name+'"'})),
          download:await sniff(store.presign(key,{contentType:'video/mp4',disposition:'attachment; filename="'+name+'"'})),
          plain:await sniff(store.presign(key))});
      }
      // The finished video or image itself, for support work that needs to look
      // at outputs (for example picking clips for an ad). Each fetch is logged.
      const opsFile=routePath.match(/^\/ops\/generations\/([0-9a-f-]{36})\/file$/i);
      if (opsFile) {
        const [[row]]=await db.execute("SELECT id,output_url FROM generations WHERE id=? AND status='completed'",[opsFile[1]]);
        if(!row)return sendJson(res,404,{ok:false,error:'Generation not found.'});
        logActivity({level:'info',category:'admin',event:'support.media_viewed',generationId:row.id,message:'Output opened with the support key'});
        if(row.output_url==='db:image'){
          const [outputs]=await db.execute('SELECT mime_type,image_data FROM generation_image_outputs WHERE generation_id=?',[row.id]);
          await require('./src/object_storage.js').hydrateBlobs(outputs,'image_data');
          if(!outputs[0])return sendJson(res,404,{ok:false,error:'Generated image is unavailable.'});
          res.writeHead(200,{'content-type':outputs[0].mime_type,'content-length':outputs[0].image_data.length,'cache-control':'private, no-store','x-content-type-options':'nosniff'});
          return res.end(outputs[0].image_data);
        }
        const key=keyFromMarker(row.output_url);
        if(!key)return sendJson(res,404,{ok:false,error:'This output is not in cloud storage.'});
        const store=await configuredStorage({requireEnabled:false});
        if(!store)return sendJson(res,503,{ok:false,error:'Video storage is not configured.'});
        return redirectToObject(store,key,res,{contentType:'video/mp4',filename:'cmm-tools-'+row.id.slice(0,8)+'.mp4',download:false});
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
      const input=INPUT_TYPE.exec(type);
      if(input){
        if(!verifyAdminMedia(adminToken,id,type,url.searchParams.get('exp'),url.searchParams.get('sig')))
          return sendJson(res,403,{ok:false,error:'This link has expired. Refresh the admin page.'});
        const [table,column]=input[1]==='ref'?['generation_images','image_data']:['generation_media','media_data'];
        const [files]=await getPool().execute('SELECT mime_type,'+column+' AS data FROM '+table+' WHERE generation_id=? AND id=? LIMIT 1',[id,input[2]]);
        if(!files[0])return sendJson(res,404,{ok:false,error:'File not found.'});
        await require('./src/object_storage.js').hydrateBlobs(files,'data');
        // Only media types play inline; anything else downloads, so it never runs on the admin origin.
        const media=/^(image|video|audio)\/[\w.+-]+$/i.test(files[0].mime_type)&&!/svg/i.test(files[0].mime_type);
        res.writeHead(200,{'content-type':media?files[0].mime_type:'application/octet-stream','content-length':files[0].data.length,
          'cache-control':'private, max-age=3600','x-content-type-options':'nosniff',...(media?{}:{'content-disposition':'attachment'})});
        return res.end(files[0].data);
      }
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
          await require('./src/object_storage.js').hydrateBlobs(outputs,'image_data');
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
      if(type==='video'&&keyFromMarker(row.output_url)){
        const store=await configuredStorage({requireEnabled:false});
        if(!store)return sendJson(res,503,{ok:false,error:'Video storage is not configured.'});
        return redirectToObject(store,keyFromMarker(row.output_url),res,{contentType:'video/mp4',
          filename:'cmm-tools-'+String(row.id).slice(0,8)+'.mp4',download:url.searchParams.get('download')==='1'});
      }
      if(type==='video'&&driveIdFromMarker(row.output_url)){
        try{return await (await configuredDrive({requireEnabled:false})).streamVideo(driveIdFromMarker(row.output_url),req,res);}
        catch(error){if(res.headersSent){res.destroy();return;}throw error;}
      }
      if(type==='video'&&row.provider==='vgenv'&&/^https:\/\/[a-z0-9.-]+\.aliyuncs\.com\//i.test(String(row.output_url||''))){
        res.writeHead(302,{location:row.output_url,'cache-control':'private, no-store','referrer-policy':'no-referrer'});return res.end();
      }
      return proxyMedia(req,res,row,type==='poster'?'poster':'video');
    }

    const manualPacket = routePath.match(/^\/admin\/aivid\/manual\/packet(?:\/(\d{1,2}))?$/);
    if (req.method === 'GET' && manualPacket) {
      requireDatabase();
      const {readPacket} = require('./src/aivid_manual.js');
      const position = manualPacket[1] === undefined ? undefined : Number(manualPacket[1]);
      const data = await readPacket(getPool(), adminToken, req.headers.authorization, position);
      if (position === undefined) return sendJson(res, 200, {ok:true,...data});
      res.writeHead(200, {'content-type':data.mime_type,'content-length':data.media_data.length,
        'cache-control':'no-store','x-content-type-options':'nosniff','content-disposition':'attachment'});
      return res.end(data.media_data);
    }

    if (routePath.startsWith('/admin/')) {
      if (!adminToken) return sendJson(res,503,{ok:false,error:'ADMIN_TOKEN is not configured in hPanel.'});
      if (!adminAuthorized(req)) return sendJson(res,401,{ok:false,error:'Unauthorized'});


      if(routePath==='/admin/fal/images/sync'){
        const {falCatalogStatus,queueFalCatalogSync}=require('./src/fal_catalog_jobs.js');
        if(req.method==='GET'){
          requireDatabase();
          return sendJson(res,200,{ok:true,job:await falCatalogStatus()});
        }
        if(req.method==='POST'){
          const input=await readJson(req);
          if(input?.background!==true){
            return sendJson(res,409,{ok:false,error:'Reload the Admin page to use the new fal.ai connection workflow.'});
          }
          if(input.apiKey!==undefined && (typeof input.apiKey!=='string'||input.apiKey.length>512)){
            return sendJson(res,400,{ok:false,error:'Invalid fal.ai API key.'});
          }
          requireDatabase();
          const {falApiKey}=await getProviderSettings();
          const apiKey=input.apiKey?.trim()||falApiKey;
          const current=await falCatalogStatus();
          if(['queued','running'].includes(current.status)){
            if(apiKey!==falApiKey)return sendJson(res,409,{ok:false,error:'Wait for the current image import to finish before changing the key.'});
            return sendJson(res,202,{ok:true,job:current});
          }
          await verifyFalCatalogKey(apiKey);
          if(apiKey!==falApiKey)await updateProviderSettings({falApiKey:apiKey});
          const job=await queueFalCatalogSync();
          wakeGenerationWorker(req);
          return sendJson(res,202,{ok:true,job});
        }
      }
      if(req.method==='GET'&&routePath==='/admin/storage/r2'){
        requireDatabase();
        const cfg=await storageConfiguration();
        const {storageMigrationStats}=require('./src/r2_migration.js');
        let available=null;
        if(cfg.configured){
          try{await (await configuredStorage({requireEnabled:false})).check();available=true;}catch{available=false;}
        }
        return sendJson(res,200,{ok:true,configured:cfg.configured,enabled:cfg.enabled,migrationEnabled:cfg.migrationEnabled,
          available,endpoint:cfg.endpoint||null,bucket:cfg.bucket||null,
          accessKeyId:cfg.accessKeyId?cfg.accessKeyId.slice(0,4)+'…'+cfg.accessKeyId.slice(-4):null,
          browserUploads:await getSettingValue('r2_cors_ok','')==='true',appOrigin:appUrl()||PRIMARY_URL,
          stats:await storageMigrationStats(getPool())});
      }
      if(req.method==='POST'&&routePath==='/admin/storage/r2'){
        requireDatabase();
        const body=await readJson(req);
        try{await saveStorageSettings({endpoint:body.endpoint,bucket:body.bucket,accessKeyId:String(body.accessKeyId||'').trim(),secretAccessKey:String(body.secretAccessKey||'').trim()});}
        catch(error){return sendJson(res,400,{ok:false,error:error.message});}
        logActivity({category:'admin',event:'r2.settings_saved',message:'Cloud storage connected and verified; new files now go to the bucket (keys not logged).'});
        const cors=await enableBrowserUploads();
        return sendJson(res,200,{ok:true,saved:true,browserUploads:cors});
      }
      if(req.method==='POST'&&routePath==='/admin/storage/r2/state'){
        requireDatabase();
        const body=await readJson(req);
        const cfg=await storageConfiguration();
        if(!cfg.configured)return sendJson(res,409,{ok:false,error:'Save the cloud storage details first.'});
        for(const [field,setting] of [['enabled',STORAGE_SETTINGS.enabled],['migrationEnabled',STORAGE_SETTINGS.migration]]){
          if(body[field]===undefined)continue;
          if(typeof body[field]!=='boolean')return sendJson(res,400,{ok:false,error:field+' must be true or false.'});
          await setSettingValue(setting,body[field]?'true':'false');
        }
        logActivity({category:'admin',event:'r2.state_changed',message:'Cloud storage settings changed',details:{enabled:body.enabled,migrationEnabled:body.migrationEnabled}});
        return sendJson(res,200,{ok:true});
      }
      if(req.method==='GET'&&routePath==='/admin/google-drive/status'){
        requireDatabase();
        const config=await driveConfiguration(),stats=await videoMigrationStats(getPool());
        let available=null;
        if(config.connected){
          try{await (await configuredDrive({requireEnabled:false})).metadata(config.folderId);available=true;}
          catch{available=false;}
        }
        let oauthConfigured=false;
        let oauthSource='none';
        const savedId=await getSettingValue(OAUTH_ID_SETTING,'');
        const savedSecret=await getSettingValue(OAUTH_SECRET_SETTING,'');
        if(savedId&&savedSecret)oauthSource='admin';
        else if(process.env.GOOGLE_DRIVE_CLIENT_ID&&process.env.GOOGLE_DRIVE_CLIENT_SECRET)oauthSource='environment';
        try{await oauthConfig();oauthConfigured=true;}catch{}
        return sendJson(res,200,{ok:true,oauthConfigured,oauthSource,
          connected:config.connected,enabled:config.enabled,driveAvailable:available,
          migrationEnabled:await getSettingValue('gdrive_migration_enabled','false')==='true',
          folderId:config.connected?config.folderId:null,stats});
      }
      if(req.method==='POST'&&routePath==='/admin/google-drive/credentials'){
        requireDatabase();
        const body=await readJson(req);
        const clientId=String(body.clientId||'').trim();
        const clientSecret=String(body.clientSecret||'').trim();
        try{validateOAuthClient({clientId,clientSecret});}
        catch(error){return sendJson(res,400,{ok:false,error:error.message});}
        const cfg=await driveConfiguration();
        if(cfg.connected){
          let previousId='';
          try{previousId=(await oauthConfig()).clientId;}catch{}
          if(previousId&&previousId!==clientId)
            return sendJson(res,409,{ok:false,error:'Google Drive is already connected. Changing OAuth Client ID could make existing videos inaccessible. Keep the existing Client ID; rotating its secret is supported.'});
        }
        await saveGoogleDriveOAuthCredentials(clientId,clientSecret);
        logActivity({category:'admin',event:'gdrive.oauth_credentials_saved',
          message:'Google Drive OAuth client credentials saved in encrypted app_settings (values not logged).'});
        return sendJson(res,200,{ok:true,saved:true});
      }
      if(req.method==='POST'&&routePath==='/admin/google-drive/connect'){
        requireDatabase();
        const config=await oauthConfig();
        const state=crypto.randomBytes(32).toString('base64url');
        await setSettingValue('gdrive_oauth_state',JSON.stringify({
          hash:crypto.createHash('sha256').update(state).digest('hex'),
          clientHash:crypto.createHash('sha256').update(config.clientId).digest('hex'),
          expiresAt:Date.now()+10*60*1000,
        }),{secret:true});
        return sendJson(res,200,{ok:true,url:authUrl(state,config)});
      }
      if(req.method==='POST'&&routePath==='/admin/google-drive/migration'){
        requireDatabase();
        const body=await readJson(req);
        const cfg=await driveConfiguration();
        if(!cfg.connected) return sendJson(res,409,{ok:false,error:'Connect Google Drive first.'});
        if(typeof body.enabled!=='boolean')return sendJson(res,400,{ok:false,error:'enabled must be true or false.'});
        await setSettingValue('gdrive_migration_enabled',body.enabled?'true':'false');
        logActivity({category:'admin',event:'gdrive.migration_toggled',
          message:'Google Drive migration '+(body.enabled?'started':'paused')});
        return sendJson(res,200,{ok:true,migrationEnabled:body.enabled});
      }
      if (req.method==='POST' && routePath==='/admin/vibi/check') {
        requireDatabase();
        const settings=await getProviderSettings();
        if(!settings.vibiApiKey)return sendJson(res,400,{ok:false,error:'Vibi API key is not configured.'});
        const me=await vibiClient(settings).getMe();
        return sendJson(res,200,{ok:true,connected:true,creditBalance:Number(me.credit_balance||0),account:me.email||null});
      }

      // Retired Admin endpoint: no stored Gemini credentials are read.
      if (routePath==='/admin/prompt-enhancer/check') {
        return sendJson(res,410,{ok:false,error:'Prompt enhancement has been removed.'});
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
        await verifyFalCatalogKey(s.falApiKey);
        return sendJson(res,200,{ok:true});
      }
      // Admin-confirmed, idempotent recovery of already-completed provider
      // output for a failed, refunded task. No new provider generation or debit.
      if(req.method==='POST'&&routePath==='/admin/api888/recover-video'){
        requireDatabase();
        const body=await readJson(req);
        const config=await getProviderSettings();
        if(!config.api888ApiKey)return sendJson(res,503,{ok:false,error:'888API key is not configured in Admin.'});
        try{
          const result=await recoverApi888Video({db:getPool(),
            client:new Api888Client({apiKey:config.api888ApiKey}),
            generationId:body.generationId});
          return sendJson(res,200,{ok:true,...result});
        }catch(error){
          logActivity({level:'error',category:'admin',event:'api888.video_recovery_failed',
            provider:'api888',generationId:/^[0-9a-f-]{36}$/i.test(String(body.generationId||''))?body.generationId:null,
            message:'888API video recovery failed',details:errorDetails(error)});
          const recoveryStage=['video.status','video.download','video.storage'].includes(error.recoveryStage)?
            error.recoveryStage:null;
          const hint=error.providerMessage&&recoveryStage==='video.download'?String(error.providerMessage).slice(0,350):null;
          return sendJson(res,error.statusCode>=400&&error.statusCode<500?error.statusCode:502,{
            ok:false,recoveryStage,providerStatus:error.providerStatus||null,
            error:error.statusCode>=400&&error.statusCode<500?error.message:
              '888API recovery failed at '+(recoveryStage||'an unknown stage')+'.'+(hint?' '+hint:
              ' See Admin Activity for details.'),
          });
        }
      }
      // Read-only, existing paid task lookup. This cannot start a new generation.
      // Response never includes private provider output URLs, tokens or prompts.
      if(req.method==='GET'&&routePath==='/admin/api888/task-status'){
        requireDatabase();
        const id=String(url.searchParams.get('generation')||'');
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
          return sendJson(res,400,{ok:false,error:'Enter a valid CMM Tools generation ID.'});
        const [[job]]=await getPool().execute(
          "SELECT id,status,provider_job_id,provider_operation,refunded_at FROM generations WHERE id=? AND provider='api888' AND media_type='video' LIMIT 1",
          [id]);
        if(!job)return sendJson(res,404,{ok:false,error:'888API video generation not found.'});
        let saved={};
        try{saved=JSON.parse(job.provider_operation||'{}')||{};}catch{}
        const taskId=String(job.provider_job_id||saved.requestId||'');
        if(!/^[A-Za-z0-9_-]{5,191}$/.test(taskId))
          return sendJson(res,409,{ok:false,error:'No valid 888API task ID was saved for this generation.'});
        const config=await getProviderSettings();
        if(!config.api888ApiKey)return sendJson(res,503,{ok:false,error:'888API key is not configured in Admin.'});
        try{
          const result=await new Api888Client({apiKey:config.api888ApiKey}).videoStatus(taskId);
          const output={ok:true,localStatus:job.status,refunded:Boolean(job.refunded_at),
            providerTaskId:taskId,providerStatus:result.providerStatus,
            state:result.status,progress:result.progress,
            hasVideoResult:result.status==='done',
            providerError:result.status==='failed'?result.error:null};
          logActivity({category:'admin',event:'api888.task_status_checked',provider:'api888',
            generationId:id,message:'Read-only status lookup of existing 888API task',
            details:{state:output.state,providerStatus:output.providerStatus,progress:output.progress,
              localStatus:output.localStatus}});
          return sendJson(res,200,output);
        }catch(error){
          return sendJson(res,502,{ok:false,error:'888API task status check failed.',
            requestMethod:'GET',failureType:error.failureType||null,
            networkCode:error.networkCode||null,providerStatus:error.providerStatus||null,
            providerMessage:error.providerMessage||null});
        }
      }
      if(req.method==='POST'&&routePath==='/admin/wxksai/check'){
        const settings=await getProviderSettings();
        if(!settings.wxksaiApiKey)return sendJson(res,400,{ok:false,error:'Save a WXKSAI API key first.'});
        const live=await new WxksaiClient({apiKey:settings.wxksaiApiKey}).models();
        const known=wxksaiMediaModels(live);
        return sendJson(res,200,{
          ok:true,accessibleModels:live.data.length,supportedModels:known.length,
          // Visibility is not evidence that the candidate accepts video POSTs.
          sd25CandidateVisible:unverifiedDopeCandidateVisible(live),
          sd25CandidateVideoReady:false,
        });
      }
      if(req.method==='POST'&&routePath==='/admin/wxksai/sync'){
        const settings=await getProviderSettings();
        if(!settings.wxksaiApiKey)return sendJson(res,400,{ok:false,error:'Save a WXKSAI API key first.'});
        const live=await new WxksaiClient({apiKey:settings.wxksaiApiKey}).models();
        const models=wxksaiMediaModels(live);
        if(!models.length)return sendJson(res,409,{ok:false,error:'The WXKSAI account did not return any supported Seedance 2.5 models. Existing catalog preserved.'});
        const stored=await listProviderModels('wxksai');
        await syncProviderModels('wxksai',models);
        // A newly discovered provider SKU cannot silently begin charging customers.
        const already=new Set(stored.map(m=>m.providerModelId));
        const refreshed=await listProviderModels('wxksai');
        for(const model of refreshed)if(!already.has(model.providerModelId)&&model.enabled)
          await setProviderModelEnabled('wxksai',model.id,false);
        return sendJson(res,200,{ok:true,total:models.length,enabled:refreshed.filter(m=>already.has(m.providerModelId)&&m.enabled).length,
          notice:'Historical CNY prices, not a live quote. Verify your key and prices before enabling a SKU.'});
      }
      if(req.method==='POST'&&routePath==='/admin/api888/check'){
        requireDatabase();const s=await getProviderSettings();
        const catalog=await new Api888Client({apiKey:s.api888ApiKey}).models();
        return sendJson(res,200,{ok:true,accessibleModels:catalog.data.length});
      }
      if(req.method==='POST'&&routePath==='/admin/api888/audit'){
        requireDatabase();
        const s=await getProviderSettings();
        if(!s.api888ApiKey)return sendJson(res,409,{ok:false,error:'Save an 888API key before checking the live catalog.'});
        // Read-only: GET account-scoped catalog + SELECT saved model inventory;
        // do not sync, enable models or trigger any paid provider generations.
        const live=await new Api888Client({apiKey:s.api888ApiKey}).models();
        const stored=await listProviderModels('api888');
        const audit=auditApi888Import(live,stored);
        return sendJson(res,200,{...audit,providerEnabled:s.api888Enabled===true,
          checkedAt:new Date().toISOString(),
          message:audit.ok?'All models in the current upstream response are present with matching types and availability flags. Generation readiness is checked separately.':
            'Some live 888API model IDs are missing, stale-marked or misclassified in MySQL. Review the differences before syncing.'});
      }
      if(req.method==='POST'&&routePath==='/admin/api888/sync'){
        requireDatabase();const s=await getProviderSettings();
        const catalog=await new Api888Client({apiKey:s.api888ApiKey}).catalog();
        const models=await syncProviderModels('api888',api888MediaModels(catalog));
        return sendJson(res,200,{ok:true,total:models.length,adapterSupported:models.filter(m=>m.adapterSupported).length,
          dynamicSeedanceModels:models.filter(m=>m.available&&m.ready&&require('./src/api888_models.js').SEEDANCE25_DYNAMIC_IDS.includes(m.providerModelId)).length,
          note:'Account-visible models and live Seedance 2.5 per-second prices imported. Existing credit conversion, model switches and customer access still apply.'});
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
      if(req.method==='GET'&&routePath==='/admin/longai/check'){
        const result=await new LongAiClient().checkReachability();
        return sendJson(res,200,{ok:true,...result});
      }
      if(req.method==='GET'&&routePath==='/admin/longai/video-tests'){
        const settings=await getProviderSettings();
        const market=await loadVideoMarketplace(new LongAiClient());
        return sendJson(res,200,{ok:true,...market,keyConfigured:Boolean(settings.longAiApiKey)});
      }
      if(req.method==='GET'&&routePath==='/admin/longai/video-tests/model'){
        const settings=await getProviderSettings();
        if(!settings.longAiApiKey)throw httpError(400,'Save a LONG AI API key first.');
        const result=await checkVideoModel(new LongAiClient({apiKey:settings.longAiApiKey}),url.searchParams.get('model'));
        if(result.status==='visible')result.renderProof=signVideoKeyCheck(adminToken,settings.longAiApiKey,result.id);
        return sendJson(res,200,{ok:true,...result});
      }
      if(routePath==='/admin/longai/video-tests/renders'&&req.method==='GET'){
        requireDatabase();
        const settings=await getProviderSettings();
        const tests=await listRenderTests(getPool());
        if(tests.some(test=>['queued','submitting','accepted'].includes(test.status)))wakeGenerationWorker(req);
        return sendJson(res,200,{ok:true,tests,paidEnabled:Boolean(settings.allowProviderCharges&&settings.longAiEnabled&&settings.longAiApiKey)});
      }
      if(routePath==='/admin/longai/video-tests/renders'&&req.method==='POST'){
        requireDatabase();
        const body=await readJson(req);
        validateRenderRequest(body);
        const replay=await findRenderTest(getPool(),body.id,body.model);
        if(replay)return sendJson(res,202,{ok:true,test:replay});
        const settings=await getProviderSettings();
        if(!settings.allowProviderCharges||!settings.longAiEnabled||!settings.longAiApiKey){
          throw httpError(409,'Enable LONG AI and paid provider submissions with a saved key first.');
        }
        const market=await loadVideoMarketplace(new LongAiClient());
        if(!market.models.some(model=>model.id===body.model&&model.sellers>0)){
          throw httpError(409,market.source==='marketplace'?'LONG AI does not currently list a seller for this video model.':
            'This model is missing from the saved LONG AI video listings. Refresh the marketplace.');
        }
        if(market.source==='snapshot'&&!verifyVideoKeyCheck(adminToken,settings.longAiApiKey,body.model,body.renderProof)){
          throw httpError(409,'The marketplace is unavailable. Check the model with the saved key before starting a paid render.');
        }
        const test=await queueRenderTest(getPool(),body,settings.longAiApiKey);
        wakeGenerationWorker(req);
        return sendJson(res,202,{ok:true,test});
      }
      if(req.method==='POST'&&routePath==='/admin/longai/import'){
        requireDatabase();
        const model=longAiMediaModel((await readJson(req)).rates);
        const settings=await getProviderSettings();
        // Saving a LONG AI key already verifies model access. Import only stores the local catalog and rates.
        if(!settings.longAiApiKey)throw httpError(400,'Save a LONG AI API key first.');
        const models=await syncProviderModels('longai',[model]);
        return sendJson(res,200,{ok:true,models});
      }
      if(req.method==='POST'&&routePath==='/admin/sluice/check'){
        requireDatabase();const s=await getProviderSettings();
        return sendJson(res,200,{ok:true,balance:await new SluiceClient({apiKey:s.sluiceApiKey}).balance()});
      }
      if(req.method==='POST'&&routePath==='/admin/vidancee/check'){
        requireDatabase();const s=await getProviderSettings();
        await new VidanceeClient({email:s.vidanceeEmail,password:s.vidanceePassword}).getJobs();
        const models=await syncProviderModels('vidancee',vidanceeMediaModels());
        return sendJson(res,200,{ok:true,models,total:models.length,ready:models.filter(m=>m.ready&&m.enabled&&m.available).length});
      }
      if(req.method==='GET'&&routePath==='/admin/aivid/status'){
        requireDatabase();
        return sendJson(res,200,{ok:true,...await require('./src/aivid_admin.js').getAividAdminService().status()});
      }
      if(req.method==='POST'&&routePath==='/admin/aivid/settings'){
        requireDatabase();
        const saved=await require('./src/aivid_admin.js').getAividAdminService().save(await readJson(req));
        return sendJson(res,200,{ok:true,...saved});
      }
      if(req.method==='POST'&&routePath==='/admin/aivid/rdp/pairing'){
        requireDatabase();
        const result=await require('./src/aivid_queue.js').withAividLock(getPool(),()=>require('./src/aivid_rdp_http.js').service().createPairing());
        if(!result)return sendJson(res,409,{ok:false,error:'The AIVID browser is busy. Try pairing after its current operation.'});
        return sendJson(res,200,{ok:true,...result});
      }
      if(req.method==='POST'&&routePath==='/admin/aivid/login'){
        requireDatabase();
        const body=await readJson(req);
        if(body.replaceSession!==undefined&&typeof body.replaceSession!=='boolean')throw httpError(400,'Invalid session replacement option.');
        const login=await require('./src/aivid_admin.js').getAividAdminService().startLogin({replaceSession:body.replaceSession===true});
        return sendJson(res,200,{ok:true,login});
      }
      const aividLogin=routePath.match(/^\/admin\/aivid\/login\/([0-9a-f-]{36})(?:\/(finish|cancel))?$/i);
      if(aividLogin){
        requireDatabase();
        const service=require('./src/aivid_admin.js').getAividAdminService();
        if(req.method==='GET'&&!aividLogin[2])return sendJson(res,200,{ok:true,login:await service.loginStatus(aividLogin[1])});
        if(req.method==='POST'&&aividLogin[2])return sendJson(res,200,{ok:true,...await service.requestAction(aividLogin[1],aividLogin[2])});
        return sendJson(res,405,{ok:false,error:'Method not allowed.'});
      }
      if(req.method==='POST'&&routePath==='/admin/aivid/check'){
        requireDatabase();
        const body=await readJson(req);
        const {DEFAULT_ID,aividModel,assertOptions}=require('./src/aivid_models.js');
        const value=assertOptions(aividModel(body.model||DEFAULT_ID),{
          prompt:'A quiet river at dawn',duration:body.duration??4,
          aspectRatio:body.aspectRatio||'16:9',resolution:body.resolution||'480p'});
        const config=await require('./src/aivid_settings.js').getAividSettings();
        if(config.mode==='rdp'?!config.rdpDevice?.tokenHash:!config.connectUrl)return sendJson(res,503,{ok:false,error:'Configure the AIVID browser connection first.'});
        const {withAividLock}=require('./src/aivid_queue.js');
        // Read-only: no Generate click, wallet debit or provider catalog sync.
        const Client=config.mode==='rdp'?require('./src/aivid_rdp.js').AividRdpClient:require('./src/provider/aivid.js').AividBrowserlessClient;
        const result=await withAividLock(getPool(),()=>new Client(config)
          .preflight(value));
        if(!result)return sendJson(res,409,{ok:false,error:'The AIVID browser is busy with another operation. Keep AIVID-Agent.exe running and retry shortly; your existing video is preserved.'});
        const sourceCredits=Number(result.price);
        const {aividBaseCredits,aividSourceUsd}=require('./src/aivid_pricing.js');
        return sendJson(res,200,{ok:true,...result,model:value.model,duration:value.duration,
          resolution:value.resolution,aspectRatio:value.aspectRatio,
          modelVerified:result.ready===true&&result.submitted===false&&result.modelId===value.model&&
            result.duration===value.duration&&result.resolution===value.resolution&&result.aspectRatio===value.aspectRatio,
          withinLimit:Number.isFinite(sourceCredits)&&sourceCredits>0&&sourceCredits<=config.maxSourceCredits,
          sourceUsd:aividSourceUsd(sourceCredits),standardCustomerCredits:applyPriceRate(aividBaseCredits(sourceCredits),priceRate(null))});
      }
      if(req.method==='POST'&&routePath==='/admin/aivid/check-references'){
        requireDatabase();
        const body=await readJson(req),{DEFAULT_ID,aividModel,assertOptions}=require('./src/aivid_models.js');
        const {diagnosticReferences,diagnosticImageReferences}=require('./src/aivid_probe_assets.js');
        const imageOnly=body.imageOnly===true;
        const prompt=imageOnly?'Create an ad using these three images.':'A blue square moves slowly. Use @image1, @video1 and the tone in @audio1.';
        const value=assertOptions(aividModel(body.model||DEFAULT_ID),{prompt,duration:imageOnly?15:5,resolution:'480p',aspectRatio:'16:9'});
        const config=await require('./src/aivid_settings.js').getAividSettings();
        if(config.mode==='rdp'?!config.rdpDevice?.tokenHash:!config.connectUrl)throw httpError(503,'Configure the AIVID browser connection first.');
        const Client=config.mode==='rdp'?require('./src/aivid_rdp.js').AividRdpClient:require('./src/provider/aivid.js').AividBrowserlessClient;
        const result=await require('./src/aivid_queue.js').withAividLock(getPool(),()=>new Client(config).checkReferences(value,imageOnly?diagnosticImageReferences():diagnosticReferences()));
        if(!result)throw httpError(409,'The AIVID browser is busy.');
        return sendJson(res,200,{ok:true,...result});
      }
      if (req.method === 'GET' && routePath === '/admin/aivid/manual/extension') {
        const zip = new (require('yazl').ZipFile)();
        for (const name of ['manifest.json','popup.html','popup.js','fill.js']) {
          zip.addFile(path.join(__dirname,'scripts','aivid-handoff-extension',name),name);
        }
        zip.on('error', error => res.destroy(error));
        res.writeHead(200, {'content-type':'application/zip','cache-control':'no-store',
          'content-disposition':'attachment; filename="cmmtools-aivid-handoff.zip"'});
        zip.outputStream.pipe(res);
        zip.end();
        return;
      }
      const manualAction = routePath.match(/^\/admin\/aivid\/generations\/([0-9a-f-]{36})\/(copy-request|deliver-video)$/);
      if (req.method === 'POST' && manualAction) {
        requireDatabase();
        const {copyRequest, readMp4, deliverVideo} = require('./src/aivid_manual.js');
        const id = manualAction[1];
        if (manualAction[2] === 'copy-request') return sendJson(res, 200, {ok:true,...await copyRequest(getPool(),adminToken,id)});
        const result = await deliverVideo(getPool(), id, await readMp4(req));
        return sendJson(res, 200, {ok:true,...result});
      }
      const aividManage=routePath.match(/^\/admin\/aivid\/generations\/([0-9a-f-]{36})\/(cancel|delete)$/i);
      if(req.method==='POST'&&aividManage){
        requireDatabase();
        const result=await require('./src/aivid_queue.js').manageAividJob(getPool(),aividManage[1],aividManage[2].toLowerCase());
        logActivity({category:'admin',event:'aivid.'+aividManage[2],provider:'aivid',generationId:aividManage[1],message:'Admin '+aividManage[2]+' video job.'});
        return sendJson(res,200,{ok:true,...result});
      }
      const aividReconcile=routePath.match(/^\/admin\/aivid\/generations\/([0-9a-f-]{36})\/reconcile$/i);
      if(req.method==='POST'&&aividReconcile){
        requireDatabase();
        const result=await require('./src/aivid_queue.js').reconcileAivid(getPool(),aividReconcile[1],await readJson(req));
        if(result.collectionQueued){
          wakeGenerationWorker(req);
          logActivity({category:'aivid',event:'aivid.collection_retry_queued',provider:'aivid',generationId:aividReconcile[1],
            message:'Collection retry queued for the existing video.',details:{providerJobId:result.providerJobId}});
        }else{
          logActivity({category:'admin',event:'aivid.reconciled',provider:'aivid',generationId:aividReconcile[1],message:'Owner reconciled held submission against account history.'});
        }
        return sendJson(res,200,{ok:true,...result});
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
        const previous=await getProviderSettings();
        const settings=await updateProviderSettings(body);
        // Import the account-specific catalog when the 888API key is saved or
        // its source is first enabled. Without this import the bundled
        // documented models stay unavailable by design and Studio looks empty.
        // Saving unrelated provider settings does not trigger another sync.
        let api888Sync=null;
        const saved888Key=typeof body.api888ApiKey==='string'&&body.api888ApiKey.trim().length>0;
        const activated888=body.api888Enabled===true&&!previous.api888Enabled;
        if(saved888Key||activated888){
          const latest=await getProviderSettings();
          if(latest.api888ApiKey){
            try {
              const live=await new Api888Client({apiKey:latest.api888ApiKey}).catalog();
              const models=await syncProviderModels('api888',api888MediaModels(live));
              api888Sync={ok:true,total:models.length,
                ready:models.filter(m=>m.ready&&m.enabled&&m.available).length};
              logActivity({category:'admin',event:'api888.models_synced',provider:'api888',
                message:'888API live catalog imported after provider settings update',
                details:{total:api888Sync.total,ready:api888Sync.ready}});
            }catch(error){
              api888Sync={ok:false,error:error.message};
              logActivity({level:'error',category:'admin',event:'api888.sync_failed',provider:'api888',
                message:'888API catalog sync failed after provider settings update',
                details:{error:String(error.message||'error').slice(0,300)}});
            }
          }
        }
        // Keys and passwords are masked by the activity log.
        logActivity({category:'admin',event:'settings.saved',message:'Provider settings saved',details:{changes:{...body,...(body.wxksaiApiKey?{wxksaiApiKey:'[REDACTED]'}:{})}}});
        // A new Higgsfield key: read Wan 3.0's prices right away, so the model appears.
        let higgsfieldSync=null;
        if(String(body.higgsfieldApiKey||'').trim()){
          try{const r=await syncHiggsfieldPrices();higgsfieldSync={ok:true,ready:r.models.some(m=>m.ready)};}
          catch(error){higgsfieldSync={ok:false,error:error.message};}
        }
        return sendJson(res,200,{ok:true,settings,higgsfieldSync,api888Sync});
      }

      if (req.method==='GET' && routePath==='/admin/provider-models') {
        requireDatabase();
        const provider=String(url.searchParams.get('provider')||'vercel');
        if (!['vercel','argolink','higgsfield','sluice','vidancee','api888','longai','wxksai'].includes(provider)) return sendJson(res,400,{ok:false,error:'Unsupported provider.'});
        let models=await listProviderModels(provider);
        if(provider==='api888'){
          const health=await loadApi888Health().catch(()=>null);
          models=models.map(model=>({...model,upstreamStatus:health?.statuses?.[model.providerModelId]||'unknown',
            upstreamAvailable:isApi888Available(health,model.providerModelId)}));
        }
        return sendJson(res,200,{ok:true,models});
      }

      const providerModelMatch=routePath.match(/^\/admin\/provider-models\/(\d+)$/);
      if (req.method==='POST' && providerModelMatch) {
        requireDatabase();
        const body=await readJson(req);
        const provider=String(body.provider||'vercel');
        if(!['vercel','argolink','higgsfield','sluice','vidancee','wxksai'].includes(provider))return sendJson(res,400,{ok:false,error:'Unsupported provider.'});
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
            longai:providerSettings.longai.enabled,
            sluice:providerSettings.sluice.enabled,
            vidancee:providerSettings.vidancee.enabled,
            fal:providerSettings.fal.enabled,
          },
          providerActive:{
            vgenv:providerSettings.vgenv.active,
            vibi:providerSettings.vibi.active,
            smartaipi:providerSettings.smartaipi.active,
            vercel:providerSettings.vercel.active,
            argolink:providerSettings.argolink.active,
            higgsfield:providerSettings.higgsfield.active,
            longai:providerSettings.longai.active,
            sluice:providerSettings.sluice.active,
            vidancee:providerSettings.vidancee.active,
            fal:providerSettings.fal.active,
          },
          vgenvMaxInflight:providerSettings.vgenv.maxInflight,
          vibiMaxInflight:providerSettings.vibi.maxInflight,
          smartAipiMaxInflight:providerSettings.smartaipi.maxInflight,
          vercelMaxInflight:providerSettings.vercel.maxInflight,
          argoLinkMaxInflight:providerSettings.argolink.maxInflight,
          higgsfieldMaxInflight:providerSettings.higgsfield.maxInflight,
          sluiceMaxInflight:providerSettings.sluice.maxInflight,
          vidanceeMaxInflight:providerSettings.vidancee.maxInflight,
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
          'SELECT id,email,credits,plan_code,price_rate,role,status,created_at,updated_at FROM users'+where+' ORDER BY created_at DESC LIMIT 200',
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
          price_rate:customerRate(row),
          provider_access:accessByUser.get(Number(row.id))||defaultCustomerProviderAccess(),
        }))});
      }

      if (req.method==='GET' && routePath==='/admin/plans') return sendJson(res,200,{ok:true,plans:adminPlanOptions()});

      const userGenerationCleanupMatch=routePath.match(/^\/admin\/users\/(\d+)\/cleanup-generations$/);
      if(userGenerationCleanupMatch&&(req.method==='GET'||req.method==='POST')){
        requireDatabase();
        const userId=Number(userGenerationCleanupMatch[1]);
        const cleanup=require('./src/admin_generation_cleanup.js');
        if(req.method==='GET')
          return sendJson(res,200,{ok:true,...await cleanup.userGenerationCleanupPreview(userId)});
        const body=await readJson(req);
        const result=await cleanup.deleteFinishedUserGenerations(userId,body.confirmEmail);
        logActivity({category:'admin',event:'user.generations_cleaned',userId,
          message:'Finished generation cleanup batch for an explicitly confirmed customer.',
          details:{deleted:result.deleted,remaining:result.remaining,protected:result.protected,stopped:!result.ok}});
        return sendJson(res,200,result);
      }

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

      // Boosted pricing: the customer is shown and charged every price x
      // 60000/42000, so a 60,000-credit balance buys 42,000 credits of usage.
      const userPriceRateMatch=routePath.match(/^\/admin\/users\/(\d+)\/price-rate$/);
      if (req.method==='POST' && userPriceRateMatch) {
        requireDatabase();
        const body=await readJson(req);
        const userId=Number(userPriceRateMatch[1]),rate=body.boosted===true?BOOSTED_PRICE_RATE:1;
        const [result]=await getPool().execute('UPDATE users SET price_rate=?,updated_at=UTC_TIMESTAMP() WHERE id=?',[rate,userId]);
        if(!result.affectedRows)return sendJson(res,404,{ok:false,error:'User not found.'});
        logActivity({category:'admin',event:'user.price_rate_changed',userId,message:rate===1?'Boosted pricing off':'Boosted pricing on (x'+rate.toFixed(4)+')'});
        return sendJson(res,200,{ok:true,price_rate:rate});
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

      const inputsMatch=routePath.match(/^\/admin\/generations\/([0-9a-f-]{36})\/inputs$/i);
      if (req.method==='GET' && inputsMatch) {
        requireDatabase();
        return sendJson(res,200,{ok:true,inputs:await adminGenerationInputs(getPool(),adminToken,inputsMatch[1])});
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
             g.error_message,g.provider_operation,g.submitted_at,g.started_at,g.completed_at,g.refunded_at,g.created_at,g.updated_at,g.generation_options,
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
          manualHandoff:row.provider==='aivid'?require('./src/aivid_manual.js').activeStage(row):null,
          collectionPaused:row.provider==='aivid'&&require('./src/aivid_queue.js').operation(row).collectionPaused===true,
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
server.on('close',()=>require('./src/aivid_admin.js').stopAividAdmin().catch(()=>{}));


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
  require('./src/aivid_admin.js').stopAividAdmin().catch(()=>{});
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
      await require('./src/api888_access.js').disableApi888ForUsersOnce(getPool());
      await require('./src/api888_access.js').enableDefaultApi888ModelsOnce(getPool()).catch(error=>console.error('888API default-on models failed:',error.message));
      refreshStorageCspOrigin();setInterval(refreshStorageCspOrigin,5*60*1000).unref();
      // Buckets connected before direct uploads existed get their CORS rule now.
      if(await getSettingValue('r2_cors_ok','').catch(()=>'')!=='true')enableBrowserUploads().catch(()=>{});
      if (migrated) console.log('Legacy provider settings migrated into Admin-managed storage.');
      await enableVoiceForCustomersOnce().catch(error=>console.error('Voice access default failed:',error.message));
      await enableHiggsfieldForCustomersOnce().catch(error=>console.error('Higgsfield access for all failed:',error.message));
      await enableVgenvForCustomersOnce().catch(error=>console.error('vgenv access for all failed:',error.message));
      await enableApi888ForCustomersOnce().catch(error=>console.error('888API access for all failed:',error.message));
      await enableDopeForCustomersOnce().catch(error=>console.error('Dope access for all failed:',error.message));
      await ensureGatewayCatalog().catch(error=>console.error('Gateway catalog initialization failed:',error.message));
      await ensureArgoCatalog().catch(error=>console.error('ArgoLink catalog initialization failed:',error.message));
      await ensureApi888Catalog().catch(error=>console.error('888API catalog initialization failed:',error.message));
      await ensureHiggsfieldCatalog().catch(error=>console.error('Higgsfield catalog initialization failed:',error.message));
      await ensureSluiceCatalog(()=>fetchSluiceCatalog()).catch(error=>console.error('Sluice catalog initialization failed:',error.message));
      await ensureVidanceeCatalog().catch(error=>console.error('Vidancee catalog initialization failed:',error.message));
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





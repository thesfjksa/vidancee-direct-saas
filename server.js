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
const path = require('node:path');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const Busboy = require('busboy');
const { VidanceeClient } = require('./src/provider/vidancee.js');
const { SmartAipiClient, validateSmartReference } = require('./src/provider/smartaipi.js');
const { smartImageModel, smartImageQuote, publicSmartImagePricing, SMART_IMAGE_REFS, SMART_IMAGE_MODELS } = require('./src/smartaipi_images.js');
const { VibiClient } = require('./src/provider/vibi.js');
const { GeminiPromptEnhancer, PromptEnhancementGate, PromptEnhancementJobs, ENHANCEMENT_TIMEOUT_MS, normalizeEnhancement } = require('./src/prompt_enhancer.js');
const promptEnhancementGate = new PromptEnhancementGate();
const promptEnhancementJobs = new PromptEnhancementJobs({gate:promptEnhancementGate});
const { WorkerWakeup } = require('./src/worker_wakeup.js');
const workerWakeup = new WorkerWakeup({url:process.env.WORKER_WAKE_URL ?? 'https://worker.mehroz.online/live'});
function wakeGenerationWorker(req) {
  const host=String(req.headers.host||'').toLowerCase().split(':')[0];
  // The default belongs only to this production deployment; other deployments
  // must explicitly configure their own standalone worker's health endpoint.
  const origin=String(process.env.APP_URL||'').toLowerCase().replace(/\/$/,'');
  if(process.env.WORKER_WAKE_URL===undefined && host!=='ai.mehroz.online' && origin!=='https://ai.mehroz.online')return;
  void workerWakeup.wake().then(result=>{
    if(!result.ok&&!result.skipped)console.warn('[worker-wakeup]',result.error);
  });
}
const { dbConfigured, getPool, initDb, dbHealth } = require('./src/db.js');
const {
  normalizeEmail, validateEmail, hashPassword, verifyPassword,
  createSession, destroySession, userFromRequest, requireUser,
} = require('./src/auth.js');
const { publicPricing, ASPECT_RATIOS } = require('./src/pricing.js');
const { publicImagePricing, IMAGE_ASPECT_RATIOS } = require('./src/image_pricing.js');
const { creditMultiplier, roundCredits, sourceToCustomerCredits } = require('./src/billing.js');
const {
  publicPlans,
  getPlanStatus,
  createPlanRequest,
  listPlanRequests,
  decidePlanRequest,
} = require('./src/plans.js');
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
} = require('./src/settings.js');
const { verifyAssetSignature } = require('./src/provider/assets.js');
const { VercelGatewayClient } = require('./src/provider/vercel.js');
const { isGatewayModel, mediaModels, quoteGateway, validateReferences } = require('./src/vercel_models.js');
const { serveVideoOutput } = require('./src/video_outputs.js');
const {
  publicProviderCatalog,
  listProviderModels,
  getProviderModelByPublicId,
  setProviderModelEnabled,
  syncProviderModels, setGatewayPrice, ensureGatewayCatalog,
} = require('./src/provider_models.js');
const {
  beginHiggsfieldAuthorization,
  finishHiggsfieldAuthorization,
  clearHiggsfieldAuth,
  syncHiggsfieldModels,
  getHiggsfieldConnectionStatus,
  getHiggsfieldToolDiagnostics,
  estimateHiggsfieldCost,
} = require('./src/provider/higgsfield_mcp.js');

const customerPage = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const adminPage = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
const allowSignups = !/^(0|false|no|off)$/i.test(String(process.env.ALLOW_SIGNUPS || 'yes'));
const startingCredits = Math.max(0, Number(process.env.STARTING_CREDITS || 0));

if (!adminToken) console.warn('ADMIN_TOKEN is not configured. Admin routes will be unavailable.');

function vibiClient(settings) {
  return new VibiClient({baseUrl:settings.vibiBaseUrl,apiKey:settings.vibiApiKey});
}

async function providerClient() {
  const settings = await getProviderSettings();
  if (!settings.vidanceeEmail || !settings.vidanceePassword) {
    const error = new Error('Primary provider credentials are not configured in the Admin dashboard.');
    error.statusCode = 503;
    throw error;
  }
  return new VidanceeClient({
    baseUrl: settings.vidanceeBaseUrl,
    email: settings.vidanceeEmail,
    password: settings.vidanceePassword,
  });
}

function sendJson(res, status, body) {
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
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'",
  });
  res.end(body);
}
function publicOrigin(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
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
      if(!isImage && !isVideo){ file.resume(); return; }

      const mimeType=String(info.mimeType||'').toLowerCase();
      if(isImage && !['image/jpeg','image/png','image/webp'].includes(mimeType)){
        file.resume(); return fail('Images must be JPEG, PNG, or WebP.');
      }
      if(isVideo && !['video/mp4','video/webm','video/quicktime'].includes(mimeType)){
        file.resume(); return fail('Video references must be MP4, WebM, or MOV.');
      }

      const chunks=[]; let bytes=0;
      file.on('data',(chunk)=>{
        bytes+=chunk.length; totalBytes+=chunk.length;
        if(totalBytes>100*1024*1024) fail('Combined reference upload is too large.',413);
        if(isImage && bytes>10*1024*1024) fail('Each image must be 10 MB or smaller.',413);
        if(!settled) chunks.push(chunk);
      });
      file.on('limit',()=>fail(isVideo?'Each video reference must be 25 MB or smaller.':'Each image must be 10 MB or smaller.',413));
      file.on('end',()=>{
        if(settled || bytes<=0)return;
        const item={
          filename:String(info.filename||(isVideo?'reference-video':'reference-image')).slice(0,255),
          mimeType,
          data:Buffer.concat(chunks),
        };
        if(isImage)images.push(item);
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
function dynamicModelSupportsImageReferences(model) {
  const cap=model?.referenceCapabilities?.image;
  if(cap && typeof cap==='object') return cap.supported===true || Number(cap.max||0)>0;
  const roles=Array.isArray(model?.mediaRoles)?model.mediaRoles:[];
  if(model?.mediaType==='image') return roles.some(role=>['image','input_images','image_references'].includes(String(role)));
  return roles.some(role=>['image','start_image','end_image','input_images','image_references'].includes(String(role)));
}

function dynamicModelSupportsVideoReferences(model) {
  const cap=model?.referenceCapabilities?.video;
  if(cap && typeof cap==='object') return cap.supported===true || Number(cap.max||0)>0;
  const roles=Array.isArray(model?.mediaRoles)?model.mediaRoles:[];
  return roles.some(role=>['video','video_references','input_videos','reference_video'].includes(String(role)));
}

const CUSTOMER_PROVIDER_KEYS=['vidancee','createpulse','atlascloud','vgenv','higgsfield','vibi','smartaipi','vercel'];
function defaultCustomerProviderAccess(){
  const access=Object.fromEntries(CUSTOMER_PROVIDER_KEYS.map(key=>[key,true]));
  access.vibi=false;
  return access;
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
async function proxyMedia(req,res,row,type) {
  const target = type === 'poster' ? row.poster_url : row.output_url;
  if (!target) return sendJson(res,404,{ok:false,error:'Media not available.'});

  const headers={};
  if (req.headers.range) headers.range=req.headers.range;
  const upstream=await fetch(target,{headers,redirect:'follow'});
  if (!upstream.ok && upstream.status !== 206) {
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
  const { Readable } = require('node:stream');
  Readable.fromWeb(upstream.body).pipe(res);
}

const server=http.createServer(async (req,res)=>{
  const url=new URL(req.url||'/', 'http://' + (req.headers.host||'localhost'));
  const routePath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  try {
    const studioAssets={
      '/brand.css':['brand.css','text/css; charset=utf-8'],
      '/studio.css':['studio.css','text/css; charset=utf-8'],
      '/admin.css':['admin.css','text/css; charset=utf-8'],
      '/assets/cmmtools-logo.png':['assets/cmmtools-logo.png','image/png'],
      '/assets/cmmtools-icon.png':['assets/cmmtools-icon.png','image/png'],
      '/favicon.ico':['assets/cmmtools-icon.png','image/png'],
      '/assets/fonts/inter-latin-wght.woff2':['assets/fonts/inter-latin-wght.woff2','font/woff2'],
    };
    if ((req.method==='GET'||req.method==='HEAD') && studioAssets[routePath]) {
      const [file,contentType]=studioAssets[routePath];
      const data=fs.readFileSync(path.join(__dirname,'public',file));
      res.writeHead(200,{'content-type':contentType,'content-length':data.length,'cache-control':'public, max-age=3600','x-content-type-options':'nosniff'});
      return res.end(req.method==='HEAD'?undefined:data);
    }
    if (req.method==='GET' && routePath==='/') return sendHtml(res,200,customerPage);
    if (req.method==='GET' && routePath==='/admin-console') return sendHtml(res,200,adminPage);

    if (req.method==='GET' && routePath==='/admin/higgsfield/oauth/callback') {
      requireDatabase();
      try {
        const callbackUrl=publicOrigin(req)+'/admin/higgsfield/oauth/callback';
        await finishHiggsfieldAuthorization({params:url.searchParams,redirectUrl:callbackUrl});
        let syncMessage='Your account is connected.';
        try {
          const synced=await syncHiggsfieldModels();
          syncMessage='Connected and synced '+synced.modelCount+' available models.';
        } catch(syncError) {
          console.error('Initial Higgsfield model sync failed:',syncError?.message||syncError);
          syncMessage='Connected successfully. If models do not appear yet, use Sync models in Admin.';
        }
        return sendHtml(res,200,`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=/admin-console?higgsfield=connected"><title>Connected</title></head><body style="font-family:system-ui;background:#0b0c0f;color:#fff;padding:40px"><h2>Account connected</h2><p>${syncMessage}</p></body></html>`);
      } catch(error) {
        console.error('Higgsfield OAuth callback failed:',error?.message||error);
        return sendHtml(res,400,`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=/admin-console?higgsfield=failed"><title>Connection failed</title></head><body style="font-family:system-ui;background:#0b0c0f;color:#fff;padding:40px"><h2>Connection failed</h2><p>Return to Admin and start the connection again.</p></body></html>`);
      }
    }

    const providerAssetMatch=routePath.match(/^\/provider-assets\/([0-9a-f-]{36})\/(\d+)$/i);
    if (req.method==='GET' && providerAssetMatch) {
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
      return res.end(image.image_data);
    }

    const providerMediaMatch=routePath.match(/^\/provider-media\/([0-9a-f-]{36})\/(\d+)$/i);
    if(req.method==='GET'&&providerMediaMatch){
      requireDatabase();
      const id=providerMediaMatch[1],position=Number(providerMediaMatch[2]);
      if(!verifyAssetSignature(id,position,String(url.searchParams.get('sig')||'')))return sendJson(res,403,{ok:false,error:'Invalid provider asset signature.'});
      const [[media]]=await getPool().execute('SELECT mime_type,media_data FROM generation_media WHERE generation_id=? AND position_index=? LIMIT 1',[id,position]);
      if(!media)return sendJson(res,404,{ok:false,error:'Provider asset not found.'});
      res.writeHead(200,{'content-type':media.mime_type,'content-length':media.media_data.length,'cache-control':'private, max-age=300','x-content-type-options':'nosniff'});
      return res.end(media.media_data);
    }

    if (req.method==='GET' && routePath==='/live') {
      return sendJson(res,200,{
        ok:true,
        app:'mehroz-ai',
        startedAt:new Date(PROCESS_STARTED_AT).toISOString(),
        runtime:runtimeSnapshot(),
      });
    }

    if (req.method==='GET' && routePath==='/health') {
      const database=await dbHealth();
      let generationBackendReady=false;
      let generationEnabled=false;
      let imageGenerationReady=false;
      if (database.connected) {
        const providerSettings=await getAdminProviderSettings();
        let higgsfieldImageReady=false;
        if (providerSettings.higgsfield.active) {
          try {
            const catalog=await publicProviderCatalog('higgsfield');
            higgsfieldImageReady=catalog.image.length>0;
          } catch {}
        }
        generationBackendReady=Boolean(
          providerSettings.vidancee.active ||
          providerSettings.createpulse.active ||
          providerSettings.vgenv.active ||
          providerSettings.atlascloud.active ||
          providerSettings.higgsfield.active ||
          providerSettings.vibi.active || providerSettings.smartaipi.active || providerSettings.vercel.active
        );
        imageGenerationReady=Boolean(providerSettings.vercel.active || providerSettings.atlascloud.active || higgsfieldImageReady || (providerSettings.smartaipi.active && providerSettings.smartaipi.models.some(m=>m.enabled && Object.values(m.qualitySourceUsd).some(n=>n>0))));
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
        runtime:runtimeSnapshot(),
      });
    }

    if (req.method==='GET' && routePath==='/api/config') {
      let videoPricing=publicPricing();
      let imagePricing=publicImagePricing();
      let voiceConfig={enabled:false};
      let promptEnhancerConfig={enabled:false,maxPromptChars:8000,revision:5,async:true,timeoutMs:ENHANCEMENT_TIMEOUT_MS};
      let customerProviderAccess=defaultCustomerProviderAccess();

      if (dbConfigured()) {
        try {
          const currentUser=await userFromRequest(req);
          if(currentUser)customerProviderAccess=await getUserProviderAccess(currentUser.id);
          const providerSettings=await getAdminProviderSettings();
          promptEnhancerConfig.enabled=Boolean(currentUser?.status==='active' && providerSettings.promptEnhancer.active);
          const seedanceFallbackActive=Boolean(
            (customerProviderAccess.vidancee && providerSettings.vidancee.active) ||
            (customerProviderAccess.createpulse && providerSettings.createpulse.active)
          );
          const h3FallbackActive=Boolean(customerProviderAccess.vgenv && providerSettings.vgenv.active);

          videoPricing=videoPricing.filter(model=>{
            if (model.id==='minimax_h3') return h3FallbackActive;
            if (model.id==='seedance_2.5' || model.id==='seedance_2.0_fast') return seedanceFallbackActive;
            return true;
          });

          if (!customerProviderAccess.atlascloud || !providerSettings.atlascloud.active) imagePricing=[];

          if (customerProviderAccess.smartaipi && providerSettings.smartaipi.active) {
            imagePricing.push(...publicSmartImagePricing(await getProviderSettings()));
          }

          if(customerProviderAccess.vercel && providerSettings.vercel.active){
            const catalog=await publicProviderCatalog('vercel');
            videoPricing.push(...catalog.video);imagePricing.push(...catalog.image);
          }

          if (customerProviderAccess.vibi && providerSettings.vibi.active) {
            voiceConfig={enabled:true,cloningAvailable:true,maxTextChars:10000,cloneMaxBytes:20*1024*1024};
          }

          if (customerProviderAccess.higgsfield && providerSettings.higgsfield.active) {
            const catalog=await publicProviderCatalog('higgsfield');
            const mergeById=(base,extra)=>{
              const out=[...base];
              for(const item of extra){
                const index=out.findIndex(existing=>existing.id===item.id);
                if(index>=0)out[index]=item;
                else out.push(item);
              }
              return out;
            };
            videoPricing=mergeById(videoPricing,catalog.video);
            imagePricing=mergeById(imagePricing,catalog.image);
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
        plans:publicPlans(),
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
        const job=promptEnhancementJobs.start(user.id,body,()=>new GeminiPromptEnhancer({apiKey:settings.promptEnhancerApiKey}).enhance(body));
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
      const costAccess=await getUserProviderAccess(costUser.id);
      const body=await readJson(req);
      const mediaType=body.mediaType==='image'?'image':'video';
      const providerSettings=await getAdminProviderSettings();
      if(isGatewayModel(body.model)){
        if(!costAccess.vercel||!providerSettings.vercel.active)return sendJson(res,403,{ok:false,error:'This model source is unavailable for your account.'});
        const model=await getProviderModelByPublicId('vercel',String(body.model),mediaType);
        if(!model?.ready)return sendJson(res,404,{ok:false,error:'This model is currently unavailable.'});
        const quote=quoteGateway(model,body,providerSettings.vercel.customerCreditsPerUsd);
        return sendJson(res,200,{ok:true,cost:quote.cost,isEstimate:quote.isEstimate});
      }
      if (!costAccess.higgsfield || !providerSettings.higgsfield.active) {
        return sendJson(res,403,{ok:false,error:'This model source is not assigned to your account.'});
      }

      const model=await getProviderModelByPublicId('higgsfield',String(body.model||''),mediaType);
      if (!model) return sendJson(res,404,{ok:false,error:'Live pricing is unavailable for this model.'});

      const sourceCost=await estimateHiggsfieldCost(model.publicModelId,mediaType,{
        prompt:String(body.prompt||'Cost estimate'),
        duration:Number(body.duration||0),
        resolution:String(body.resolution||''),
        aspectRatio:String(body.aspectRatio||body.aspect_ratio||''),
        mode:mediaType==='image'?'text-to-image':'text-to-video',
      });
      const customerCost=roundCredits(sourceCost);
      if (!Number.isFinite(Number(customerCost)) || Number(customerCost)<0) {
        return sendJson(res,502,{ok:false,error:'The model cost could not be calculated.'});
      }
      return sendJson(res,200,{ok:true,cost:Number(customerCost)});
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
    if (req.method==='DELETE' && voiceGenMatch) {
      requireDatabase();const user=await requireUser(req);
      await deleteUserVoiceGeneration(user.id,voiceGenMatch[1]);
      return sendJson(res,200,{ok:true,deleted:true,id:voiceGenMatch[1]});
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
      const providerSettings=await getProviderSettings();
      if (!providerSettings.allowProviderCharges) {
        return sendJson(res,503,{ok:false,error:'Generation submissions are currently paused.'});
      }

      const body=await readGenerationRequest(req);
      const requestedModel=String(body.model||'');
      const customerAccess=await getUserProviderAccess(user.id);
      let generation=null;

      if(isGatewayModel(requestedModel)){
        if(!customerAccess.vercel||!providerSettings.vercelEnabled||!providerSettings.vercelApiKey)return sendJson(res,503,{ok:false,error:'This image model is currently unavailable.'});
        const model=await getProviderModelByPublicId('vercel',requestedModel,'image');
        if(!model?.ready)return sendJson(res,404,{ok:false,error:'This image model is currently unavailable.'});
        validateReferences(model,body);
        const quote=quoteGateway(model,body,providerSettings.vercelCustomerCreditsPerUsd);
        generation=await createImageGenerationForUser(user.id,{...body,aspectRatio:quote.aspectRatio},{
          provider:'vercel',dynamicModel:true,referenceCapabilities:model.referenceCapabilities,
          costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd-estimate',imageQuality:quote.quality,
          generationOptions:{...quote,model},
        });
      }

      if (smartImageModel(requestedModel)) {
        if (!customerAccess.smartaipi || !providerSettings.smartAipiEnabled || !providerSettings.smartAipiApiKey) {
          return sendJson(res,503,{ok:false,error:'This image model is currently unavailable.'});
        }
        const quote=smartImageQuote(requestedModel,String(body.aspectRatio||body.aspect_ratio||''),providerSettings,body.quality??'medium');
        for(const image of (Array.isArray(body.images)?body.images:[]))validateSmartReference(image?.data);
        generation=await createImageGenerationForUser(user.id,body,{
          provider:'smartaipi',dynamicModel:true,referenceCapabilities:SMART_IMAGE_REFS,
          costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd-estimate',imageQuality:quote.quality,
        });
      }

      if (!generation && customerAccess.higgsfield && providerSettings.higgsfieldEnabled && providerSettings.higgsfieldOauthTokens) {
        const dynamicModel=await getProviderModelByPublicId('higgsfield',requestedModel,'image');
        if (dynamicModel) {
          if (Array.isArray(body.images) && body.images.length && !dynamicModelSupportsImageReferences(dynamicModel)) {
            return sendJson(res,400,{ok:false,error:'This image model does not accept reference images.'});
          }
          const sourceCost=await estimateHiggsfieldCost(dynamicModel.publicModelId,'image',{
            prompt:String(body.prompt||''),
            aspectRatio:String(body.aspectRatio||body.aspect_ratio||''),
            mode:Array.isArray(body.images)&&body.images.length?'reference-to-image':'text-to-image',
          });
          const customerCost=roundCredits(sourceCost);
          generation=await createImageGenerationForUser(user.id,body,{
            provider:'higgsfield',
            dynamicModel:true,
            referenceCapabilities:dynamicModel.referenceCapabilities,
            costOverride:customerCost,
            providerCost:sourceCost,
            providerCostUnit:'credits',
          });
        }
      }

      if (!generation) {
        if (!customerAccess.atlascloud || !providerSettings.atlasCloudEnabled || !providerSettings.atlasCloudApiKey) {
          return sendJson(res,503,{ok:false,error:'Image generation is currently unavailable.'});
        }
        generation=await createImageGenerationForUser(user.id,body);
      }

      wakeGenerationWorker(req);
      const db=getPool();
      const [users]=await db.execute('SELECT * FROM users WHERE id=?',[user.id]);
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

    if (req.method==='DELETE' && imageGenMatch) {
      requireDatabase();
      const user=await requireUser(req);
      await deleteUserImageGeneration(user.id,imageGenMatch[1]);
      return sendJson(res,200,{ok:true,deleted:true,id:imageGenMatch[1]});
    }

    const imageMediaMatch=routePath.match(/^\/api\/image-generations\/([0-9a-f-]{36})\/media$/i);
    if (req.method==='GET' && imageMediaMatch) {
      requireDatabase();
      const user=await requireUser(req);
      const row=await getUserImageGeneration(user.id,imageMediaMatch[1]);
      if (!row) return sendJson(res,404,{ok:false,error:'Image generation not found.'});
      if (row.output_url==='db:image') {
        const [outputs]=await getPool().execute('SELECT mime_type,image_data FROM generation_image_outputs WHERE generation_id=?',[row.id]);
        const output=outputs[0];
        if(!output)return sendJson(res,404,{ok:false,error:'Generated image is unavailable.'});
        const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[output.mime_type]||'png';
        res.writeHead(200,{'content-type':output.mime_type,'content-length':output.image_data.length,
          'content-disposition':'inline; filename="cmm-tools-image-'+row.id.slice(0,8)+'.'+extension+'"',
          'cache-control':'private, max-age=3600','x-content-type-options':'nosniff'});
        return res.end(output.image_data);
      }
      return proxyMedia(req,res,row,'video');
    }

    if (req.method==='GET' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      return sendJson(res,200,{ok:true,generations:await listUserGenerations(user.id,50)});
    }

    if (req.method==='POST' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readGenerationRequest(req);
      const providerSettings=await getProviderSettings();
      if (!providerSettings.allowProviderCharges) {
        return sendJson(res,503,{ok:false,error:'Generation submissions are currently paused.'});
      }

      const requestedModel=String(body.model||'');
      const customerAccess=await getUserProviderAccess(user.id);
      let generation=null;

      if(isGatewayModel(requestedModel)){
        if(!customerAccess.vercel||!providerSettings.vercelEnabled||!providerSettings.vercelApiKey)return sendJson(res,503,{ok:false,error:'This video model is currently unavailable.'});
        const model=await getProviderModelByPublicId('vercel',requestedModel,'video');
        if(!model?.ready)return sendJson(res,404,{ok:false,error:'This video model is currently unavailable.'});
        validateReferences(model,body);
        const quote=quoteGateway(model,body,providerSettings.vercelCustomerCreditsPerUsd);
        generation=await createGenerationForUser(user.id,{...body,...quote},{provider:'vercel',dynamicModel:true,
          defaultResolution:model.defaultResolution,referenceCapabilities:model.referenceCapabilities,
          costOverride:quote.cost,providerCost:quote.sourceUsd,providerCostUnit:'usd-estimate',generationOptions:{...quote,model},
        });
      }

      if (!generation && customerAccess.higgsfield && providerSettings.higgsfieldEnabled && providerSettings.higgsfieldOauthTokens) {
        const dynamicModel=await getProviderModelByPublicId('higgsfield',requestedModel,'video');
        if (dynamicModel) {
          if (Array.isArray(body.images) && body.images.length && !dynamicModelSupportsImageReferences(dynamicModel)) {
            return sendJson(res,400,{ok:false,error:'This video model does not accept image references.'});
          }
          if (Array.isArray(body.videos) && body.videos.length && !dynamicModelSupportsVideoReferences(dynamicModel)) {
            return sendJson(res,400,{ok:false,error:'This video model does not accept video references.'});
          }
          const hasReferences=(Array.isArray(body.images)&&body.images.length)||(Array.isArray(body.videos)&&body.videos.length);
          const sourceCost=await estimateHiggsfieldCost(dynamicModel.publicModelId,'video',{
            prompt:String(body.prompt||''),
            duration:Number(body.duration||0),
            resolution:String(body.resolution||''),
            aspectRatio:String(body.aspectRatio||body.aspect_ratio||''),
            mode:hasReferences?'reference-to-video':'text-to-video',
          });
          const customerCost=roundCredits(sourceCost);
          generation=await createGenerationForUser(user.id,body,{
            provider:'higgsfield',
            dynamicModel:true,
            defaultResolution:dynamicModel.defaultResolution,
            referenceCapabilities:dynamicModel.referenceCapabilities,
            costOverride:customerCost,
            providerCost:sourceCost,
            providerCostUnit:'credits',
          });
        }
      }

      if (!generation) {
        if (requestedModel==='minimax_h3') {
          if (!customerAccess.vgenv || !providerSettings.vgenvEnabled || !providerSettings.vgenvApiKey) {
            return sendJson(res,503,{ok:false,error:'This model is currently unavailable.'});
          }
        } else if (requestedModel==='seedance_2.5' || requestedModel==='seedance_2.0_fast') {
          const vidanceeActive=Boolean(
            customerAccess.vidancee &&
            providerSettings.vidanceeEnabled &&
            providerSettings.vidanceeEmail &&
            providerSettings.vidanceePassword
          );
          const createPulseActive=Boolean(
            customerAccess.createpulse &&
            providerSettings.createPulseEnabled &&
            providerSettings.createPulseApiKey
          );
          if (!vidanceeActive && !createPulseActive) {
            return sendJson(res,503,{ok:false,error:'This model is currently unavailable.'});
          }
        }
        generation=await createGenerationForUser(user.id,body);
      }

      wakeGenerationWorker(req);
      const db=getPool();
      const [users]=await db.execute('SELECT * FROM users WHERE id=?',[user.id]);
      return sendJson(res,201,{ok:true,generation,user:userPayload(users[0])});
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

    if (req.method==='DELETE' && genMatch) {
      requireDatabase();
      const user=await requireUser(req);
      await deleteUserGeneration(user.id,genMatch[1]);
      return sendJson(res,200,{ok:true,deleted:true,id:genMatch[1]});
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
      return proxyMedia(req,res,row,type);
    }

    if (routePath.startsWith('/admin/')) {
      if (!adminToken) return sendJson(res,503,{ok:false,error:'ADMIN_TOKEN is not configured in hPanel.'});
      if (!adminAuthorized(req)) return sendJson(res,401,{ok:false,error:'Unauthorized'});

      if (req.method==='POST' && routePath==='/admin/provider/check') {
        const provider=await providerClient();
        await provider.login();
        const snapshot=await provider.getJobs(12);
        return sendJson(res,200,{ok:true,login:'OK',provider:{
          credits:snapshot.credits,reserved:snapshot.reserved,concurrency:snapshot.concurrency,
          processing:snapshot.processing,activeCount:Array.isArray(snapshot.active)?snapshot.active.length:0,
          returnedHistoryCount:Array.isArray(snapshot.jobs)?snapshot.jobs.length:0,hasMore:snapshot.has_more,
        }});
      }

      if (req.method==='GET' && routePath==='/admin/provider/jobs') {
        const provider=await providerClient();
        return sendJson(res,200,await provider.getJobs(12));
      }

      if (req.method==='GET' && routePath==='/admin/provider/job') {
        const jobId=Number(url.searchParams.get('id'));
        if (!Number.isFinite(jobId)||jobId<=0) return sendJson(res,400,{ok:false,error:'Valid job id is required.'});
        const provider=await providerClient();
        const snapshot=await provider.getJobs(12);
        const all=[...(snapshot.active||[]),...(snapshot.jobs||[])];
        const job=all.find(item=>Number(item.id)===jobId)||null;
        return sendJson(res,200,{ok:true,found:Boolean(job),job:job?provider.normalizeJob(job):null});
      }

      if (req.method==='POST' && routePath==='/admin/provider/generate') {
        const settings=await getProviderSettings();
        if (!settings.allowProviderCharges) return sendJson(res,403,{ok:false,error:'Generation submissions are disabled.'});
        const body=await readJson(req);
        const prompt=String(body.prompt||'').trim();
        if (!prompt) return sendJson(res,400,{ok:false,error:'prompt is required'});
        const provider=await providerClient();
        const result=await provider.generateText({
          prompt, model:String(body.model||'seedance_2.5'), duration:Number(body.duration||10),
          aspectRatio:String(body.aspectRatio||'9:16'), quantity:Number(body.quantity||1),
        });
        return sendJson(res,200,{ok:true,submitted:true,job_id:result.job_id,job_ids:result.job_ids,quantity:result.quantity});
      }

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
        const credits=await new VercelGatewayClient({apiKey:s.vercelApiKey}).credits();
        return sendJson(res,200,{ok:true,balance:credits.balance,totalUsed:credits.totalUsed});
      }
      if(req.method==='POST'&&routePath==='/admin/vercel/sync'){
        requireDatabase();const s=await getProviderSettings();
        const live=await new VercelGatewayClient({apiKey:s.vercelApiKey}).catalog();
        const models=await syncProviderModels('vercel',mediaModels(live));
        return sendJson(res,200,{ok:true,models,total:models.length,ready:models.filter(m=>m.ready&&m.enabled&&m.available).length});
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

      if (req.method==='GET' && routePath==='/admin/provider-settings') {
        requireDatabase();
        return sendJson(res,200,{ok:true,settings:await getAdminProviderSettings()});
      }

      if ((req.method==='POST' || req.method==='PUT') && routePath==='/admin/provider-settings') {
        requireDatabase();
        const body=await readJson(req);
        const settings=await updateProviderSettings(body);
        return sendJson(res,200,{ok:true,settings});
      }

      if (req.method==='POST' && routePath==='/admin/higgsfield/oauth/start') {
        requireDatabase();
        const body=await readJson(req);
        const redirectUrl=publicOrigin(req)+'/admin/higgsfield/oauth/callback';
        const result=await beginHiggsfieldAuthorization({
          redirectUrl,
          force:body.force===true,
        });
        return sendJson(res,200,{ok:true,...result});
      }

      if (req.method==='POST' && routePath==='/admin/higgsfield/disconnect') {
        requireDatabase();
        await clearHiggsfieldAuth({keepClientRegistration:true});
        return sendJson(res,200,{ok:true,connected:false});
      }

      if (req.method==='GET' && routePath==='/admin/higgsfield/status') {
        requireDatabase();
        return sendJson(res,200,{ok:true,status:await getHiggsfieldConnectionStatus()});
      }

      if (req.method==='POST' && routePath==='/admin/higgsfield/sync') {
        requireDatabase();
        const result=await syncHiggsfieldModels();
        return sendJson(res,200,{
          ok:true,
          modelCount:result.modelCount,
          videoCount:result.videoCount,
          imageCount:result.imageCount,
          toolCount:result.toolCount,
          catalogSource:result.catalogSource,
          jobsWaitConfigured:result.jobsWaitConfigured,
        });
      }

      if (req.method==='GET' && routePath==='/admin/higgsfield/tools') {
        requireDatabase();
        const tools=await getHiggsfieldToolDiagnostics();
        return sendJson(res,200,{ok:true,tools});
      }

      if (req.method==='GET' && routePath==='/admin/provider-models') {
        requireDatabase();
        const provider=String(url.searchParams.get('provider')||'higgsfield');
        if (!['higgsfield','vercel'].includes(provider)) return sendJson(res,400,{ok:false,error:'Unsupported provider.'});
        const models=await listProviderModels(provider);
        return sendJson(res,200,{ok:true,models});
      }

      const providerModelMatch=routePath.match(/^\/admin\/provider-models\/(\d+)$/);
      if (req.method==='POST' && providerModelMatch) {
        requireDatabase();
        const body=await readJson(req);
        const provider=String(body.provider||'higgsfield');
        if(!['higgsfield','vercel'].includes(provider))return sendJson(res,400,{ok:false,error:'Unsupported provider.'});
        const model=await setProviderModelEnabled(provider,Number(providerModelMatch[1]),body.enabled===true);
        return sendJson(res,200,{ok:true,model});
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
            vidancee:providerSettings.vidancee.configured,
            createpulse:providerSettings.createpulse.configured,
            atlascloud:providerSettings.atlascloud.configured,
            vgenv:providerSettings.vgenv.configured,
            higgsfield:providerSettings.higgsfield.configured,
            vibi:providerSettings.vibi.configured,
            smartaipi:providerSettings.smartaipi.configured,
            vercel:providerSettings.vercel.configured,
          },
          providerEnabled:{
            vidancee:providerSettings.vidancee.enabled,
            createpulse:providerSettings.createpulse.enabled,
            atlascloud:providerSettings.atlascloud.enabled,
            vgenv:providerSettings.vgenv.enabled,
            higgsfield:providerSettings.higgsfield.enabled,
            vibi:providerSettings.vibi.enabled,
            smartaipi:providerSettings.smartaipi.enabled,
            vercel:providerSettings.vercel.enabled,
          },
          providerActive:{
            vidancee:providerSettings.vidancee.active,
            createpulse:providerSettings.createpulse.active,
            atlascloud:providerSettings.atlascloud.active,
            vgenv:providerSettings.vgenv.active,
            higgsfield:providerSettings.higgsfield.active,
            vibi:providerSettings.vibi.active,
            smartaipi:providerSettings.smartaipi.active,
            vercel:providerSettings.vercel.active,
          },
          routing:providerSettings.routing,
          createPulseMaxInflight:providerSettings.createpulse.maxInflight,
          atlasCloudMaxInflight:providerSettings.atlascloud.maxInflight,
          vgenvMaxInflight:providerSettings.vgenv.maxInflight,
          higgsfieldMaxInflight:providerSettings.higgsfield.maxInflight,
          vibiMaxInflight:providerSettings.vibi.maxInflight,
          smartAipiMaxInflight:providerSettings.smartaipi.maxInflight,
          vercelMaxInflight:providerSettings.vercel.maxInflight,
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

      const userProviderMatch=routePath.match(/^\/admin\/users\/(\d+)\/providers$/);
      if ((req.method==='POST'||req.method==='PUT') && userProviderMatch) {
        requireDatabase();
        const body=await readJson(req);
        const access=await setUserProviderAccess(Number(userProviderMatch[1]),body.providers||body);
        return sendJson(res,200,{ok:true,provider_access:access});
      }

      const userPatchMatch=routePath.match(/^\/admin\/users\/(\d+)$/);
      if (req.method==='PATCH' && userPatchMatch) {
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
        const amount=roundCredits(Number(body.amount));
        if (!Number.isFinite(amount)||amount===0) return sendJson(res,400,{ok:false,error:'amount must be a non-zero number'});
        const db=getPool(); const conn=await db.getConnection();
        try {
          await conn.beginTransaction();
          const [users]=await conn.execute('SELECT * FROM users WHERE id=? FOR UPDATE',[Number(creditMatch[1])]);
          const user=users[0];
          if (!user) { await conn.rollback(); return sendJson(res,404,{ok:false,error:'User not found.'}); }
          if (Number(user.credits)+amount<0) { await conn.rollback(); return sendJson(res,400,{ok:false,error:'Credit adjustment would make balance negative.'}); }
          await conn.execute('UPDATE users SET credits=credits+? WHERE id=?',[amount,user.id]);
          await conn.execute(
            "INSERT INTO credit_transactions (user_id,amount,type,note) VALUES (?,?,'admin_adjustment',?)",
            [user.id,amount,String(body.note||'Admin credit adjustment').slice(0,255)],
          );
          await conn.commit();
          const [updated]=await db.execute('SELECT id,email,credits,role,status,created_at FROM users WHERE id=?',[user.id]);
          return sendJson(res,200,{ok:true,user:userPayload(updated[0])});
        } catch(error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
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
        if (q) { clauses.push('(u.email LIKE ? OR g.id=? OR CAST(g.provider_job_id AS CHAR)=?)'); params.push('%'+q+'%',q,q); }
        const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
        const [rows]=await db.query(
          `SELECT
             g.id,g.user_id,g.provider,g.media_type,g.provider_job_id,g.mode,g.model,g.duration,g.resolution,g.aspect_ratio,
             g.prompt,g.status,g.credits_cost,g.provider_cost,g.provider_cost_unit,g.output_url,g.poster_url,
             g.error_message,g.submitted_at,g.started_at,g.completed_at,g.refunded_at,g.created_at,g.updated_at,
             u.email
           FROM generations g
           JOIN users u ON u.id=g.user_id`+where+`
           ORDER BY g.created_at DESC LIMIT 200`,
          params,
        );
        return sendJson(res,200,{ok:true,generations:rows.map(row=>({
          ...serializeGeneration(row),
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
server.on('error',(error)=>{console.error('HTTP server failed:',error);process.exitCode=1;});


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

process.on('SIGTERM',stopWorkerChild);
process.on('SIGINT',stopWorkerChild);

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
      const migrated=await migrateLegacyProviderEnvSettings();
      if (migrated) console.log('Legacy provider settings migrated into Admin-managed storage.');
      await ensureGatewayCatalog().catch(error=>console.error('Gateway catalog initialization failed:',error.message));
      startWorkerChild();
    })
    .catch((error) => {
      console.error('MySQL initialization failed:',error);
      console.error('Web server remains online; inspect /health for database diagnostics.');
    });
}

bootstrap();
module.exports=server;


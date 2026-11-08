const { getPool } = require('./db.js');
const { argoMediaModels } = require('./argolink_models.js');
const { api888MediaModels } = require('./api888_models.js');
const { DEFAULT_ON_MODELS } = require('./api888_access.js');
const { hideApi888Name } = require('./vendor_names.js');
const { higgsfieldMediaModels, higgsfieldReferenceCapabilities } = require('./higgsfield_models.js');
const { sluiceMediaModels } = require('./sluice_models.js');
const { vidanceeMediaModels, vidanceeReferenceCapabilities } = require('./vidancee_models.js');
const { modelFamily } = require('./model_families.js');
const { modelReady, normalizePriceOverride, mediaModels, quoteGateway, publishedImageTiers, applyModelFixups, promptLimit } = require('./vercel_models.js');

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function humanizeModelId(value) {
  return String(value || '')
    .replace(/^hf[_:-]?/i, '')
    .replace(/[\/_:.+-]+/g, ' ')
    .replace(/\b(ai|api)\b/gi, m => m.toUpperCase())
    .replace(/\b\w/g, m => m.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim() || 'AI Model';
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
}

function canonicalPublicModelId(providerModelId, label = '', mediaType = 'video') {
  const base = slug(providerModelId || label);
  // Reuse existing public IDs only for the plain/base product. Variants keep
  // distinct neutral IDs so a provider catalog with Fast/Pro/etc. does not
  // collapse multiple sellable models into one customer option.
  if (/^(?:bytedance_)?seedance_2_5$/.test(base)) return 'seedance_2.5';
  if (/^(?:bytedance_)?seedance_2_0_(?:fast|mini)$/.test(base)) return 'seedance_2.0_fast';
  if (/^(?:minimax_)?(?:h3|hailuo_?3)$/.test(base)) return 'minimax_h3';
  return 'ai_' + (base || mediaType + '_model');
}

function normalizeNumberList(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function normalizeStringList(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const s = String(value == null ? '' : value).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeDiscoveredModel(model) {
  const mediaType = model.mediaType === 'image' ? 'image' : 'video';
  const providerModelId = String(model.providerModelId || '').trim();
  if (!providerModelId) throw new Error('providerModelId is required.');
  const label = String(model.label || humanizeModelId(providerModelId)).trim().slice(0, 191);
  const options = {
    ...(model.options && typeof model.options === 'object' ? model.options : {}),
    durations: normalizeNumberList(model.options?.durations),
    resolutions: normalizeStringList(model.options?.resolutions),
    aspectRatios: normalizeStringList(model.options?.aspectRatios),
  };
  return {
    providerModelId: providerModelId.slice(0, 191),
    publicModelId: String(model.publicModelId || canonicalPublicModelId(providerModelId, label, mediaType)).slice(0, 100),
    label,
    mediaType,
    toolName: String(model.toolName || '').slice(0, 191),
    inputSchema: JSON.stringify(model.inputSchema || {}),
    optionsJson: JSON.stringify(options),
  };
}

async function syncProviderModels(provider, discoveredModels) {
  const db = getPool();
  const normalized = (Array.isArray(discoveredModels) ? discoveredModels : []).map(normalizeDiscoveredModel);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // Previously unsupported 888API models are not silently activated for
    // paying users when a new code deployment adds their request adapters.
    // Keep existing runnable models' explicit Admin enable state untouched.
    const previousApi888 = new Map();
    if(provider==='api888'){
      const [rows]=await conn.execute(
        'SELECT provider_model_id, options_json FROM provider_models WHERE provider=? FOR UPDATE',[provider]);
      for(const row of rows){
        let wasSupported=false;
        try{const opts=typeof row.options_json==='string'?JSON.parse(row.options_json||'{}'):(row.options_json||{});wasSupported=opts.adapterSupported===true;}catch{}
        previousApi888.set(row.provider_model_id,wasSupported);
      }
    }
    await conn.execute('UPDATE provider_models SET available=0 WHERE provider=?', [provider]);

    for (const model of normalized) {
      await conn.execute(
        `INSERT INTO provider_models
          (provider,provider_model_id,public_model_id,label,media_type,tool_name,input_schema,options_json,enabled,available,last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,1,1,UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
           public_model_id=VALUES(public_model_id),
           label=VALUES(label),
           tool_name=VALUES(tool_name),
           input_schema=VALUES(input_schema),
           options_json=VALUES(options_json),
           available=1,
           last_seen_at=UTC_TIMESTAMP(),
           updated_at=UTC_TIMESTAMP()`,
        [
          String(provider),
          model.providerModelId,
          model.publicModelId,
          model.label,
          model.mediaType,
          model.toolName,
          model.inputSchema,
          model.optionsJson,
        ],
      );
      if(provider==='api888'){
        let isSupported=false;
        try{isSupported=JSON.parse(model.optionsJson).adapterSupported===true;}catch{}
        // Owner-approved default-on models skip the Admin opt-in gate.
        if(isSupported&&previousApi888.get(model.providerModelId)!==true&&!DEFAULT_ON_MODELS.includes(model.providerModelId)){
          // The new or newly supported SKU needs explicit model-level Admin opt-in.
          await conn.execute(
            'UPDATE provider_models SET enabled=0 WHERE provider=? AND provider_model_id=?',
            [provider,model.providerModelId]);
        }
      }
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  return listProviderModels(provider);
}

const positiveNumber=value=>Number.isFinite(Number(value))&&Number(value)>0;
// Sources whose models are priced locally from a USD catalog (quoteGateway).
const PRICED_SOURCES=['vercel','argolink','higgsfield','sluice','vidancee','api888','falimg','longai'];
const isPricedSource=provider=>PRICED_SOURCES.includes(provider);

// Higgsfield rows take their endpoints and reference rules from the current code.
function higgsfieldFields(options) {
  const referenceCapabilities=higgsfieldReferenceCapabilities();
  return {higgsfield:higgsfieldMediaModels()[0].options.higgsfield,referenceCapabilities,mediaRoles:referenceCapabilities.image.roles};
}

function serializeProviderModel(row, { includeInternal = true } = {}) {
  const options = safeJson(row.options_json, {});
  const base = {
    id: Number(row.id),
    publicModelId: row.public_model_id,
    label: row.label,
    mediaType: row.media_type,
    enabled: Boolean(row.enabled),
    available: Boolean(row.available),
    durations: normalizeNumberList(options.durations),
    resolutions: normalizeStringList(options.resolutions),
    aspectRatios: normalizeStringList(options.aspectRatios),
    defaultDuration: Number.isFinite(Number(options.defaultDuration)) ? Number(options.defaultDuration) : null,
    defaultResolution: options.defaultResolution ? String(options.defaultResolution) : null,
    defaultAspectRatio: options.defaultAspectRatio ? String(options.defaultAspectRatio) : null,
    tools: Array.isArray(options.tools) ? options.tools : [],
    mediaRoles: Array.isArray(options.mediaRoles) ? options.mediaRoles : [],
    modes: Array.isArray(options.modes) ? options.modes : [],
    defaultMode: options.defaultMode ? String(options.defaultMode) : null,
    referenceCapabilities: options.referenceCapabilities && typeof options.referenceCapabilities === 'object'
      ? options.referenceCapabilities
      : {},
    catalogVerified: options.catalogVerified === true,
    lastSeenAt: row.last_seen_at,
    ...(isPricedSource(row.provider)?{
      adapterSupported:options.adapterSupported===true, setupReason:options.setupReason||'',
      gatewayType:options.gatewayType,pricing:options.pricing||{},priceOverride:safeJson(row.price_override,null),
      inputLimits:options.inputLimits||{},supportedOperations:options.supportedOperations||[],
      eligibility:options.eligibility||null,fps:options.fps||24,
      qualities:options.qualities||[],defaultQuality:options.defaultQuality,
      imageSizes:options.imageSizes||[],defaultImageSize:options.defaultImageSize,
      supportsAudio:options.supportsAudio===true,
    }:{}),
    ...(row.provider==='api888'?{api888:options.api888||{}}:{}),
    ...(row.provider==='falimg'?{falImage:options.falImage||{}}:{}),
    ...(row.provider==='argolink'?{argoFrame:options.argoFrame||'aspect_ratio',pixelSizes:options.pixelSizes||{},adaptiveFrames:options.adaptiveFrames===true}:{}),
    ...(row.provider==='higgsfield'?higgsfieldFields(options):{}),
    ...(row.provider==='sluice'?{sluice:options.sluice||{},referenceCapabilities:options.referenceCapabilities}:{}),
    ...(row.provider==='vidancee'?{vidancee:options.vidancee||{},referenceCapabilities:options.referenceCapabilities||vidanceeReferenceCapabilities(4)}:{}),
  };
  if (includeInternal) {
    base.provider = row.provider;
    base.providerModelId = row.provider_model_id;
    base.toolName = row.tool_name;
    base.inputSchema = safeJson(row.input_schema, {});
  }
  if(row.provider==='vercel')applyModelFixups(base);
  if(row.provider==='falimg'&&row.media_type==='image'&&base.enabled&&base.available){
    require('./fal_images.js').applySavedGptEdit(base,row.provider_model_id);
  }
  if(row.provider==='api888'){
    // The catalog table is a historical/account-scoped snapshot. Shipping a new
    // verified 888API input mapping must not require the administrator to write
    // to MySQL just to expose audio/video upload controls. In particular,
    // Hostinger can suspend writes when its database crosses the disk quota.
    // Rehydrate ONLY already-supported, currently-present model rows using
    // the current audited local request contract. Never change row.enabled,
    // row.available, account access, provider price, or unsupported models.
    if(base.adapterSupported&&(row.media_type==='video'||row.media_type==='image')){
      const latest=api888MediaModels({data:[{id:row.provider_model_id,type:row.media_type}]})[0];
      // A model the current code no longer supports stops being offered.
      if(latest&&latest.options.adapterSupported===false){
        base.adapterSupported=false;
        base.setupReason=latest.options.setupReason||'This 888API model is temporarily unavailable.';
      }
      // Names and image ratios also follow the current code, not the import.
      if(latest?.options.adapterSupported&&latest.mediaType===row.media_type){
        base.label=latest.label;
        base.aspectRatios=latest.options.aspectRatios;
        base.defaultAspectRatio=latest.options.defaultAspectRatio;
      }
      if(latest?.options.adapterSupported&&latest.mediaType==='video'){
        const latestOptions=latest.options;
        base.referenceCapabilities=latestOptions.referenceCapabilities;
        base.mediaRoles=latestOptions.mediaRoles;
        base.aspectRatios=latestOptions.aspectRatios;
        base.defaultAspectRatio=latestOptions.defaultAspectRatio;
        base.supportedOperations=latestOptions.supportedOperations;
        base.api888={...base.api888,
          imageField:latestOptions.api888.imageField,
          videoField:latestOptions.api888.videoField,
          audioField:latestOptions.api888.audioField};
      }
    }
    base.ready=Boolean(base.adapterSupported&&base.api888.sourceCny>0);
    if(!base.ready&&!base.setupReason)base.setupReason='888API model requires a verified contract and price.';
    return base;
  }
  if(isPricedSource(row.provider)){base.ready=modelReady(base);if(!base.ready&&!base.setupReason)base.setupReason='Configure USD pricing or account eligibility before generation.';}
  // Token-billed GPT Image models are priced from OpenAI's published per-image table.
  if(row.provider==='vercel'&&!base.priceOverride&&!positiveNumber(base.pricing?.image)&&!(base.pricing?.image_dimension_quality_pricing||[]).length&&publishedImageTiers(base.providerModelId).length)base.publishedPrices=true;
  return base;
}

async function listProviderModels(provider, { mediaType = '', enabledOnly = false, availableOnly = false } = {}) {
  const db = getPool();
  const clauses = ['provider=?'];
  const params = [String(provider)];
  if (mediaType === 'video' || mediaType === 'image') {
    clauses.push('media_type=?');
    params.push(mediaType);
  }
  if (enabledOnly) clauses.push('enabled=1');
  if (availableOnly) clauses.push('available=1');
  const [rows] = await db.query(
    `SELECT * FROM provider_models WHERE ${clauses.join(' AND ')} ORDER BY media_type, label, id`,
    params,
  );
  return rows.map(row => serializeProviderModel(row));
}

async function getProviderModelByPublicId(provider, publicModelId, mediaType) {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT * FROM provider_models
     WHERE provider=? AND public_model_id=? AND media_type=? AND enabled=1 AND available=1
     ORDER BY updated_at DESC LIMIT 1`,
    [String(provider), String(publicModelId), String(mediaType)],
  );
  return rows[0] ? serializeProviderModel(rows[0]) : null;
}

async function quarantineProviderUtilityModels(provider) {
  const models = await listProviderModels(provider);
  const bad = models.filter(model => {
    const hay = [
      model?.providerModelId,
      model?.label,
      model?.toolName,
    ].filter(Boolean).join(' ').toLowerCase();
    return /\b(analysis|analy[sz]e|predictor|virality|preset|presets|action|actions|jobs?|history|balance|credits?|status|workflow|template|templates)\b/.test(hay)
      && !/\b(seedance|kling|veo|sora|wan|hailuo|minimax|grok|omni|nano banana|seedream|flux|recraft|ideogram|gpt image|imagen|soul|qwen|pixverse|runway|luma|pika)\b/.test(hay.replace(/[._/-]+/g, ' '));
  });
  if (!bad.length) return 0;

  const db = getPool();
  for (const model of bad) {
    await db.execute(
      'UPDATE provider_models SET available=0, updated_at=UTC_TIMESTAMP() WHERE id=? AND provider=?',
      [Number(model.id), String(provider)],
    );
  }
  return bad.length;
}

async function setProviderModelEnabled(provider, id, enabled) {
  const db = getPool();
  const [result] = await db.execute(
    'UPDATE provider_models SET enabled=?, updated_at=UTC_TIMESTAMP() WHERE id=? AND provider=?',
    [enabled ? 1 : 0, Number(id), String(provider)],
  );
  if (!result.affectedRows) {
    const error = new Error('Provider model not found.');
    error.statusCode = 404;
    throw error;
  }
  const [rows] = await db.execute('SELECT * FROM provider_models WHERE id=? AND provider=? LIMIT 1', [Number(id), String(provider)]);
  return serializeProviderModel(rows[0]);
}

function isPlausibleCustomerModel(model) {
  if (model?.catalogVerified === true) return true;

  const hay = [
    model?.providerModelId,
    model?.publicModelId,
    model?.label,
  ].filter(Boolean).join(' ').toLowerCase().replace(/[._/-]+/g, ' ');

  const knownFamily = /\b(seedance|kling|veo|sora|wan|hailuo|minimax|grok|omni flash|nano banana|seedream|flux|recraft|ideogram|gpt image|imagen|soul|qwen|pixverse|runway|luma|pika)\b/.test(hay);
  if (knownFamily) return true;

  // Never surface MCP workflow/utility tools as sellable creative models.
  if (/\b(analysis|predictor|virality|preset|presets|action|actions|jobs?|history|balance|credits?|status|workflow|template|templates)\b/.test(hay)) {
    return false;
  }

  return false;
}

function normalizedReferenceCapabilities(model) {
  const raw = model.referenceCapabilities && typeof model.referenceCapabilities === 'object'
    ? model.referenceCapabilities
    : {};
  const roles = Array.isArray(model.mediaRoles) ? model.mediaRoles.map(String) : [];

  const imageRoles = roles.filter(role => ['image','image_references','input_images','start_image','end_image','reference_image'].includes(role));
  const videoRoles = roles.filter(role => ['video','video_references','input_videos','reference_video'].includes(role));
  const audioRoles = roles.filter(role => ['audio','audio_references','input_audio','reference_audio'].includes(role));

  const normalizeKind = (kind, inferredRoles) => {
    const source = raw[kind] && typeof raw[kind] === 'object' ? raw[kind] : {};
    const kindRoles = Array.isArray(source.roles) && source.roles.length
      ? source.roles.map(String)
      : inferredRoles;
    const max = Math.max(0, Number(source.max || 0));
    const min = Math.max(0, Number(source.min || 0));
    const requiredRoles = Array.isArray(source.requiredRoles) ? source.requiredRoles.map(String) : [];
    return {
      supported: source.supported === true || kindRoles.length > 0 || max > 0,
      max,
      min,
      roles: [...new Set(kindRoles)],
      requiredRoles: [...new Set(requiredRoles)],
      ...(source.maxBytes?{maxBytes:source.maxBytes}:{}),
      ...(source.formats?{formats:source.formats}:{}),
    };
  };

  const image = normalizeKind('image', imageRoles);
  const video = normalizeKind('video', videoRoles);
  const audio = normalizeKind('audio', audioRoles);
  const totalMax = Math.max(0, Number(raw.totalMax || 0));

  return {
    textOnly: Boolean(raw.textOnly) || (!image.supported && !video.supported && !audio.supported),
    totalMax,
    image,
    video,
    audio,
  };
}

// 888API's yuan rate (per second or per request) in customer credits.
function api888RateCredits(model) {
  const { CREDITS_PER_CNY, roundCredits } = require('./billing.js');
  const cny = Number(model.api888?.sourceCny);
  return cny > 0 ? roundCredits(cny * CREDITS_PER_CNY) : null;
}

function publicVideoModel(model) {
  const durations = model.durations.length ? model.durations : [0];
  const durationEntries = durations.map(seconds => ({
    seconds,
    label: seconds > 0 ? seconds + ' sec' : 'Default',
    cost: null,
  }));

  const resolutions = model.resolutions.map(resolution => ({
    id: resolution,
    label: resolution,
    durations: durationEntries,
  }));

  return {
    id: model.publicModelId,
    label: hideApi888Name(model.label),
    dynamicCost: true,
    defaultResolution: model.defaultResolution || (resolutions[0]?.id || null),
    resolutions,
    durations: durationEntries,
    aspectRatios: model.aspectRatios,
    defaultAspectRatio: model.defaultAspectRatio || null,
    defaultDuration: model.defaultDuration || null,
    promptMaxChars: promptLimit(model),
    capabilities: normalizedReferenceCapabilities(model),
    ...(model.provider==='api888'?{
      billingMode:model.api888?.billing==='second'?'per_second':'per_request',
      billingRateCredits:api888RateCredits(model),
    }:{}),
    ...(isPricedSource(model.provider)?{modes:model.modes,defaultMode:model.defaultMode,supportsAudio:model.supportsAudio}:{}),
  };
}

function publicImageModel(model) {
  return {
    id: model.publicModelId,
    label: hideApi888Name(model.label),
    cost: null,
    dynamicCost: true,
    aspectRatios: model.aspectRatios,
    defaultAspectRatio: model.defaultAspectRatio || null,
    promptMaxChars: promptLimit(model),
    capabilities: normalizedReferenceCapabilities(model),
    ...(model.provider==='api888'?{
      billingMode:'per_request',
      billingRateCredits:api888RateCredits(model),
    }:{}),
    ...(isPricedSource(model.provider)?{qualities:model.qualities,defaultQuality:model.defaultQuality,imageSizes:model.imageSizes,defaultImageSize:model.defaultImageSize}:{}),
  };
}

// Every AI Gateway image price is computed locally, so the page receives the
// full table up front and shows the cost instantly instead of asking the
// server on each change. Edit estimates add a "|reference" suffix. A missing key
// falls back to the /api/model-cost request.
function imageCostTable(model,creditsPerUsd) {
  const table={},estimates=[];
  const referencePricing=Boolean(model.pricing?.reference_image_dimension_quality_pricing?.length);
  for (const aspectRatio of model.aspectRatios||[]) {
    for (const quality of model.qualities?.length?model.qualities:['']) {
      for (const imageSize of model.imageSizes?.length?model.imageSizes:['']) {
        for (const previewHasReferences of referencePricing?[false,true]:[false]) {
          try {
            const quote=quoteGateway(model,{aspectRatio,quality:quality||undefined,imageSize:imageSize||undefined,previewHasReferences},creditsPerUsd);
            const key=aspectRatio+'|'+quality+'|'+imageSize+(previewHasReferences?'|reference':'');
            if (Number.isFinite(Number(quote.cost))) {table[key]=Number(quote.cost);if(quote.isEstimate)estimates.push(key);}
          } catch {}
        }
      }
    }
  }
  return {costTable:table,costEstimates:estimates,...(referencePricing?{referencePricing}: {})};
}

// One entry per model: models already in the list keep their place and later
// copies of the same model (see model_families.js) are left out.
function addMissingImageModels(list, extra) {
  const key = model => modelFamily(model?.label);
  const taken = new Set(list.map(key));
  return [...list, ...extra.filter(model => !taken.has(key(model)))];
}

// transform (optional) adjusts each model before it is published, e.g. the
// 720p/1080p view of ArgoLink video models.
async function publicProviderCatalog(provider, { creditsPerUsd, transform } = {}) {
  const models = (await listProviderModels(provider, { enabledOnly: true, availableOnly: true }))
    .filter(isPlausibleCustomerModel).filter(model=>!isPricedSource(provider)||model.ready)
    .map(model => transform ? transform(model) : model).filter(model => model.mediaType !== 'video' || model.resolutions.length);
  const withCosts = model => provider==='api888' ? publicImageModel(model) : isPricedSource(provider) && creditsPerUsd
    ? { ...publicImageModel(model), ...imageCostTable(model,creditsPerUsd) } : publicImageModel(model);
  return {
    video: models.filter(model => model.mediaType === 'video').map(publicVideoModel),
    image: models.filter(model => model.mediaType === 'image').map(withCosts),
  };
}

async function setGatewayPrice(id,value) {
  const db=getPool();
  const [rows]=await db.execute("SELECT * FROM provider_models WHERE id=? AND provider='vercel' LIMIT 1",[Number(id)]);
  if(!rows[0])throw Object.assign(new Error('Provider model not found.'),{statusCode:404});
  const price=normalizePriceOverride(value,rows[0].media_type);
  await db.execute("UPDATE provider_models SET price_override=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='vercel'",[price?JSON.stringify(price):null,Number(id)]);
  const [updated]=await db.execute("SELECT * FROM provider_models WHERE id=? AND provider='vercel' LIMIT 1",[Number(id)]);
  return serializeProviderModel(updated[0]);
}

async function ensureGatewayCatalog() {
  const db=getPool();
  const conn=await db.getConnection();let locked=false;
  try {
    const [[lock]]=await conn.query("SELECT GET_LOCK('cmm_vercel_catalog_seed',10) AS acquired");
    locked=Number(lock?.acquired)===1;if(!locked)return;
    const [[count]]=await conn.query("SELECT COUNT(*) AS total FROM provider_models WHERE provider='vercel'");
    if(!Number(count.total))await syncProviderModels('vercel',mediaModels(require('./provider/vercel_catalog.json')));
  } finally {if(locked)await conn.query("SELECT RELEASE_LOCK('cmm_vercel_catalog_seed')");conn.release();}
}

// First start: ArgoLink's models come from the bundled catalog snapshot until
// an admin syncs the live catalog.
async function ensureArgoCatalog() {
  const db=getPool();
  const conn=await db.getConnection();let locked=false;
  try {
    const [[lock]]=await conn.query("SELECT GET_LOCK('cmm_argolink_catalog_seed',10) AS acquired");
    locked=Number(lock?.acquired)===1;if(!locked)return;
    const [[count]]=await conn.query("SELECT COUNT(*) AS total FROM provider_models WHERE provider='argolink'");
    if(!Number(count.total))await syncProviderModels('argolink',argoMediaModels(require('./provider/argolink_catalog.json')));
  } finally {if(locked)await conn.query("SELECT RELEASE_LOCK('cmm_argolink_catalog_seed')");conn.release();}
}

// First start: Higgsfield's Wan 3.0 is listed but stays hidden until an admin
// syncs its prices. Yotta Labs was replaced by Higgsfield; its model rows are
// switched off so they are never listed or started again.
async function ensureHiggsfieldCatalog() {
  const db=getPool();
  const conn=await db.getConnection();let locked=false;
  try {
    const [[lock]]=await conn.query("SELECT GET_LOCK('cmm_higgsfield_catalog_seed',10) AS acquired");
    locked=Number(lock?.acquired)===1;if(!locked)return;
    await conn.query("UPDATE provider_models SET enabled=0,available=0 WHERE provider='yotta' AND (enabled=1 OR available=1)");
    const [[count]]=await conn.query("SELECT COUNT(*) AS total FROM provider_models WHERE provider='higgsfield'");
    if(!Number(count.total)){
      // Customer Sources switches saved for the earlier Higgsfield connection do not apply to this one.
      await conn.query("DELETE FROM user_provider_access WHERE provider='higgsfield'");
      await syncProviderModels('higgsfield',higgsfieldMediaModels());
    }
  } finally {if(locked)await conn.query("SELECT RELEASE_LOCK('cmm_higgsfield_catalog_seed')");conn.release();}
}

// Sluice's catalogue is public: the live one is read on start (the bundled
// snapshot until it answers), and an admin can sync it again.
async function ensureSluiceCatalog(fetchCatalog) {
  let live=null;
  try{live=await fetchCatalog();}catch(error){console.error('Sluice catalogue unavailable; keeping the saved one:',error.message);}
  const db=getPool();
  const conn=await db.getConnection();let locked=false;
  try {
    const [[lock]]=await conn.query("SELECT GET_LOCK('cmm_sluice_catalog_seed',10) AS acquired");
    locked=Number(lock?.acquired)===1;if(!locked)return;
    if(live){await syncProviderModels('sluice',sluiceMediaModels(live));return;}
    const [[count]]=await conn.query("SELECT COUNT(*) AS total FROM provider_models WHERE provider='sluice'");
    if(!Number(count.total))await syncProviderModels('sluice',sluiceMediaModels(require('./provider/sluice_catalog.json')));
  } finally {if(locked)await conn.query("SELECT RELEASE_LOCK('cmm_sluice_catalog_seed')");conn.release();}
}

// Vidancee has no catalogue: its models and prices are in the code and
// are written on every start, so a price change ships with a deploy.
async function ensureVidanceeCatalog() {
  const db=getPool();
  const conn=await db.getConnection();let locked=false;
  try {
    const [[lock]]=await conn.query("SELECT GET_LOCK('cmm_vidancee_catalog_seed',10) AS acquired");
    locked=Number(lock?.acquired)===1;if(!locked)return;
    await syncProviderModels('vidancee',vidanceeMediaModels());
  } finally {if(locked)await conn.query("SELECT RELEASE_LOCK('cmm_vidancee_catalog_seed')");conn.release();}
}

async function ensureApi888Catalog(){
  const db=getPool();
  const [[count]]=await db.execute("SELECT COUNT(*) AS total FROM provider_models WHERE provider='api888'");
  if(!Number(count.total)){
    await syncProviderModels('api888',api888MediaModels());
    // Documentation is not proof of account access. Only a successful live
    // authenticated catalog sync may make a model available for sale.
    await db.execute("UPDATE provider_models SET available=0 WHERE provider='api888'");
  }
}

module.exports = {
  // Exported for regression tests: stale saved 888API rows must be blocked at read time.
  serializeProviderModel,
  ensureApi888Catalog,
  ensureSluiceCatalog,
  ensureVidanceeCatalog,
  ensureArgoCatalog,
  ensureHiggsfieldCatalog,
  isPricedSource,
  setGatewayPrice,
  ensureGatewayCatalog,
  safeJson,
  humanizeModelId,
  canonicalPublicModelId,
  syncProviderModels,
  listProviderModels,
  getProviderModelByPublicId,
  setProviderModelEnabled,
  quarantineProviderUtilityModels,
  publicProviderCatalog,
  addMissingImageModels,
};

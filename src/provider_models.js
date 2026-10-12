const { getPool } = require('./db.js');
const { modelReady, normalizePriceOverride, mediaModels, quoteGateway, publishedImageTiers, applyModelFixups } = require('./vercel_models.js');

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
    ...(row.provider==='vercel'?{
      adapterSupported:options.adapterSupported===true, setupReason:options.setupReason||'',
      gatewayType:options.gatewayType,pricing:options.pricing||{},priceOverride:safeJson(row.price_override,null),
      inputLimits:options.inputLimits||{},supportedOperations:options.supportedOperations||[],
      eligibility:options.eligibility||null,fps:options.fps||24,
      qualities:options.qualities||[],defaultQuality:options.defaultQuality,
      imageSizes:options.imageSizes||[],defaultImageSize:options.defaultImageSize,
      supportsAudio:options.supportsAudio===true,
    }:{}),
  };
  if (includeInternal) {
    base.provider = row.provider;
    base.providerModelId = row.provider_model_id;
    base.toolName = row.tool_name;
    base.inputSchema = safeJson(row.input_schema, {});
  }
  if(row.provider==='vercel')applyModelFixups(base);
  if(row.provider==='vercel'){base.ready=modelReady(base);if(!base.ready&&!base.setupReason)base.setupReason='Configure USD pricing or account eligibility before generation.';}
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
    label: model.label,
    dynamicCost: true,
    defaultResolution: model.defaultResolution || (resolutions[0]?.id || null),
    resolutions,
    durations: durationEntries,
    aspectRatios: model.aspectRatios,
    defaultAspectRatio: model.defaultAspectRatio || null,
    capabilities: normalizedReferenceCapabilities(model),
    ...(model.provider==='vercel'?{modes:model.modes,defaultMode:model.defaultMode,supportsAudio:model.supportsAudio}:{}),
  };
}

function publicImageModel(model) {
  return {
    id: model.publicModelId,
    label: model.label,
    cost: null,
    dynamicCost: true,
    aspectRatios: model.aspectRatios,
    defaultAspectRatio: model.defaultAspectRatio || null,
    capabilities: normalizedReferenceCapabilities(model),
    ...(model.provider==='vercel'?{qualities:model.qualities,defaultQuality:model.defaultQuality,imageSizes:model.imageSizes,defaultImageSize:model.defaultImageSize}:{}),
  };
}

// Every AI Gateway image price is computed locally, so the page receives the
// full table up front and shows the cost instantly instead of asking the
// server on each change. Keys are "ratio|quality|size"; anything missing
// falls back to the /api/model-cost request.
function imageCostTable(model,creditsPerUsd) {
  const table={},estimates=[];
  for (const aspectRatio of model.aspectRatios||[]) {
    for (const quality of model.qualities?.length?model.qualities:['']) {
      for (const imageSize of model.imageSizes?.length?model.imageSizes:['']) {
        try {
          const quote=quoteGateway(model,{aspectRatio,quality:quality||undefined,imageSize:imageSize||undefined},creditsPerUsd);
          const key=aspectRatio+'|'+quality+'|'+imageSize;
          if (Number.isFinite(Number(quote.cost))) {table[key]=Number(quote.cost);if(quote.isEstimate)estimates.push(key);}
        } catch {}
      }
    }
  }
  return {costTable:table,costEstimates:estimates};
}

// One entry per model name: models already in the list (direct sources) keep
// their place and gateway copies with the same name are left out.
function addMissingImageModels(list, extra) {
  const key = model => String(model?.label || '').trim().toLowerCase();
  const taken = new Set(list.map(key));
  return [...list, ...extra.filter(model => !taken.has(key(model)))];
}

async function publicProviderCatalog(provider, { creditsPerUsd } = {}) {
  const models = (await listProviderModels(provider, { enabledOnly: true, availableOnly: true }))
    .filter(isPlausibleCustomerModel).filter(model=>provider!=='vercel'||model.ready);
  const withCosts = model => provider==='vercel' && creditsPerUsd
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

module.exports = {
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

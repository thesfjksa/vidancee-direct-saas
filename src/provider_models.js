const { getPool } = require('./db.js');

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
  const hay = (String(providerModelId || '') + ' ' + String(label || '')).toLowerCase();
  if (/seedance[^\n]*2[._ -]?5/.test(hay)) return 'seedance_2.5';
  if (/seedance[^\n]*2[._ -]?0/.test(hay) && /fast|mini/.test(hay)) return 'seedance_2.0_fast';
  if (/minimax[^\n]*(h3|hailuo[^\n]*3)/.test(hay)) return 'minimax_h3';

  const base = slug(providerModelId || label);
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
    lastSeenAt: row.last_seen_at,
  };
  if (includeInternal) {
    base.provider = row.provider;
    base.providerModelId = row.provider_model_id;
    base.toolName = row.tool_name;
    base.inputSchema = safeJson(row.input_schema, {});
  }
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
  };
}

async function publicProviderCatalog(provider) {
  const models = await listProviderModels(provider, { enabledOnly: true, availableOnly: true });
  return {
    video: models.filter(model => model.mediaType === 'video').map(publicVideoModel),
    image: models.filter(model => model.mediaType === 'image').map(publicImageModel),
  };
}

module.exports = {
  safeJson,
  humanizeModelId,
  canonicalPublicModelId,
  syncProviderModels,
  listProviderModels,
  getProviderModelByPublicId,
  setProviderModelEnabled,
  publicProviderCatalog,
};

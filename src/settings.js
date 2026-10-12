const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { defaultSmartImageConfig, normalizeSmartImageConfig, SMART_IMAGE_MODELS, DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD, SMART_IMAGE_PRICING_REVISION } = require('./smartaipi_images.js');
const { smartAipiBaseUrl } = require('./provider/smartaipi.js');
const { GEMINI_ENHANCER_MODEL } = require('./prompt_enhancer.js');

const { DEFAULT_VERCEL_CREDITS_PER_USD } = require('./vercel_models.js');

const DEFAULTS = {
  vercel_api_key: '',
  vercel_enabled: 'true',
  vercel_max_inflight: '2',
  vercel_customer_credits_per_usd: String(DEFAULT_VERCEL_CREDITS_PER_USD),
  argolink_api_key: '',
  argolink_enabled: 'true',
  argolink_max_inflight: '3',
  argolink_customer_credits_per_usd: String(DEFAULT_VERCEL_CREDITS_PER_USD),
  wavespeed_api_key: '',
  wavespeed_enabled: 'true',
  wavespeed_max_inflight: '3',
  wavespeed_customer_credits_per_usd: String(DEFAULT_VERCEL_CREDITS_PER_USD),
  prompt_enhancer_enabled: 'true',
  prompt_enhancer_gemini_api_key: '',
  vidancee_base_url: 'https://vidancee.com',
  vidancee_email: '',
  vidancee_password: '',
  vidancee_enabled: 'true',
  createpulse_base_url: 'https://createpulse.online',
  createpulse_api_key: '',
  createpulse_max_inflight: '3',
  createpulse_enabled: 'true',
  smartaipi_base_url: 'https://api.smartaipi.com/v1',
  smartaipi_api_key: '',
  smartaipi_enabled: 'true',
  smartaipi_max_inflight: '2',
  smartaipi_customer_credits_per_usd: String(DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD),
  smartaipi_pricing_revision: '',
  smartaipi_models: JSON.stringify(defaultSmartImageConfig()),
  vgenv_base_url: 'https://api.vgenv.com',
  vgenv_api_key: '',
  vgenv_max_inflight: '4',
  vgenv_enabled: 'true',
  vibi_base_url: 'https://api.vibi.pro',
  vibi_api_key: '',
  vibi_enabled: 'true',
  vibi_max_inflight: '4',
  vibi_clone_customer_cost: '0',
  provider_routing: 'overflow',
  allow_provider_charges: 'false',
};

function keyMaterial() {
  const root = String(process.env.SETTINGS_ENCRYPTION_KEY || process.env.ADMIN_TOKEN || '');
  if (!root) throw new Error('A settings encryption secret is required.');
  return crypto.createHash('sha256').update(root).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(':');
}

function decrypt(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (!raw.startsWith('v1:')) return raw;
  const parts = raw.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

async function ensureSettingsTable() {
  const db = getPool();
  await db.query(`CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(120) NOT NULL,
    setting_value LONGTEXT NOT NULL,
    is_secret TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (setting_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function rowsMap() {
  const db = getPool();
  await ensureSettingsTable();
  const [rows] = await db.query('SELECT setting_key, setting_value, is_secret FROM app_settings');
  return new Map(rows.map(r => [r.setting_key, r]));
}

async function put(key, value, secret = false) {
  const db = getPool();
  await ensureSettingsTable();
  await db.execute(
    'INSERT INTO app_settings (setting_key, setting_value, is_secret) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), is_secret=VALUES(is_secret), updated_at=UTC_TIMESTAMP()',
    [key, secret ? encrypt(value) : String(value), secret ? 1 : 0]
  );
}

async function del(key) {
  const db = getPool();
  await ensureSettingsTable();
  await db.execute('DELETE FROM app_settings WHERE setting_key=?', [key]);
}

async function getSettingValue(key, fallback = '') {
  const rows = await rowsMap();
  const row = rows.get(String(key));
  if (!row) return fallback;
  return Number(row.is_secret) ? decrypt(row.setting_value) : String(row.setting_value || '');
}

async function setSettingValue(key, value, { secret = false } = {}) {
  await put(String(key), value == null ? '' : String(value), secret);
}

async function deleteSettingValue(key) {
  await del(String(key));
}

function normalizeUrl(value, fallback) {
  const parsed = new URL(String(value || fallback));
  if (parsed.protocol !== 'https:') throw new Error('Provider URLs must use HTTPS.');
  return parsed.origin;
}

function asBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

async function getProviderSettings() {
  const rows = await rowsMap();
  const read = key => {
    const row = rows.get(key);
    if (!row) return DEFAULTS[key];
    return Number(row.is_secret) ? decrypt(row.setting_value) : String(row.setting_value || '');
  };
  const routing = String(read('provider_routing') || 'overflow');
  return {
    vercelApiKey: String(read('vercel_api_key') || '').trim(),
    vercelEnabled: asBool(read('vercel_enabled')),
    vercelMaxInflight: Math.max(1, Math.min(10, Number(read('vercel_max_inflight') || 2))),
    vercelCustomerCreditsPerUsd: Number(read('vercel_customer_credits_per_usd') || DEFAULT_VERCEL_CREDITS_PER_USD),
    argoLinkApiKey: String(read('argolink_api_key') || '').trim(),
    argoLinkEnabled: asBool(read('argolink_enabled')),
    argoLinkMaxInflight: Math.max(1, Math.min(10, Number(read('argolink_max_inflight') || 3))),
    argoLinkCustomerCreditsPerUsd: Number(read('argolink_customer_credits_per_usd') || DEFAULT_VERCEL_CREDITS_PER_USD),
    waveSpeedApiKey: String(read('wavespeed_api_key') || '').trim(),
    waveSpeedEnabled: asBool(read('wavespeed_enabled')),
    waveSpeedMaxInflight: Math.max(1, Math.min(10, Number(read('wavespeed_max_inflight') || 3))),
    waveSpeedCustomerCreditsPerUsd: Number(read('wavespeed_customer_credits_per_usd') || DEFAULT_VERCEL_CREDITS_PER_USD),
    promptEnhancerEnabled: asBool(read('prompt_enhancer_enabled')),
    promptEnhancerApiKey: String(read('prompt_enhancer_gemini_api_key') || '').trim(),
    vidanceeBaseUrl: normalizeUrl(read('vidancee_base_url'), DEFAULTS.vidancee_base_url),
    vidanceeEmail: String(read('vidancee_email') || '').trim(),
    vidanceePassword: String(read('vidancee_password') || ''),
    vidanceeEnabled: asBool(read('vidancee_enabled')),
    createPulseBaseUrl: normalizeUrl(read('createpulse_base_url'), DEFAULTS.createpulse_base_url),
    createPulseApiKey: String(read('createpulse_api_key') || '').trim(),
    createPulseMaxInflight: Math.max(1, Math.min(50, Number(read('createpulse_max_inflight') || 3))),
    createPulseEnabled: asBool(read('createpulse_enabled')),
    smartAipiBaseUrl: smartAipiBaseUrl(read('smartaipi_base_url')),
    smartAipiApiKey: String(read('smartaipi_api_key') || '').trim(),
    smartAipiEnabled: asBool(read('smartaipi_enabled')),
    smartAipiMaxInflight: Math.max(1, Math.min(10, Number(read('smartaipi_max_inflight') || 2))),
    // Adopt the requested 160-credit policy once; subsequent Admin overrides persist.
    smartAipiCustomerCreditsPerUsd: read('smartaipi_pricing_revision') === SMART_IMAGE_PRICING_REVISION
      ? Number(read('smartaipi_customer_credits_per_usd') || DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD)
      : DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD,
    smartAipiModels: normalizeSmartImageConfig(JSON.parse(read('smartaipi_models'))),
    vgenvBaseUrl: normalizeUrl(read('vgenv_base_url'), DEFAULTS.vgenv_base_url),
    vgenvApiKey: String(read('vgenv_api_key') || '').trim(),
    vgenvMaxInflight: Math.max(1, Math.min(50, Number(read('vgenv_max_inflight') || 4))),
    vgenvEnabled: asBool(read('vgenv_enabled')),
    vibiBaseUrl: normalizeUrl(read('vibi_base_url'), DEFAULTS.vibi_base_url),
    vibiApiKey: String(read('vibi_api_key') || '').trim(),
    vibiEnabled: asBool(read('vibi_enabled')),
    vibiMaxInflight: Math.max(1, Math.min(20, Number(read('vibi_max_inflight') || 4))),
    vibiCloneCustomerCost: Math.max(0, Number(read('vibi_clone_customer_cost') || 0)),
    routing: ['overflow','balanced','createpulse-first'].includes(routing) ? routing : 'overflow',
    allowProviderCharges: asBool(read('allow_provider_charges')),
  };
}

async function getAdminProviderSettings() {
  const s = await getProviderSettings();
  return {
    vercel: {
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
      apiKeyConfigured: Boolean(s.vercelApiKey), configured: Boolean(s.vercelApiKey),
      enabled: s.vercelEnabled, active: Boolean(s.vercelEnabled && s.vercelApiKey),
      maxInflight: s.vercelMaxInflight, customerCreditsPerUsd: s.vercelCustomerCreditsPerUsd,
    },
    argolink: {
      baseUrl: 'https://argolink.io/v1',
      apiKeyConfigured: Boolean(s.argoLinkApiKey), configured: Boolean(s.argoLinkApiKey),
      enabled: s.argoLinkEnabled, active: Boolean(s.argoLinkEnabled && s.argoLinkApiKey),
      maxInflight: s.argoLinkMaxInflight, customerCreditsPerUsd: s.argoLinkCustomerCreditsPerUsd,
    },
    wavespeed: {
      baseUrl: 'https://api.wavespeed.ai/api/v3',
      apiKeyConfigured: Boolean(s.waveSpeedApiKey), configured: Boolean(s.waveSpeedApiKey),
      enabled: s.waveSpeedEnabled, active: Boolean(s.waveSpeedEnabled && s.waveSpeedApiKey),
      maxInflight: s.waveSpeedMaxInflight, customerCreditsPerUsd: s.waveSpeedCustomerCreditsPerUsd,
    },
    promptEnhancer: {
      model: GEMINI_ENHANCER_MODEL, enabled: s.promptEnhancerEnabled,
      apiKeyConfigured: Boolean(s.promptEnhancerApiKey),
      active: Boolean(s.promptEnhancerEnabled && s.promptEnhancerApiKey && s.allowProviderCharges),
    },
    vidancee: {
      baseUrl: s.vidanceeBaseUrl,
      email: s.vidanceeEmail,
      passwordConfigured: Boolean(s.vidanceePassword),
      configured: Boolean(s.vidanceeEmail && s.vidanceePassword),
      enabled: Boolean(s.vidanceeEnabled),
      active: Boolean(s.vidanceeEnabled && s.vidanceeEmail && s.vidanceePassword),
    },
    createpulse: {
      baseUrl: s.createPulseBaseUrl,
      apiKeyConfigured: Boolean(s.createPulseApiKey),
      maxInflight: s.createPulseMaxInflight,
      configured: Boolean(s.createPulseApiKey),
      enabled: Boolean(s.createPulseEnabled),
      active: Boolean(s.createPulseEnabled && s.createPulseApiKey),
    },
    smartaipi: {
      baseUrl: s.smartAipiBaseUrl,
      apiKeyConfigured: Boolean(s.smartAipiApiKey),
      configured: Boolean(s.smartAipiApiKey),
      enabled: s.smartAipiEnabled,
      active: Boolean(s.smartAipiEnabled && s.smartAipiApiKey),
      maxInflight: s.smartAipiMaxInflight,
      customerCreditsPerUsd: s.smartAipiCustomerCreditsPerUsd,
      models: SMART_IMAGE_MODELS.map(m => ({ id: m.id, label: m.label, apiModel: m.apiModel, ...s.smartAipiModels[m.id] })),
    },
    vgenv: {
      baseUrl: s.vgenvBaseUrl,
      apiKeyConfigured: Boolean(s.vgenvApiKey),
      maxInflight: s.vgenvMaxInflight,
      configured: Boolean(s.vgenvApiKey),
      enabled: Boolean(s.vgenvEnabled),
      active: Boolean(s.vgenvEnabled && s.vgenvApiKey),
    },
    vibi: {
      baseUrl: s.vibiBaseUrl,
      apiKeyConfigured: Boolean(s.vibiApiKey),
      maxInflight: s.vibiMaxInflight,
      cloneCustomerCost: s.vibiCloneCustomerCost,
      configured: Boolean(s.vibiApiKey),
      enabled: Boolean(s.vibiEnabled),
      active: Boolean(s.vibiEnabled && s.vibiApiKey),
    },
    routing: s.routing,
    allowProviderCharges: s.allowProviderCharges,
  };
}

async function updateProviderSettings(input = {}) {
  // Validate every new source field before writing any settings.
  const vercelUpdates=[];
  if ('vercelEnabled' in input) {
    if (typeof input.vercelEnabled !== 'boolean') throw Object.assign(new Error('AI Gateway enabled must be true or false.'), {statusCode:400});
    vercelUpdates.push(['vercel_enabled',input.vercelEnabled?'true':'false']);
  }
  if ('vercelApiKey' in input && (typeof input.vercelApiKey !== 'string' || input.vercelApiKey.length>512))
    throw Object.assign(new Error('Invalid AI Gateway API key.'), {statusCode:400});
  if ('vercelMaxInflight' in input) {
    const n=Number(input.vercelMaxInflight);
    if (!Number.isInteger(n)||n<1||n>10) throw Object.assign(new Error('AI Gateway max inflight must be 1 to 10.'), {statusCode:400});
    vercelUpdates.push(['vercel_max_inflight',String(n)]);
  }
  if ('vercelCustomerCreditsPerUsd' in input) {
    const n=Number(input.vercelCustomerCreditsPerUsd);
    if (!Number.isFinite(n)||n<=0||n>1000000) throw Object.assign(new Error('AI Gateway credits per USD must be greater than zero and at most 1000000.'), {statusCode:400});
    vercelUpdates.push(['vercel_customer_credits_per_usd',String(n)]);
  }
  const waveUpdates=[];
  if ('waveSpeedEnabled' in input) {
    if (typeof input.waveSpeedEnabled !== 'boolean') throw Object.assign(new Error('WaveSpeed enabled must be true or false.'), {statusCode:400});
    waveUpdates.push(['wavespeed_enabled',input.waveSpeedEnabled?'true':'false']);
  }
  if ('waveSpeedApiKey' in input && (typeof input.waveSpeedApiKey !== 'string' || input.waveSpeedApiKey.length>512))
    throw Object.assign(new Error('Invalid WaveSpeed API key.'), {statusCode:400});
  if ('waveSpeedMaxInflight' in input) {
    const n=Number(input.waveSpeedMaxInflight);
    if (!Number.isInteger(n)||n<1||n>10) throw Object.assign(new Error('WaveSpeed max inflight must be 1 to 10.'), {statusCode:400});
    waveUpdates.push(['wavespeed_max_inflight',String(n)]);
  }
  if ('waveSpeedCustomerCreditsPerUsd' in input) {
    const n=Number(input.waveSpeedCustomerCreditsPerUsd);
    if (!Number.isFinite(n)||n<=0||n>1000000) throw Object.assign(new Error('WaveSpeed credits per USD must be greater than zero and at most 1000000.'), {statusCode:400});
    waveUpdates.push(['wavespeed_customer_credits_per_usd',String(n)]);
  }
  const argoUpdates=[];
  if ('argoLinkEnabled' in input) {
    if (typeof input.argoLinkEnabled !== 'boolean') throw Object.assign(new Error('ArgoLink enabled must be true or false.'), {statusCode:400});
    argoUpdates.push(['argolink_enabled',input.argoLinkEnabled?'true':'false']);
  }
  if ('argoLinkApiKey' in input && (typeof input.argoLinkApiKey !== 'string' || input.argoLinkApiKey.length>512))
    throw Object.assign(new Error('Invalid ArgoLink API key.'), {statusCode:400});
  if ('argoLinkMaxInflight' in input) {
    const n=Number(input.argoLinkMaxInflight);
    if (!Number.isInteger(n)||n<1||n>10) throw Object.assign(new Error('ArgoLink max inflight must be 1 to 10.'), {statusCode:400});
    argoUpdates.push(['argolink_max_inflight',String(n)]);
  }
  if ('argoLinkCustomerCreditsPerUsd' in input) {
    const n=Number(input.argoLinkCustomerCreditsPerUsd);
    if (!Number.isFinite(n)||n<=0||n>1000000) throw Object.assign(new Error('ArgoLink credits per USD must be greater than zero and at most 1000000.'), {statusCode:400});
    argoUpdates.push(['argolink_customer_credits_per_usd',String(n)]);
  }
  if ('promptEnhancerEnabled' in input && typeof input.promptEnhancerEnabled !== 'boolean') {
    throw Object.assign(new Error('Prompt enhancer enabled must be true or false.'), { statusCode: 400 });
  }
  if ('promptEnhancerApiKey' in input && (typeof input.promptEnhancerApiKey !== 'string' || input.promptEnhancerApiKey.length > 512)) {
    throw Object.assign(new Error('Invalid prompt enhancer API key.'), { statusCode: 400 });
  }
  const smartUpdates = [];
  if ('smartAipiBaseUrl' in input) smartUpdates.push(['smartaipi_base_url', smartAipiBaseUrl(input.smartAipiBaseUrl || DEFAULTS.smartaipi_base_url)]);
  if ('smartAipiEnabled' in input) smartUpdates.push(['smartaipi_enabled', input.smartAipiEnabled ? 'true' : 'false']);
  if ('smartAipiMaxInflight' in input) {
    const n = Number(input.smartAipiMaxInflight);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('SmartAIPI max inflight must be 1 to 10.');
    smartUpdates.push(['smartaipi_max_inflight', String(n)]);
  }
  if ('smartAipiCustomerCreditsPerUsd' in input) {
    const n = Number(input.smartAipiCustomerCreditsPerUsd);
    if (!Number.isFinite(n) || n <= 0 || n > 1000000) throw Object.assign(new Error('SmartAIPI customer credits per USD must be greater than zero and at most 1000000.'), { statusCode: 400 });
    smartUpdates.push(['smartaipi_customer_credits_per_usd', String(n)]);
    smartUpdates.push(['smartaipi_pricing_revision', SMART_IMAGE_PRICING_REVISION]);
  }
  if ('smartAipiModels' in input) smartUpdates.push(['smartaipi_models', JSON.stringify(normalizeSmartImageConfig(input.smartAipiModels))]);

  if ('vidanceeBaseUrl' in input) await put('vidancee_base_url', normalizeUrl(input.vidanceeBaseUrl, DEFAULTS.vidancee_base_url));
  if ('vidanceeEmail' in input) await put('vidancee_email', String(input.vidanceeEmail || '').trim());
  if ('vidanceeEnabled' in input) await put('vidancee_enabled', input.vidanceeEnabled ? 'true' : 'false');
  if (input.clearVidanceePassword === true) await del('vidancee_password');
  else if (String(input.vidanceePassword || '').length) await put('vidancee_password', String(input.vidanceePassword), true);

  if ('createPulseBaseUrl' in input) await put('createpulse_base_url', normalizeUrl(input.createPulseBaseUrl, DEFAULTS.createpulse_base_url));
  if ('createPulseEnabled' in input) await put('createpulse_enabled', input.createPulseEnabled ? 'true' : 'false');
  if (input.clearCreatePulseApiKey === true) await del('createpulse_api_key');
  else if (String(input.createPulseApiKey || '').trim()) await put('createpulse_api_key', String(input.createPulseApiKey).trim(), true);

  if ('createPulseMaxInflight' in input) {
    const n = Number(input.createPulseMaxInflight);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Max inflight must be 1 to 50.');
    await put('createpulse_max_inflight', String(n));
  }
  if ('vgenvBaseUrl' in input) await put('vgenv_base_url', normalizeUrl(input.vgenvBaseUrl, DEFAULTS.vgenv_base_url));
  if ('vgenvEnabled' in input) await put('vgenv_enabled', input.vgenvEnabled ? 'true' : 'false');
  if (input.clearVgenvApiKey === true) await del('vgenv_api_key');
  else if (String(input.vgenvApiKey || '').trim()) await put('vgenv_api_key', String(input.vgenvApiKey).trim(), true);

  if ('vgenvMaxInflight' in input) {
    const n = Number(input.vgenvMaxInflight);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('vgenv max inflight must be 1 to 50.');
    await put('vgenv_max_inflight', String(n));
  }

  if ('vibiBaseUrl' in input) await put('vibi_base_url', normalizeUrl(input.vibiBaseUrl, DEFAULTS.vibi_base_url));
  if ('vibiEnabled' in input) await put('vibi_enabled', input.vibiEnabled ? 'true' : 'false');
  if (input.clearVibiApiKey === true) await del('vibi_api_key');
  else if (String(input.vibiApiKey || '').trim()) await put('vibi_api_key', String(input.vibiApiKey).trim(), true);
  if ('vibiMaxInflight' in input) {
    const n = Number(input.vibiMaxInflight);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('Vibi max inflight must be 1 to 20.');
    await put('vibi_max_inflight', String(n));
  }
  if ('vibiCloneCustomerCost' in input) {
    const n = Number(input.vibiCloneCustomerCost);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error('Vibi clone customer cost must be zero or greater.');
    await put('vibi_clone_customer_cost', String(n));
  }

  if ('promptEnhancerEnabled' in input) await put('prompt_enhancer_enabled', input.promptEnhancerEnabled ? 'true' : 'false');
  if (input.clearPromptEnhancerApiKey === true) await del('prompt_enhancer_gemini_api_key');
  else if (String(input.promptEnhancerApiKey || '').trim()) await put('prompt_enhancer_gemini_api_key', String(input.promptEnhancerApiKey).trim(), true);

  for (const [key, value] of smartUpdates) await put(key, value);
  if (input.clearSmartAipiApiKey === true) await del('smartaipi_api_key');
  else if (String(input.smartAipiApiKey || '').trim()) await put('smartaipi_api_key', String(input.smartAipiApiKey).trim(), true);

  for (const [key,value] of vercelUpdates) await put(key,value);
  if (input.clearVercelApiKey===true) await del('vercel_api_key');
  else if (String(input.vercelApiKey||'').trim()) await put('vercel_api_key',input.vercelApiKey.trim(),true);

  for (const [key,value] of waveUpdates) await put(key,value);
  if (input.clearWaveSpeedApiKey===true) await del('wavespeed_api_key');
  else if (String(input.waveSpeedApiKey||'').trim()) await put('wavespeed_api_key',input.waveSpeedApiKey.trim(),true);

  for (const [key,value] of argoUpdates) await put(key,value);
  if (input.clearArgoLinkApiKey===true) await del('argolink_api_key');
  else if (String(input.argoLinkApiKey||'').trim()) await put('argolink_api_key',input.argoLinkApiKey.trim(),true);

  if ('routing' in input) {
    const routing = String(input.routing || '');
    if (!['overflow','balanced','createpulse-first'].includes(routing)) throw new Error('Invalid routing mode.');
    await put('provider_routing', routing);
  }
  if ('allowProviderCharges' in input) await put('allow_provider_charges', input.allowProviderCharges ? 'true' : 'false');
  return getAdminProviderSettings();
}

async function migrateLegacyProviderEnvSettings() {
  const rows = await rowsMap();
  const tasks = [];
  const plain = (key, env) => {
    const value = String(process.env[env] || '').trim();
    if (!rows.has(key) && value) tasks.push(put(key, value, false));
  };
  const secret = (key, env) => {
    const value = String(process.env[env] || '');
    if (!rows.has(key) && value) tasks.push(put(key, value, true));
  };
  secret('vercel_api_key', 'AI_GATEWAY_API_KEY');
  plain('vercel_enabled', 'AI_GATEWAY_ENABLED');
  plain('vercel_max_inflight', 'AI_GATEWAY_MAX_INFLIGHT');
  secret('argolink_api_key', 'ARGOLINK_API_KEY');
  secret('wavespeed_api_key', 'WAVESPEED_API_KEY');
  plain('vidancee_base_url', 'VIDANCEE_BASE_URL');
  plain('vidancee_email', 'VIDANCEE_EMAIL');
  secret('vidancee_password', 'VIDANCEE_PASSWORD');
  plain('vidancee_enabled', 'VIDANCEE_ENABLED');
  plain('createpulse_base_url', 'CREATEPULSE_BASE_URL');
  secret('createpulse_api_key', 'CREATEPULSE_API_KEY');
  plain('createpulse_max_inflight', 'CREATEPULSE_MAX_INFLIGHT');
  plain('createpulse_enabled', 'CREATEPULSE_ENABLED');
  plain('vgenv_base_url', 'VGENV_BASE_URL');
  secret('vgenv_api_key', 'VGENV_API_KEY');
  plain('vgenv_max_inflight', 'VGENV_MAX_INFLIGHT');
  plain('vgenv_enabled', 'VGENV_ENABLED');
  plain('vibi_base_url', 'VIBI_BASE_URL');
  secret('vibi_api_key', 'VIBI_API_KEY');
  plain('vibi_enabled', 'VIBI_ENABLED');
  plain('vibi_max_inflight', 'VIBI_MAX_INFLIGHT');
  plain('vibi_clone_customer_cost', 'VIBI_CLONE_CUSTOMER_COST');
  plain('provider_routing', 'PROVIDER_ROUTING');
  plain('allow_provider_charges', 'ALLOW_PROVIDER_CHARGES');
  await Promise.all(tasks);
  return tasks.length;
}

module.exports = {
  getProviderSettings,
  getAdminProviderSettings,
  updateProviderSettings,
  migrateLegacyProviderEnvSettings,
  getSettingValue,
  setSettingValue,
  deleteSettingValue,
};


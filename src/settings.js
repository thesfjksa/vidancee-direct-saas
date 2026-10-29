const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { defaultSmartImageConfig, normalizeSmartImageConfig, SMART_IMAGE_MODELS, DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD, SMART_IMAGE_PRICING_REVISION } = require('./smartaipi_images.js');
const { smartAipiBaseUrl } = require('./provider/smartaipi.js');
const { GEMINI_ENHANCER_MODEL } = require('./prompt_enhancer.js');

const { DEFAULT_VERCEL_CREDITS_PER_USD } = require('./vercel_models.js');
const { CREDITS_PER_USD, CREDITS_PER_CNY } = require('./billing.js');

const DEFAULTS = {
  vercel_api_key: '',
  vercel_enabled: 'true',
  vercel_max_inflight: '2',
  vercel_customer_credits_per_usd: String(DEFAULT_VERCEL_CREDITS_PER_USD),
  api888_api_key: '',
  api888_enabled: 'false',
  api888_max_inflight: '2',
  argolink_api_key: '',
  argolink_enabled: 'true',
  argolink_max_inflight: '3',
  argolink_customer_credits_per_usd: String(DEFAULT_VERCEL_CREDITS_PER_USD),
  higgsfield_api_key: '',
  higgsfield_enabled: 'true',
  higgsfield_max_inflight: '3',
  sluice_api_key: '',
  sluice_enabled: 'true',
  sluice_max_inflight: '3',
  vidancee_email: '',
  vidancee_enabled: 'false',
  vidancee_password: '',
  vidancee_max_inflight: '1',
  fal_api_key: '',
  fal_enabled: 'true',
  fal_max_inflight: '3',
  fal_customer_credits_per_usd: String(DEFAULT_VERCEL_CREDITS_PER_USD),
  prompt_enhancer_enabled: 'true',
  prompt_enhancer_gemini_api_key: '',
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

const settingsTableReady=new WeakSet();

// MySQL checks CREATE privileges even for CREATE TABLE IF NOT EXISTS when
// the table already exists. Hostinger production users can have SELECT/INSERT/
// UPDATE rights on app_settings without CREATE; reading settings must still work.
async function ensureSettingsTable(db=getPool()) {
  if(settingsTableReady.has(db))return;
  try {
    // Read-only schema probe: no DDL privilege needed for existing tables.
    await db.query('SELECT setting_key, setting_value, is_secret FROM app_settings LIMIT 0');
    settingsTableReady.add(db);
    return;
  }catch(error){
    // A missing table still needs creation; do not mask SELECT permission errors.
    if(error.code!=='ER_NO_SUCH_TABLE')throw error;
  }
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(120) NOT NULL,
      setting_value LONGTEXT NOT NULL,
      is_secret TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }catch(error){
    if(['ER_TABLEACCESS_DENIED_ERROR','ER_DBACCESS_DENIED_ERROR','ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(error.code)){
      const denied=new Error('app_settings is missing and this MySQL user cannot create it. Create the table with a database administrator account or grant CREATE permission in Hostinger.');
      denied.code='APP_SETTINGS_CREATE_PERMISSION_REQUIRED';
      denied.cause=error;
      throw denied;
    }
    throw error;
  }
  // Verify the table and required columns before claiming settings are ready.
  await db.query('SELECT setting_key, setting_value, is_secret FROM app_settings LIMIT 0');
  settingsTableReady.add(db);
}

async function rowsMap() {
  const db = getPool();
  await ensureSettingsTable(db);
  const [rows] = await db.query('SELECT setting_key, setting_value, is_secret FROM app_settings');
  return new Map(rows.map(r => [r.setting_key, r]));
}

async function put(key, value, secret = false) {
  const db = getPool();
  await ensureSettingsTable(db);
  await db.execute(
    'INSERT INTO app_settings (setting_key, setting_value, is_secret) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), is_secret=VALUES(is_secret), updated_at=UTC_TIMESTAMP()',
    [key, secret ? encrypt(value) : String(value), secret ? 1 : 0]
  );
}

async function del(key) {
  const db = getPool();
  await ensureSettingsTable(db);
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

/** Save OAuth client credentials atomically, encrypted at rest in app_settings. */
async function saveGoogleDriveOAuthCredentials(clientId, clientSecret) {
  const db=getPool();
  await ensureSettingsTable(db);
  const conn=await db.getConnection();
  try {
    await conn.beginTransaction();
    for(const [key,value] of [['gdrive_oauth_client_id',clientId],['gdrive_oauth_client_secret',clientSecret]]) {
      await conn.execute(
        'INSERT INTO app_settings (setting_key, setting_value, is_secret) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), is_secret=1, updated_at=UTC_TIMESTAMP()',
        [key,encrypt(value)]
      );
    }
    // An in-progress OAuth exchange for an older client must not be allowed
    // after the credentials have changed.
    await conn.execute('DELETE FROM app_settings WHERE setting_key=?',['gdrive_oauth_state']);
    await conn.commit();
  }catch(error) {
    await conn.rollback().catch(()=>{});
    throw error;
  }finally{conn.release();}
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
  return {
    vercelApiKey: String(read('vercel_api_key') || '').trim(),
    vercelEnabled: asBool(read('vercel_enabled')),
    vercelMaxInflight: Math.max(1, Math.min(10, Number(read('vercel_max_inflight') || 2))),
    // Every USD-priced source converts at cost (1 credit = Rs 1, Rs 280 per USD);
    // the profit is in the plan price, so these rates are no longer settings.
    vercelCustomerCreditsPerUsd: CREDITS_PER_USD,
    api888ApiKey: String(read('api888_api_key') || '').trim(),
    api888Enabled: asBool(read('api888_enabled')),
    api888MaxInflight: Math.max(1,Math.min(10,Number(read('api888_max_inflight')||6))),
    argoLinkApiKey: String(read('argolink_api_key') || '').trim(),
    argoLinkEnabled: asBool(read('argolink_enabled')),
    argoLinkMaxInflight: Math.max(1, Math.min(10, Number(read('argolink_max_inflight') || 3))),
    argoLinkCustomerCreditsPerUsd: CREDITS_PER_USD,
    higgsfieldApiKey: String(read('higgsfield_api_key') || '').trim(),
    higgsfieldEnabled: asBool(read('higgsfield_enabled')),
    higgsfieldMaxInflight: Math.max(1, Math.min(10, Number(read('higgsfield_max_inflight') || 3))),
    higgsfieldCustomerCreditsPerUsd: CREDITS_PER_USD,
    sluiceApiKey: String(read('sluice_api_key') || '').trim(),
    sluiceEnabled: asBool(read('sluice_enabled')),
    sluiceMaxInflight: Math.max(1, Math.min(10, Number(read('sluice_max_inflight') || 3))),
    sluiceCustomerCreditsPerUsd: CREDITS_PER_USD,
    vidanceeEmail: String(read('vidancee_email') || '').trim(),
    vidanceePassword: String(read('vidancee_password') || ''),
    vidanceeEnabled: asBool(read('vidancee_enabled')),
    vidanceeMaxInflight: 1,
    vidanceeCustomerCreditsPerUsd: CREDITS_PER_USD,
    falApiKey: String(read('fal_api_key') || '').trim(),
    falEnabled: asBool(read('fal_enabled')),
    falMaxInflight: Math.max(1, Math.min(10, Number(read('fal_max_inflight') || 3))),
    falCustomerCreditsPerUsd: CREDITS_PER_USD,
    promptEnhancerEnabled: asBool(read('prompt_enhancer_enabled')),
    promptEnhancerApiKey: String(read('prompt_enhancer_gemini_api_key') || '').trim(),
    smartAipiBaseUrl: smartAipiBaseUrl(read('smartaipi_base_url')),
    smartAipiApiKey: String(read('smartaipi_api_key') || '').trim(),
    smartAipiEnabled: asBool(read('smartaipi_enabled')),
    smartAipiMaxInflight: Math.max(1, Math.min(10, Number(read('smartaipi_max_inflight') || 2))),
    smartAipiCustomerCreditsPerUsd: CREDITS_PER_USD,
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
    api888: {
      baseUrl: 'https://888api.xin/v1',
      apiKeyConfigured: Boolean(s.api888ApiKey), configured: Boolean(s.api888ApiKey),
      enabled: s.api888Enabled, active: Boolean(s.api888Enabled && s.api888ApiKey),
      maxInflight: s.api888MaxInflight, creditPolicy: 'cny_at_cost', creditsPerCny: CREDITS_PER_CNY,
    },
    argolink: {
      baseUrl: 'https://argolink.io/v1',
      apiKeyConfigured: Boolean(s.argoLinkApiKey), configured: Boolean(s.argoLinkApiKey),
      enabled: s.argoLinkEnabled, active: Boolean(s.argoLinkEnabled && s.argoLinkApiKey),
      maxInflight: s.argoLinkMaxInflight, customerCreditsPerUsd: s.argoLinkCustomerCreditsPerUsd,
    },
    higgsfield: {
      baseUrl: 'https://api.higgsfield.ai',
      apiKeyConfigured: Boolean(s.higgsfieldApiKey), configured: Boolean(s.higgsfieldApiKey),
      enabled: s.higgsfieldEnabled, active: Boolean(s.higgsfieldEnabled && s.higgsfieldApiKey),
      maxInflight: s.higgsfieldMaxInflight, customerCreditsPerUsd: s.higgsfieldCustomerCreditsPerUsd,
    },
    sluice: {
      baseUrl: 'https://www.getsluice.com',
      apiKeyConfigured: Boolean(s.sluiceApiKey), configured: Boolean(s.sluiceApiKey),
      enabled: s.sluiceEnabled, active: Boolean(s.sluiceEnabled && s.sluiceApiKey),
      maxInflight: s.sluiceMaxInflight, customerCreditsPerUsd: s.sluiceCustomerCreditsPerUsd,
    },
    vidancee: {
      baseUrl: 'https://vidancee.com',
      apiKeyConfigured: Boolean(s.vidanceeEmail && s.vidanceePassword), configured: Boolean(s.vidanceeEmail && s.vidanceePassword),
      enabled: s.vidanceeEnabled, active: Boolean(s.vidanceeEnabled && s.vidanceeEmail && s.vidanceePassword),
      maxInflight: s.vidanceeMaxInflight, customerCreditsPerUsd: s.vidanceeCustomerCreditsPerUsd,
    },
    fal: {
      baseUrl: 'https://queue.fal.run',
      apiKeyConfigured: Boolean(s.falApiKey), configured: Boolean(s.falApiKey),
      enabled: s.falEnabled, active: Boolean(s.falEnabled && s.falApiKey),
      maxInflight: s.falMaxInflight, customerCreditsPerUsd: s.falCustomerCreditsPerUsd,
    },
    promptEnhancer: {
      model: GEMINI_ENHANCER_MODEL, enabled: s.promptEnhancerEnabled,
      apiKeyConfigured: Boolean(s.promptEnhancerApiKey),
      active: Boolean(s.promptEnhancerEnabled && s.promptEnhancerApiKey && s.allowProviderCharges),
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
  const falUpdates=[];
  if ('falEnabled' in input) {
    if (typeof input.falEnabled !== 'boolean') throw Object.assign(new Error('fal.ai enabled must be true or false.'), {statusCode:400});
    falUpdates.push(['fal_enabled',input.falEnabled?'true':'false']);
  }
  if ('falApiKey' in input && (typeof input.falApiKey !== 'string' || input.falApiKey.length>512))
    throw Object.assign(new Error('Invalid fal.ai API key.'), {statusCode:400});
  if ('falMaxInflight' in input) {
    const n=Number(input.falMaxInflight);
    if (!Number.isInteger(n)||n<1||n>10) throw Object.assign(new Error('fal.ai max inflight must be 1 to 10.'), {statusCode:400});
    falUpdates.push(['fal_max_inflight',String(n)]);
  }
  if ('falCustomerCreditsPerUsd' in input) {
    const n=Number(input.falCustomerCreditsPerUsd);
    if (!Number.isFinite(n)||n<=0||n>1000000) throw Object.assign(new Error('fal.ai credits per USD must be greater than zero and at most 1000000.'), {statusCode:400});
    falUpdates.push(['fal_customer_credits_per_usd',String(n)]);
  }
  if('api888Enabled' in input) {
    if(typeof input.api888Enabled!=='boolean')throw Object.assign(new Error('888API enabled must be boolean.'),{statusCode:400});
    await put('api888_enabled',input.api888Enabled?'true':'false');
  }
  if('api888MaxInflight' in input){
    const n=Number(input.api888MaxInflight);
    if(!Number.isInteger(n)||n<1||n>10)throw Object.assign(new Error('888API inflight limit must be 1–10.'),{statusCode:400});
    await put('api888_max_inflight',String(n));
  }
  if(input.clearApi888ApiKey===true)await del('api888_api_key');
  else if('api888ApiKey' in input && String(input.api888ApiKey||'').trim()){
    if(typeof input.api888ApiKey!=='string'||input.api888ApiKey.length>512||/\s/.test(input.api888ApiKey.trim()))throw Object.assign(new Error('Invalid 888API key.'),{statusCode:400});
    await put('api888_api_key',input.api888ApiKey.trim(),true);
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
  const higgsfieldUpdates=[];
  if ('higgsfieldEnabled' in input) {
    if (typeof input.higgsfieldEnabled !== 'boolean') throw Object.assign(new Error('Higgsfield enabled must be true or false.'), {statusCode:400});
    higgsfieldUpdates.push(['higgsfield_enabled',input.higgsfieldEnabled?'true':'false']);
  }
  // Higgsfield credentials are a key ID and a secret, saved together as "ID:SECRET".
  if ('higgsfieldApiKey' in input && (typeof input.higgsfieldApiKey !== 'string' || input.higgsfieldApiKey.length>512 ||
    (input.higgsfieldApiKey.trim() && !/^[^\s:]+:[^\s:]+$/.test(input.higgsfieldApiKey.trim()))))
    throw Object.assign(new Error('Enter the Higgsfield API key as KEY_ID:KEY_SECRET.'), {statusCode:400});
  if ('higgsfieldMaxInflight' in input) {
    const n=Number(input.higgsfieldMaxInflight);
    if (!Number.isInteger(n)||n<1||n>10) throw Object.assign(new Error('Higgsfield max inflight must be 1 to 10.'), {statusCode:400});
    higgsfieldUpdates.push(['higgsfield_max_inflight',String(n)]);
  }
  const sluiceUpdates=[];
  if ('sluiceEnabled' in input) {
    if (typeof input.sluiceEnabled !== 'boolean') throw Object.assign(new Error('Sluice enabled must be true or false.'), {statusCode:400});
    sluiceUpdates.push(['sluice_enabled',input.sluiceEnabled?'true':'false']);
  }
  if ('sluiceApiKey' in input && (typeof input.sluiceApiKey !== 'string' || input.sluiceApiKey.length>512 || /\s/.test(input.sluiceApiKey.trim())))
    throw Object.assign(new Error('Invalid Sluice API key.'), {statusCode:400});
  if ('sluiceMaxInflight' in input) {
    const n=Number(input.sluiceMaxInflight);
    if (!Number.isInteger(n)||n<1||n>10) throw Object.assign(new Error('Sluice max inflight must be 1 to 10.'), {statusCode:400});
    sluiceUpdates.push(['sluice_max_inflight',String(n)]);
  }
  const vidanceeUpdates=[];
  if('vidanceePassword' in input && (typeof input.vidanceePassword!=='string'||input.vidanceePassword.length>512))throw Object.assign(new Error('Invalid Vidancee password.'),{statusCode:400});
  if ('vidanceeEnabled' in input) {
    if (typeof input.vidanceeEnabled !== 'boolean') throw Object.assign(new Error('Vidancee enabled must be true or false.'), {statusCode:400});
    vidanceeUpdates.push(['vidancee_enabled',input.vidanceeEnabled?'true':'false']);
  }
  if ('vidanceeEmail' in input && (typeof input.vidanceeEmail !== 'string' || input.vidanceeEmail.length>512 || /\s/.test(input.vidanceeEmail.trim())))
    throw Object.assign(new Error('Invalid Vidancee email.'), {statusCode:400});
  if ('vidanceeMaxInflight' in input) {
    const n=Number(input.vidanceeMaxInflight);
    if (!Number.isInteger(n)||n<1||n>10) throw Object.assign(new Error('Vidancee max inflight must be 1 to 10.'), {statusCode:400});
    vidanceeUpdates.push(['vidancee_max_inflight',String(n)]);
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

  for (const [key,value] of falUpdates) await put(key,value);
  if (input.clearFalApiKey===true) await del('fal_api_key');
  else if (String(input.falApiKey||'').trim()) await put('fal_api_key',input.falApiKey.trim(),true);

  for (const [key,value] of argoUpdates) await put(key,value);
  if (input.clearArgoLinkApiKey===true) await del('argolink_api_key');
  else if (String(input.argoLinkApiKey||'').trim()) await put('argolink_api_key',input.argoLinkApiKey.trim(),true);

  for (const [key,value] of higgsfieldUpdates) await put(key,value);
  if (input.clearHiggsfieldApiKey===true) await del('higgsfield_api_key');
  else if (String(input.higgsfieldApiKey||'').trim()) await put('higgsfield_api_key',input.higgsfieldApiKey.trim(),true);

  for (const [key,value] of sluiceUpdates) await put(key,value);
  if (input.clearSluiceApiKey===true) await del('sluice_api_key');
  else if (String(input.sluiceApiKey||'').trim()) await put('sluice_api_key',input.sluiceApiKey.trim(),true);

  for (const [key,value] of vidanceeUpdates) await put(key,value);
  if (input.clearVidanceeEmail===true) await del('vidancee_email');
  else if (String(input.vidanceeEmail||'').trim()) await put('vidancee_email',input.vidanceeEmail.trim(),true);
  if (input.clearVidanceePassword===true) await del('vidancee_password');
  else if (String(input.vidanceePassword||'')) await put('vidancee_password',input.vidanceePassword,true);

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
  secret('api888_api_key', 'API888_API_KEY');
  secret('argolink_api_key', 'ARGOLINK_API_KEY');
  secret('higgsfield_api_key', 'HIGGSFIELD_API_KEY');
  secret('sluice_api_key', 'SLUICE_API_KEY');
  secret('vidancee_email', 'VIDANCEE_EMAIL');
  secret('vidancee_password', 'VIDANCEE_PASSWORD');
  secret('fal_api_key', 'FAL_KEY');
  plain('vgenv_base_url', 'VGENV_BASE_URL');
  secret('vgenv_api_key', 'VGENV_API_KEY');
  plain('vgenv_max_inflight', 'VGENV_MAX_INFLIGHT');
  plain('vgenv_enabled', 'VGENV_ENABLED');
  plain('vibi_base_url', 'VIBI_BASE_URL');
  secret('vibi_api_key', 'VIBI_API_KEY');
  plain('vibi_enabled', 'VIBI_ENABLED');
  plain('vibi_max_inflight', 'VIBI_MAX_INFLIGHT');
  plain('vibi_clone_customer_cost', 'VIBI_CLONE_CUSTOMER_COST');
  plain('allow_provider_charges', 'ALLOW_PROVIDER_CHARGES');
  await Promise.all(tasks);
  return tasks.length;
}

module.exports = {
  ensureSettingsTable,
  getProviderSettings,
  getAdminProviderSettings,
  updateProviderSettings,
  migrateLegacyProviderEnvSettings,
  getSettingValue,
  setSettingValue,
  saveGoogleDriveOAuthCredentials,
  deleteSettingValue,
};


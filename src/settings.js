const crypto = require('node:crypto');
const { getPool } = require('./db.js');

const DEFAULTS = {
  vidancee_base_url: 'https://vidancee.com',
  vidancee_email: '',
  vidancee_password: '',
  vidancee_enabled: 'true',
  createpulse_base_url: 'https://createpulse.online',
  createpulse_api_key: '',
  createpulse_max_inflight: '3',
  createpulse_enabled: 'true',
  atlascloud_base_url: 'https://api.atlascloud.ai',
  atlascloud_api_key: '',
  atlascloud_max_inflight: '4',
  atlascloud_enabled: 'true',
  vgenv_base_url: 'https://api.vgenv.com',
  vgenv_api_key: '',
  vgenv_max_inflight: '4',
  vgenv_enabled: 'true',
  higgsfield_mcp_url: 'https://mcp.higgsfield.ai/mcp',
  higgsfield_max_inflight: '4',
  higgsfield_enabled: 'true',
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

function normalizeEndpoint(value, fallback) {
  const parsed = new URL(String(value || fallback));
  if (parsed.protocol !== 'https:') throw new Error('Provider URLs must use HTTPS.');
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
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
    vidanceeBaseUrl: normalizeUrl(read('vidancee_base_url'), DEFAULTS.vidancee_base_url),
    vidanceeEmail: String(read('vidancee_email') || '').trim(),
    vidanceePassword: String(read('vidancee_password') || ''),
    vidanceeEnabled: asBool(read('vidancee_enabled')),
    createPulseBaseUrl: normalizeUrl(read('createpulse_base_url'), DEFAULTS.createpulse_base_url),
    createPulseApiKey: String(read('createpulse_api_key') || '').trim(),
    createPulseMaxInflight: Math.max(1, Math.min(50, Number(read('createpulse_max_inflight') || 3))),
    createPulseEnabled: asBool(read('createpulse_enabled')),
    atlasCloudBaseUrl: normalizeUrl(read('atlascloud_base_url'), DEFAULTS.atlascloud_base_url),
    atlasCloudApiKey: String(read('atlascloud_api_key') || '').trim(),
    atlasCloudMaxInflight: Math.max(1, Math.min(50, Number(read('atlascloud_max_inflight') || 4))),
    atlasCloudEnabled: asBool(read('atlascloud_enabled')),
    vgenvBaseUrl: normalizeUrl(read('vgenv_base_url'), DEFAULTS.vgenv_base_url),
    vgenvApiKey: String(read('vgenv_api_key') || '').trim(),
    vgenvMaxInflight: Math.max(1, Math.min(50, Number(read('vgenv_max_inflight') || 4))),
    vgenvEnabled: asBool(read('vgenv_enabled')),
    higgsfieldMcpUrl: normalizeEndpoint(read('higgsfield_mcp_url'), DEFAULTS.higgsfield_mcp_url),
    higgsfieldMaxInflight: Math.max(1, Math.min(50, Number(read('higgsfield_max_inflight') || 4))),
    higgsfieldEnabled: asBool(read('higgsfield_enabled')),
    higgsfieldOauthTokens: String(read('higgsfield_oauth_tokens') || ''),
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
    atlascloud: {
      baseUrl: s.atlasCloudBaseUrl,
      apiKeyConfigured: Boolean(s.atlasCloudApiKey),
      maxInflight: s.atlasCloudMaxInflight,
      configured: Boolean(s.atlasCloudApiKey),
      enabled: Boolean(s.atlasCloudEnabled),
      active: Boolean(s.atlasCloudEnabled && s.atlasCloudApiKey),
    },
    vgenv: {
      baseUrl: s.vgenvBaseUrl,
      apiKeyConfigured: Boolean(s.vgenvApiKey),
      maxInflight: s.vgenvMaxInflight,
      configured: Boolean(s.vgenvApiKey),
      enabled: Boolean(s.vgenvEnabled),
      active: Boolean(s.vgenvEnabled && s.vgenvApiKey),
    },
    higgsfield: {
      mcpUrl: s.higgsfieldMcpUrl,
      maxInflight: s.higgsfieldMaxInflight,
      connected: Boolean(s.higgsfieldOauthTokens),
      configured: Boolean(s.higgsfieldOauthTokens),
      enabled: Boolean(s.higgsfieldEnabled),
      active: Boolean(s.higgsfieldEnabled && s.higgsfieldOauthTokens),
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
  if ('atlasCloudBaseUrl' in input) await put('atlascloud_base_url', normalizeUrl(input.atlasCloudBaseUrl, DEFAULTS.atlascloud_base_url));
  if ('atlasCloudEnabled' in input) await put('atlascloud_enabled', input.atlasCloudEnabled ? 'true' : 'false');
  if (input.clearAtlasCloudApiKey === true) await del('atlascloud_api_key');
  else if (String(input.atlasCloudApiKey || '').trim()) await put('atlascloud_api_key', String(input.atlasCloudApiKey).trim(), true);

  if ('atlasCloudMaxInflight' in input) {
    const n = Number(input.atlasCloudMaxInflight);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Atlas Cloud max inflight must be 1 to 50.');
    await put('atlascloud_max_inflight', String(n));
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

  if ('higgsfieldMcpUrl' in input) await put('higgsfield_mcp_url', normalizeEndpoint(input.higgsfieldMcpUrl, DEFAULTS.higgsfield_mcp_url));
  if ('higgsfieldEnabled' in input) await put('higgsfield_enabled', input.higgsfieldEnabled ? 'true' : 'false');
  if ('higgsfieldMaxInflight' in input) {
    const n = Number(input.higgsfieldMaxInflight);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Higgsfield max inflight must be 1 to 50.');
    await put('higgsfield_max_inflight', String(n));
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
  plain('vidancee_base_url', 'VIDANCEE_BASE_URL');
  plain('vidancee_email', 'VIDANCEE_EMAIL');
  secret('vidancee_password', 'VIDANCEE_PASSWORD');
  plain('vidancee_enabled', 'VIDANCEE_ENABLED');
  plain('createpulse_base_url', 'CREATEPULSE_BASE_URL');
  secret('createpulse_api_key', 'CREATEPULSE_API_KEY');
  plain('createpulse_max_inflight', 'CREATEPULSE_MAX_INFLIGHT');
  plain('createpulse_enabled', 'CREATEPULSE_ENABLED');
  plain('atlascloud_base_url', 'ATLASCLOUD_BASE_URL');
  secret('atlascloud_api_key', 'ATLASCLOUD_API_KEY');
  plain('atlascloud_max_inflight', 'ATLASCLOUD_MAX_INFLIGHT');
  plain('atlascloud_enabled', 'ATLASCLOUD_ENABLED');
  plain('vgenv_base_url', 'VGENV_BASE_URL');
  secret('vgenv_api_key', 'VGENV_API_KEY');
  plain('vgenv_max_inflight', 'VGENV_MAX_INFLIGHT');
  plain('vgenv_enabled', 'VGENV_ENABLED');
  plain('higgsfield_mcp_url', 'HIGGSFIELD_MCP_URL');
  plain('higgsfield_max_inflight', 'HIGGSFIELD_MAX_INFLIGHT');
  plain('higgsfield_enabled', 'HIGGSFIELD_ENABLED');
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

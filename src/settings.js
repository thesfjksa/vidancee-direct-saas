const crypto = require('node:crypto');
const { getPool } = require('./db.js');

const DEFAULTS = {
  vidancee_base_url: 'https://vidancee.com',
  vidancee_email: '',
  vidancee_password: '',
  createpulse_base_url: 'https://createpulse.online',
  createpulse_api_key: '',
  createpulse_max_inflight: '3',
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
    vidanceeBaseUrl: normalizeUrl(read('vidancee_base_url'), DEFAULTS.vidancee_base_url),
    vidanceeEmail: String(read('vidancee_email') || '').trim(),
    vidanceePassword: String(read('vidancee_password') || ''),
    createPulseBaseUrl: normalizeUrl(read('createpulse_base_url'), DEFAULTS.createpulse_base_url),
    createPulseApiKey: String(read('createpulse_api_key') || '').trim(),
    createPulseMaxInflight: Math.max(1, Math.min(50, Number(read('createpulse_max_inflight') || 3))),
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
    },
    createpulse: {
      baseUrl: s.createPulseBaseUrl,
      apiKeyConfigured: Boolean(s.createPulseApiKey),
      maxInflight: s.createPulseMaxInflight,
      configured: Boolean(s.createPulseApiKey),
    },
    routing: s.routing,
    allowProviderCharges: s.allowProviderCharges,
  };
}

async function updateProviderSettings(input = {}) {
  if ('vidanceeBaseUrl' in input) await put('vidancee_base_url', normalizeUrl(input.vidanceeBaseUrl, DEFAULTS.vidancee_base_url));
  if ('vidanceeEmail' in input) await put('vidancee_email', String(input.vidanceeEmail || '').trim());
  if (input.clearVidanceePassword === true) await del('vidancee_password');
  else if (String(input.vidanceePassword || '').length) await put('vidancee_password', String(input.vidanceePassword), true);

  if ('createPulseBaseUrl' in input) await put('createpulse_base_url', normalizeUrl(input.createPulseBaseUrl, DEFAULTS.createpulse_base_url));
  if (input.clearCreatePulseApiKey === true) await del('createpulse_api_key');
  else if (String(input.createPulseApiKey || '').trim()) await put('createpulse_api_key', String(input.createPulseApiKey).trim(), true);

  if ('createPulseMaxInflight' in input) {
    const n = Number(input.createPulseMaxInflight);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Max inflight must be 1 to 50.');
    await put('createpulse_max_inflight', String(n));
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
  plain('createpulse_base_url', 'CREATEPULSE_BASE_URL');
  secret('createpulse_api_key', 'CREATEPULSE_API_KEY');
  plain('createpulse_max_inflight', 'CREATEPULSE_MAX_INFLIGHT');
  plain('provider_routing', 'PROVIDER_ROUTING');
  plain('allow_provider_charges', 'ALLOW_PROVIDER_CHARGES');
  await Promise.all(tasks);
  return tasks.length;
}

module.exports = { getProviderSettings, getAdminProviderSettings, updateProviderSettings, migrateLegacyProviderEnvSettings };

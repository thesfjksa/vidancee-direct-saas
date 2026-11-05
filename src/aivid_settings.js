'use strict';

const { getSettingValue, setSettingValue } = require('./settings.js');
const { browserlessUrl } = require('./provider/browserless.js');
const SESSION_KEY = 'aivid_browserless_session';
const CONFIG_KEY = 'aivid_browserless_config';
const ENDPOINTS = ['https://production-sfo.browserless.io', 'https://production-lon.browserless.io', 'https://production-ams.browserless.io'];

function configFrom(env, session = {}, saved = null) {
  // Once the dashboard has saved settings, it takes precedence over legacy
  // environment variables, including an old session URL or enable flag.
  const connectUrl = String(session.connect || (!saved && env.AIVID_BROWSERLESS_CONNECT_URL) || '').trim();
  if (connectUrl) browserlessUrl(connectUrl);
  const maxSourceCredits = Number(saved ? saved.maxSourceCredits || 0 : env.AIVID_MAX_SOURCE_CREDITS || 0);
  if (!Number.isFinite(maxSourceCredits) || maxSourceCredits < 0 || maxSourceCredits > 10000)
    throw new Error('Invalid AIVID source credit limit.');
  return { connectUrl, maxSourceCredits, enabled: saved ? saved.enabled === true : env.AIVID_ENABLED === 'true',
    apiKey: String(saved ? saved.apiKey || '' : env.BROWSERLESS_API_TOKEN || '').trim(),
    endpoint: saved?.endpoint || env.BROWSERLESS_ENDPOINT || ENDPOINTS[0],
    ttlDays: saved?.ttlDays || 1, session, expiresAt: session.expiresAt || null };
}

async function getAividSettings() {
  // The existing settings store encrypts this entire session object at rest.
  const [raw, config] = await Promise.all([getSettingValue(SESSION_KEY, ''), getSettingValue(CONFIG_KEY, '')]);
  let session = {}, saved = null;
  try { if (raw) session = JSON.parse(raw); if (config) saved = JSON.parse(config); }
  catch { throw new Error('The saved Browserless settings are invalid.'); }
  return configFrom(process.env, session, saved);
}

function publicConfig(config) {
  return { configured: Boolean(config.connectUrl), apiKeyConfigured: Boolean(config.apiKey),
    endpoint: config.endpoint, ttlDays: config.ttlDays || 1, enabled: config.enabled,
    maxSourceCredits: config.maxSourceCredits, expiresAt: config.expiresAt,
    sessionExpired: Boolean(config.expiresAt && Date.parse(config.expiresAt) <= Date.now()),
    customerModelEnabled: false };
}

function validateConfig(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Invalid Browserless settings.'), { statusCode: 400 });
  const apiKey = input.apiKey === undefined || input.apiKey === '' ? current.apiKey : input.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 1024 || /\s/.test(apiKey))
    throw Object.assign(new Error('Enter a valid Browserless API key.'), { statusCode: 400 });
  const endpoint = input.endpoint ?? current.endpoint;
  if (!ENDPOINTS.includes(endpoint)) throw Object.assign(new Error('Choose a supported Browserless region.'), { statusCode: 400 });
  const ttlDays = Number(input.ttlDays ?? current.ttlDays ?? 1);
  if (![1, 7, 30, 90].includes(ttlDays)) throw Object.assign(new Error('Choose a supported session lifetime.'), { statusCode: 400 });
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw Object.assign(new Error('Invalid AIVID enable setting.'), { statusCode: 400 });
  const maxSourceCredits = Number(input.maxSourceCredits ?? current.maxSourceCredits ?? 0);
  if (!Number.isFinite(maxSourceCredits) || maxSourceCredits < 0 || maxSourceCredits > 10000)
    throw Object.assign(new Error('The source credit limit must be between 0 and 10000.'), { statusCode: 400 });
  return { apiKey, endpoint, ttlDays, enabled: input.enabled ?? current.enabled ?? false, maxSourceCredits };
}

async function saveAividSettings(input, { getConfig = getAividSettings, write = setSettingValue } = {}) {
  const current = await getConfig();
  const saved = validateConfig(input, current);
  if (current.connectUrl && !current.session?.connect) {
    await write(SESSION_KEY, JSON.stringify({ connect: current.connectUrl, expiresAt: current.expiresAt || null }), { secret: true });
  }
  await write(CONFIG_KEY, JSON.stringify(saved), { secret: true });
  return publicConfig({ ...current, ...saved });
}

module.exports = { SESSION_KEY, CONFIG_KEY, ENDPOINTS, configFrom, getAividSettings, publicConfig, validateConfig, saveAividSettings };

'use strict';

const { getSettingValue } = require('./settings.js');
const { browserlessUrl } = require('./provider/browserless.js');
const SESSION_KEY = 'aivid_browserless_session';

function configFrom(env, session = {}) {
  const connectUrl = String(env.AIVID_BROWSERLESS_CONNECT_URL || session.connect || '').trim();
  if (connectUrl) browserlessUrl(connectUrl);
  const maxSourceCredits = Number(env.AIVID_MAX_SOURCE_CREDITS || 0);
  if (!Number.isFinite(maxSourceCredits) || maxSourceCredits < 0 || maxSourceCredits > 10000)
    throw new Error('Invalid AIVID source credit limit.');
  return { connectUrl, maxSourceCredits, enabled: env.AIVID_ENABLED === 'true',
    expiresAt: session.expiresAt || null };
}

async function getAividSettings() {
  // The existing settings store encrypts this entire session object at rest.
  let session = {};
  if (!process.env.AIVID_BROWSERLESS_CONNECT_URL) {
    const raw = await getSettingValue(SESSION_KEY, '');
    if (raw) {
      try { session = JSON.parse(raw); } catch { throw new Error('The saved Browserless session is invalid.'); }
    }
  }
  return configFrom(process.env, session);
}

function publicConfig(config) {
  return { configured: Boolean(config.connectUrl), enabled: config.enabled,
    maxSourceCredits: config.maxSourceCredits, expiresAt: config.expiresAt,
    customerModelEnabled: false };
}

module.exports = { SESSION_KEY, configFrom, getAividSettings, publicConfig };

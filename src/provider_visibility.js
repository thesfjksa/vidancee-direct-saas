'use strict';

const PROVIDERS = Object.freeze(['aivid', 'api888', 'sluice', 'vidancee', 'longai', 'wxksai', 'puream', 'huiqu', 'vgenv', 'vibi', 'smartaipi', 'vercel', 'argolink', 'higgsfield', 'fal']);
const visibilityKey = provider => provider + '_models_visible';

function readModelVisibility(read) {
  return Object.fromEntries(PROVIDERS.map(provider => {
    const value = read(visibilityKey(provider));
    return [provider, value == null || value === '' ? true : /^(1|true|yes|on)$/i.test(String(value))];
  }));
}

function validateVisibilityPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Object.assign(new Error('Provider model visibility must contain provider checkboxes.'), { statusCode: 400 });
  for (const [provider, visible] of Object.entries(value)) {
    if (!PROVIDERS.includes(provider) || typeof visible !== 'boolean')
      throw Object.assign(new Error('Invalid provider model visibility setting.'), { statusCode: 400 });
  }
  return Object.entries(value).map(([provider, visible]) => [visibilityKey(provider), String(visible)]);
}

function visibleProviderAccess(access, visibility = {}) {
  return Object.fromEntries(Object.entries(access).map(([provider, enabled]) => [provider, !['puream','huiqu'].includes(provider) && Boolean(enabled) && visibility[provider] !== false]));
}

module.exports = { PROVIDERS, visibilityKey, readModelVisibility, validateVisibilityPatch, visibleProviderAccess };

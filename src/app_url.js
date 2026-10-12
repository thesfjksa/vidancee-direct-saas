'use strict';

// The customer app moved from ai.mehroz.online to cmmtools.site, and the old
// address no longer serves HTTPS. Links handed to providers (reference images,
// OAuth callbacks) must use the new address even if APP_URL still holds the
// old one, otherwise providers cannot reach them.
const PRIMARY_URL = 'https://cmmtools.site';
const RETIRED_HOSTS = ['ai.mehroz.online'];

function currentOrigin(value) {
  const text = String(value || '').trim().replace(/\/$/, '');
  try {
    if (text && RETIRED_HOSTS.includes(new URL(text).host.toLowerCase())) return PRIMARY_URL;
  } catch {}
  return text;
}

// Base URL for links the app gives to other services.
function appUrl() { return currentOrigin(process.env.APP_URL); }

// Rewrites a full URL saved earlier on the retired address.
function currentUrl(value) {
  const text = String(value || '').trim();
  try {
    const url = new URL(text);
    if (RETIRED_HOSTS.includes(url.host.toLowerCase())) return PRIMARY_URL + url.pathname + url.search;
  } catch {}
  return text;
}

module.exports = { PRIMARY_URL, RETIRED_HOSTS, currentOrigin, currentUrl, appUrl };

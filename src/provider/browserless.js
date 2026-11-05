'use strict';

// Session connect/stop URLs are bearer credentials. Never include upstream
// response bodies or Playwright connection errors (which contain URLs) in logs.
function browserlessUrl(value, protocol = 'wss:') {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Browserless URL.'); }
  if (url.protocol !== protocol || url.username || url.password || url.hash ||
      !url.hostname.endsWith('.browserless.io') || (url.port && url.port !== '443'))
    throw new Error('Use a secure Browserless cloud URL.');
  return url;
}

async function createSession({ token, endpoint = 'https://production-sfo.browserless.io',
  ttl = 86400000, fetchImpl = fetch } = {}) {
  if (!token || /\s/.test(token)) throw new Error('A Browserless API token is required.');
  if (!Number.isSafeInteger(ttl) || ttl < 60000 || ttl > 90 * 86400000)
    throw new Error('Invalid Browserless session lifetime.');
  const url = browserlessUrl(endpoint, 'https:');
  url.pathname = '/session'; url.search = ''; url.searchParams.set('token', token);
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl, browser: 'chrome', headless: false, replay: false }) });
  } catch { throw new Error('Browserless session creation could not connect.'); }
  if (!response.ok) throw new Error('Browserless session creation failed (HTTP ' + response.status + ').');
  let session;
  try { session = await response.json(); } catch { throw new Error('Browserless returned an invalid session.'); }
  const connect = browserlessUrl(session?.connect).href;
  const stop = browserlessUrl(session?.stop, 'https:').href;
  if (new URL(connect).hostname !== url.hostname || new URL(stop).hostname !== url.hostname)
    throw new Error('Browserless returned an unexpected session host.');
  return { id: String(session.id || ''), connect, stop, ttl,
    expiresAt: new Date(Date.now() + ttl).toISOString() };
}

async function connectSession(connectUrl, { chromium, timeoutMs = 90000 } = {}) {
  const url = browserlessUrl(connectUrl);
  url.searchParams.set('timeout', String(timeoutMs));
  chromium ||= require('playwright-core').chromium;
  let browser;
  try { browser = await chromium.connectOverCDP(url.href, { timeout: 30000 }); }
  catch { throw new Error('Browserless connection failed. Check the saved session, token, plan and active connections.'); }
  try {
    // An incognito context would lose the Google/AIVID login.
    const context = browser.contexts()[0];
    if (!context) throw new Error('Browserless returned no persistent browser context.');
    // Close stale pages: a restored generation form must not carry another
    // customer's prompt/references, and no previous download may be collected.
    const page = await context.newPage();
    for (const old of context.pages()) if (old !== page) await old.close();
    page.setDefaultTimeout(15000);
    return { browser, context, page,
      close: async () => { await browser.close().catch(() => {}); } };
  } catch {
    await browser.close().catch(() => {});
    throw new Error('Browserless could not prepare an isolated job page.');
  }
}

module.exports = { browserlessUrl, createSession, connectSession };

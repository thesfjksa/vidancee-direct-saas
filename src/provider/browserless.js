'use strict';

// Session connect/stop URLs are bearer credentials. Never include upstream
// response bodies or Playwright connection errors (which contain URLs) in logs.
class BrowserlessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BrowserlessError'; this.code = code; this.statusCode = 502; this.aividSafe = true;
  }
}

// Classify upstream text, but only return our own fixed messages. Upstream
// bodies can echo the token, connect URL or other account information.
function httpFailure(status, body = '', operation = 'session creation') {
  const text = String(body).slice(0, 16384).toLowerCase();
  let reason;
  if (status >= 400 && status < 500 && /(?:out of|not enough|insufficient|exhausted|exceeded|no remaining|zero|0 remaining).{0,60}(?:units|credits)|(?:units|credits).{0,60}(?:exhausted|depleted|exceeded|insufficient)/s.test(text))
    reason = 'The Browserless account has no available units. Check usage and billing in Browserless.';
  else if ([400, 403, 422].includes(status) && /\bttl\b|session (?:lifetime|duration).{0,60}(?:maximum|exceed|limit)/s.test(text))
    reason = 'Browserless rejected the session lifetime. Select 1 day, save settings, and reconnect. Longer lifetimes must be supported by your plan.';
  else if ([401, 402, 403].includes(status) && /(?:plan|subscription|upgrade|paid|license|licensed)/.test(text))
    reason = 'Browserless denied this feature for the account. Check that your plan permits persistent Chrome sessions and has available units.';
  else reason = {
    400: 'Browserless rejected the session options. Try a 1-day lifetime and check the account session limits.',
    401: 'Browserless rejected authentication. Copy the current API token from your Browserless dashboard, save it, and reconnect. Also check account units and endpoint access.',
    402: 'Browserless requires available account units or billing access. Check your Browserless account.',
    403: 'Browserless denied access. Check the current API token and account permissions for persistent Chrome sessions.',
    404: 'Browserless could not find the endpoint or saved session. Check the region; use Session recovery if the saved session has expired.',
    408: 'Browserless timed out. Retry when the service is available and check your plan connection limits.',
    429: 'Browserless has reached an active-session or request limit. Close unused sessions in its dashboard, then reconnect.',
  }[status] || 'Browserless is unavailable or returned an unexpected response. Retry shortly; check Browserless service status if this continues.';
  return new BrowserlessError(`Browserless ${operation} failed (HTTP ${status}). ${reason}`, 'BROWSERLESS_HTTP_' + status);
}

async function responseFailure(response) {
  // Bound consumption even for an unexpected HTML/streaming gateway response.
  let body = '';
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const decoder = new TextDecoder(); let size = 0;
      while (size < 16384) {
        const part = await reader.read(); if (part.done) break;
        body += decoder.decode(part.value.subarray(0, 16384 - size)); size += part.value.byteLength;
      }
    } catch {} finally { await reader.cancel().catch(() => {}); }
  }
  return httpFailure(response.status, body);
}

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
  } catch {
    throw new BrowserlessError('The CMMTools server could not reach Browserless to create a session. Retry or select another Browserless region and save settings.', 'BROWSERLESS_NETWORK');
  }
  if (!response.ok) throw await responseFailure(response);
  let session;
  let connect, stop;
  try {
    session = await response.json();
    connect = browserlessUrl(session?.connect).href;
    stop = browserlessUrl(session?.stop, 'https:').href;
    if (new URL(connect).hostname !== url.hostname || new URL(stop).hostname !== url.hostname) throw new Error();
  } catch {
    throw new BrowserlessError('Browserless returned an invalid persistent-session response. Check the selected cloud region and retry; no login session was installed.', 'BROWSERLESS_INVALID_SESSION');
  }
  return { id: String(session.id || ''), connect, stop, ttl,
    expiresAt: new Date(Date.now() + ttl).toISOString() };
}

async function connectSession(connectUrl, { chromium, timeoutMs = 90000 } = {}) {
  const url = browserlessUrl(connectUrl);
  url.searchParams.set('timeout', String(timeoutMs));
  chromium ||= require('playwright-core').chromium;
  let browser;
  try { browser = await chromium.connectOverCDP(url.href, { timeout: 30000 }); }
  catch (error) {
    const status = String(error?.message || '').match(/Unexpected server response:\s*(400|401|402|403|404|408|429|500|502|503|504)\b/i);
    if (status) throw httpFailure(Number(status[1]), '', 'browser connection');
    throw new BrowserlessError('Browserless could not open the saved browser session. Check active connections in Browserless; if the session expired, use Session recovery to create a new login session.', 'BROWSERLESS_CONNECT');
  }
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
    throw new BrowserlessError('Browserless connected but could not prepare a browser page. Close unused Browserless sessions and reconnect.', 'BROWSERLESS_PAGE');
  }
}

async function createLoginView(remote, { timeoutMs = 90000 } = {}) {
  // Keep one coordinate system while a person controls the stream. Resizing
  // different viewers must not keep changing the remote page's viewport.
  await remote.page.setViewportSize({ width: 1280, height: 800 });
  await remote.page.bringToFront();
  const cdp = await remote.context.newCDPSession(remote.page);
  await cdp.send('Input.setIgnoreInputEvents', { ignore: false });
  const live = await cdp.send('Browserless.liveURL', { interactable: true,
    timeout: timeoutMs, resizable: false, showBrowserInterface: false,
    mode: 'follow', showTimer: true });
  if (live.error || !live.liveURL || live.interactable === false) {
    if (live.liveURLId) await cdp.send('Browserless.closeLiveURL', { liveURLId: live.liveURLId }).catch(() => {});
    throw new BrowserlessError('Browserless could not open an interactive login view. Reconnect from Admin to request a fresh window.', 'BROWSERLESS_LIVE_INPUT');
  }
  browserlessUrl(live.liveURL, 'https:');
  return { ...live, cdp };
}

module.exports = { BrowserlessError, browserlessUrl, createSession, connectSession, createLoginView };

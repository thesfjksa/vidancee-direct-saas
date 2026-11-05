'use strict';

const { connectSession, LOGIN_VIEWPORT } = require('./browserless.js');
const ORIGIN = 'https://aivid.dev';
const API = 'https://api.aivid.dev';
const MINI = 'Seedance 2.0 (Mini)';
const ID = /^[a-zA-Z0-9_-]{16,80}$/;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const INPUTS = {
  image: 'input[type="file"][accept="image/jpeg,image/png,image/webp"]',
  video: 'input[type="file"][accept="video/mp4,video/quicktime"]',
  audio: 'input[type="file"][accept="audio/mpeg,audio/wav"]',
};
const MIME = { image: ['image/jpeg', 'image/png', 'image/webp'], video: ['video/mp4', 'video/quicktime'], audio: ['audio/mpeg', 'audio/wav'] };

function validateJob(value, references = []) {
  if (!value || typeof value !== 'object') throw new Error('An AIVID job is required.');
  const job = { prompt: String(value.prompt || '').trim(), duration: Number(value.duration),
    aspectRatio: String(value.aspectRatio || value.aspect_ratio || '16:9'), resolution: String(value.resolution || '480p') };
  if (!job.prompt || job.prompt.length > 50000) throw new Error('Prompt must contain 1–50,000 characters.');
  if (!Number.isInteger(job.duration) || job.duration < 4 || job.duration > 15) throw new Error('Mini supports 4–15 whole seconds.');
  if (!['16:9', '9:16', '1:1'].includes(job.aspectRatio)) throw new Error('Unsupported Mini aspect ratio.');
  if (!['480p', '720p'].includes(job.resolution)) throw new Error('Unsupported Mini resolution.');
  if (!Array.isArray(references) || references.length > 15) throw new Error('Mini supports at most 15 reference files.');
  const counts = { image: 0, video: 0, audio: 0 }; let totalBytes = 0;
  for (const ref of references) {
    if (!MIME[ref.kind]?.includes(ref.mimeType) || !Buffer.isBuffer(ref.data) || !ref.data.length)
      throw new Error('A reference has an unsupported kind, format or empty file.');
    counts[ref.kind]++; totalBytes += ref.data.length;
    if (ref.data.length > (ref.kind === 'image' ? 10 : 30) * 1024 * 1024)
      throw new Error('A reference exceeds the adapter file size limit.');
  }
  if (counts.image > 9 || counts.video > 3 || counts.audio > 3 || totalBytes > 64 * 1024 * 1024)
    throw new Error('The reference count or combined file size exceeds the Mini adapter limit.');
  return { ...job, counts };
}

// Observe the actual web form submission. No account tokens are extracted,
// stored in receipts or sent through CMMTools to the provider API directly.
function isGenerationResponse(response) {
  try { const u = new URL(response.url()); return u.origin === API && u.pathname === '/v2/generations' && response.request().method() === 'POST'; }
  catch { return false; }
}
function providerId(body) {
  return [body?.id, body?.jobId, body?.generationId, body?.data?.id, body?.data?.jobId,
    body?.data?.generationId, body?.generation?.id].find(id => typeof id === 'string' && ID.test(id)) || null;
}

function submissionResult(status, body) {
  const id = providerId(body);
  if (status >= 200 && status < 300 && id) return { state: 'accepted', providerJobId: id };
  // A returned ID, timeout, conflict or throttle can describe an existing or
  // still-running operation. Keep those for history reconciliation as well.
  if (!id && [400, 401, 402, 403, 404, 405, 413, 415, 422].includes(status))
    return { state: 'rejected', httpStatus: status };
  return { state: 'submission_uncertain' };
}

function creditState(text) {
  const priceMatch = String(text).match(/\b(\d+(?:\.\d+)?)\s+Credits?\s*\/\s*Video\b/i);
  const balances = [...String(text).replace(/\b\d+(?:\.\d+)?\s+Credits?\s*\/\s*Video\b/gi, '')
    .matchAll(/\b(\d+(?:\.\d+)?)\s+credits\b/gi)];
  if (!priceMatch || balances.length !== 1) throw new Error('AIVID price or account balance cannot be identified safely.');
  return { price: Number(priceMatch[1]), balance: Number(balances[0][1]) };
}

// Fail closed on an unknown outgoing schema. UI selection alone does not
// prove privacy or that all reference uploads made it into the paid request.
function validateSubmission(body, job) {
  if (!body || typeof body !== 'object' || body.model !== 'seedance-2.0-mini' || body.prompt !== job.prompt ||
    Number(body.duration) !== job.duration || body.resolution !== job.resolution ||
    (body.aspectRatio ?? body.aspect_ratio) !== job.aspectRatio)
    throw new Error('AIVID submission settings differ from the prepared job.');
  const privateChecks = [];
  for (const key of ['isPublic', 'public']) if (Object.hasOwn(body, key)) privateChecks.push(body[key] === false);
  for (const key of ['isPrivate', 'private']) if (Object.hasOwn(body, key)) privateChecks.push(body[key] === true);
  if (Object.hasOwn(body, 'visibility')) privateChecks.push(body.visibility === 'private');
  if (!privateChecks.length || privateChecks.some(ok => !ok)) throw new Error('AIVID private visibility could not be verified before submission.');
  const wanted = job.counts.image + job.counts.video + job.counts.audio;
  const refs = body.references || [];
  if (!Array.isArray(refs) || refs.length !== wanted) throw new Error('AIVID reference uploads are missing or incomplete.');
  if (wanted) {
    const counts = { image: 0, video: 0, audio: 0 };
    for (const ref of refs) {
      const type = ref.type ?? ref.kind;
      if (!Object.hasOwn(counts, type)) throw new Error('AIVID reference schema needs verification.');
      counts[type]++;
    }
    if (Object.keys(counts).some(k => counts[k] !== job.counts[k])) throw new Error('AIVID reference types do not match the job.');
  } else if (Array.isArray(body.imageIds) && body.imageIds.length) throw new Error('Unexpected AIVID image references.');
}

async function waitForSession(page, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs; let stableSince = null;
  do {
    if (new URL(page.url()).origin !== ORIGIN) throw new Error('Complete AIVID sign-in before running a job.');
    const signedOut = await page.getByRole('button', { name: 'Sign In', exact: true }).isVisible();
    const ready = !signedOut && await page.getByPlaceholder(/^Describe your video idea/).isVisible();
    if (ready) { stableSince ??= Date.now(); if (Date.now() - stableSince >= 1000) return; }
    else stableSince = null;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error('AIVID sign-in or generation form is not ready. Reopen the saved Browserless session to sign in.');
}

async function openLoginPage(page) {
  // Prepare the real sign-in dialog before streaming. Leave Google's button,
  // credentials and any verification to the owner in the private live window.
  await page.setViewportSize(LOGIN_VIEWPORT);
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByPlaceholder(/^Describe your video idea/).waitFor({ state: 'visible', timeout: 5000 });
  const signIn = page.getByRole('button', { name: 'Sign In', exact: true });
  if (!await signIn.isVisible()) return false;
  const google = page.getByRole('button', { name: 'Continue with Google', exact: true });
  // Server-rendered buttons can be visible before the app attaches handlers.
  // Retry only this harmless entry click once, never Google's sign-in action.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await signIn.click({ timeout: 5000 });
      await google.waitFor({ state: 'visible', timeout: 5000 });
      return true;
    } catch {
      if (!await signIn.isVisible()) return false;
    }
  }
  throw Object.assign(new Error('AIVID did not open its sign-in form. Its page controls are not ready; reconnect to retry.'),
    { statusCode: 502, aividSafe: true });
}

async function choose(page, pattern, exactLabel) {
  const main = page.locator('main').first();
  const current = main.getByRole('button', { name: pattern }).first();
  if ((await current.innerText()).trim() !== exactLabel) {
    await current.click();
    await main.getByRole('button', { name: exactLabel, exact: true }).click();
  }
}

async function prepare(page, value, references = []) {
  const job = validateJob(value, references);
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForSession(page);
  const main = page.locator('main').first();
  await main.getByRole('button', { name: /Seedance|MiniMax/ }).first().click();
  await main.getByRole('button', { name: /^Seedance 2\.0 \(Mini\) / }).click();
  await choose(page, /^\d+:\d+$/, job.aspectRatio);
  await choose(page, /^\d+p$/, job.resolution);
  const slider = main.locator('input[type="range"][min="4"][max="15"]');
  if (await slider.count() !== 1) throw new Error('AIVID duration control changed.');
  await slider.fill(String(job.duration));
  // Toggle is checked on the public default form. The request guard below
  // also requires an explicit private field and aborts on unknown schemas.
  await main.locator('input[type="checkbox"]').first().setChecked(false);
  for (const kind of Object.keys(INPUTS)) {
    const refs = references.filter(ref => ref.kind === kind);
    if (!refs.length) continue;
    const input = main.locator(INPUTS[kind]);
    if (await input.count() !== 1) throw new Error('AIVID reference upload control changed.');
    await input.setInputFiles(refs.map((r, i) => ({ name: 'reference-' + kind + '-' + (i + 1) + '.' + r.mimeType.split('/')[1], mimeType: r.mimeType, buffer: r.data })));
  }
  const prompt = main.getByPlaceholder(/^Describe your video idea/);
  await prompt.fill(job.prompt);
  if (await slider.inputValue() !== String(job.duration) || await prompt.inputValue() !== job.prompt ||
      !await main.getByRole('button', { name: MINI, exact: true }).isVisible() ||
      !await main.getByRole('button', { name: job.aspectRatio, exact: true }).isVisible() ||
      !await main.getByRole('button', { name: job.resolution, exact: true }).isVisible())
    throw new Error('AIVID form verification failed.');
  return job;
}

async function installRequestGuard(page, job) {
  const cdp = await page.context().newCDPSession(page);
  let guardError = null, allowed = false;
  // Intercept every mutation, not just today's generation path. If the site
  // moves generation to a new path or host it must not escape this guard.
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const handler = async event => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)) {
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {}); return;
    }
    try {
      const url = new URL(event.request.url);
      // AIVID's own invisible reCAPTCHA may make its normal verification
      // request. This does not invoke a solver or manufacture a token.
      if (event.request.method === 'POST' && url.protocol === 'https:' &&
          ['www.google.com', 'www.recaptcha.net'].includes(url.hostname) && url.pathname.startsWith('/recaptcha/')) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }); return;
      }
      if (event.request.method !== 'POST' || url.origin !== API || url.pathname !== '/v2/generations' || url.search)
        throw new Error('An unexpected AIVID mutation was blocked before submission.');
      if (allowed) throw new Error('A second AIVID submission was blocked.');
      const body = JSON.parse(event.request.postData || '{}');
      validateSubmission(body, job);
      allowed = true;
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
    } catch (error) {
      guardError = error instanceof SyntaxError ? new Error('AIVID submission schema needs verification.') : error;
      await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }).catch(() => {});
    }
  };
  cdp.on('Fetch.requestPaused', handler);
  return { get error() { return guardError; }, get allowed() { return allowed; },
    close: async () => { await cdp.send('Fetch.disable').catch(() => {}); await cdp.detach().catch(() => {}); } };
}

class AividBrowserlessClient {
  constructor({ connectUrl, maxSourceCredits = 0, connect = connectSession } = {}) {
    this.connectUrl = connectUrl; this.maxSourceCredits = maxSourceCredits; this.connect = connect;
  }
  async withPage(fn) {
    const session = await this.connect(this.connectUrl);
    try { return await fn(session.page); }
    finally { await session.close(); } // Retains the persistent session; never DELETE its stop URL.
  }
  async preflight(value, references = []) {
    return this.withPage(async page => {
      const job = await prepare(page, value, references);
      const credits = creditState(await page.locator('body').innerText());
      return { ready: true, model: MINI, duration: job.duration, resolution: job.resolution,
        aspectRatio: job.aspectRatio, referenceCounts: job.counts, ...credits, submitted: false };
    });
  }
  async startVideo(value, references = [], { beforeClick } = {}) {
    if (typeof beforeClick !== 'function') throw new Error('A durable submission reservation is required.');
    if (!Number.isFinite(this.maxSourceCredits) || this.maxSourceCredits <= 0) throw new Error('Set an explicit AIVID source credit limit before submission.');
    return this.withPage(async page => {
      const job = await prepare(page, value, references);
      const credits = creditState(await page.locator('body').innerText());
      if (credits.price <= 0 || credits.price > this.maxSourceCredits || credits.balance < credits.price)
        throw new Error('AIVID price exceeds the limit or the account has insufficient credits.');
      const guard = await installRequestGuard(page, job);
      try {
        // Commit before any click, even if the process dies inside click().
        await beforeClick({ price: credits.price });
        const responsePromise = page.waitForResponse(isGenerationResponse, { timeout: 45000 }).catch(() => null);
        try { await page.locator('main').first().getByRole('button', { name: 'Generate', exact: true }).click(); }
        catch { await page.close().catch(() => {}); return { state: 'submission_uncertain' }; }
        const response = await responsePromise;
        if (guard.error && !guard.allowed) return { state: 'rejected', reason: guard.error.message };
        if (!response) return { state: 'submission_uncertain' };
        let body; try { body = await response.json(); } catch {}
        return { ...submissionResult(response.status(), body), price: credits.price };
      } finally {
        // Stop the page before removing interception: a late web-app retry
        // must not escape the guard after our response timeout.
        await page.close();
        await guard.close();
      }
    });
  }
  async collectVideo(id) {
    if (!ID.test(String(id))) throw new Error('Invalid AIVID job ID.');
    return this.withPage(async page => {
      await page.goto(ORIGIN + '/videos/' + encodeURIComponent(id), { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = page.locator('dt').filter({ hasText: /^Status$/ }).locator('xpath=following-sibling::dd[1]');
      const text = (await status.innerText()).trim().toLowerCase();
      if (['failed', 'cancelled', 'canceled'].includes(text)) return { state: 'failed' };
      if (['pending', 'queued', 'processing', 'generating', 'running', 'in progress'].includes(text)) return { state: 'pending' };
      if (text !== 'completed') throw new Error('AIVID video status is not recognized.');
      const cdp = await page.context().newCDPSession(page);
      let timer, listener;
      try {
        const enabled = await cdp.send('Browserless.setDownloadEnabled', { enabled: true });
        if (!enabled?.ok) throw new Error('Browserless download streaming is unavailable.');
        const downloaded = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('AIVID video download timed out.')), 60000);
          listener = file => {
            if (file.error || file.mimeType !== 'video/mp4' || !Number.isSafeInteger(file.size) || file.size <= 0 ||
                file.size > MAX_OUTPUT_BYTES || typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_OUTPUT_BYTES / 3) * 4)
              return reject(new Error('AIVID did not return a supported MP4 within the download limit.'));
            const data = Buffer.from(file.data, 'base64');
            if (data.length !== file.size || data.length < 12 || data.toString('ascii', 4, 8) !== 'ftyp')
              return reject(new Error('AIVID returned an invalid MP4.'));
            resolve({ state: 'completed', output: { data, mimeType: 'video/mp4' } });
          };
          cdp.on('Browserless.fileDownloaded', listener);
        });
        // Handle rejection immediately, including when the click itself fails.
        downloaded.catch(() => {});
        await page.getByRole('button', { name: 'Download Video', exact: true }).click();
        return await downloaded;
      } finally {
        clearTimeout(timer); if (listener) cdp.off('Browserless.fileDownloaded', listener);
        await cdp.send('Browserless.setDownloadEnabled', { enabled: false }).catch(() => {});
        await cdp.detach().catch(() => {});
      }
    });
  }
}

module.exports = { AividBrowserlessClient, validateJob, validateSubmission, creditState, providerId, submissionResult,
  isGenerationResponse, waitForSession, openLoginPage, prepare, installRequestGuard, MINI, ID };

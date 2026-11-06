'use strict';

const { connectSession, LOGIN_VIEWPORT } = require('./browserless.js');
const ORIGIN = 'https://aivid.dev';
const API = 'https://api.aivid.dev';
const MINI = 'Seedance 2.0 (Mini)';
const { aividModel, DEFAULT_ID } = require('../aivid_models.js');
const ID = /^[a-zA-Z0-9_-]{16,80}$/;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const INPUTS = {
  image: 'input[type="file"][accept="image/jpeg,image/png,image/webp"]',
  video: 'input[type="file"][accept="video/mp4,video/quicktime"]',
  audio: 'input[type="file"][accept="audio/mpeg,audio/wav"]',
};
const MIME = { image: ['image/jpeg', 'image/png', 'image/webp'], video: ['video/mp4', 'video/quicktime'], audio: ['audio/mpeg', 'audio/wav'] };

// Only fixed diagnostic codes/messages cross the RDP bridge. Never forward
// Playwright call logs, page text, account data or connection URLs.
const DIAGNOSTICS = Object.freeze({
  browser_connection: 'Could not connect to the local Chrome profile. Close the Login Chrome windows, then restart Agent.',
  page_navigation: 'AIVID did not load in time. Check its Chrome tab and the RDP internet connection.',
  session_check: 'AIVID sign-in or its generation form is not ready. Inspect the Chrome tab before retrying.',
  session_sign_in: 'AIVID still shows Sign In. Finish sign-in in the Login Chrome window, close it, then restart Agent.',
  session_form_missing: 'No visible prompt editor was found in the AIVID generation area. Check that the Generate page has finished loading.',
  session_form_ambiguous: 'More than one visible prompt editor was found. Close extra AIVID dialogs before retrying.',
  session_page_left: 'The AIVID tab left the generation site. Inspect Chrome and finish any sign-in steps before retrying.',
  model_selection: 'Could not select Seedance 2.0 (Mini). Check that its model menu opens on the RDP.',
  aspect_ratio: 'Could not select the requested AIVID aspect ratio.',
  resolution: 'Could not select the requested AIVID resolution.',
  duration: 'Could not set or verify the AIVID duration slider.',
  privacy: 'Could not set AIVID public visibility. No video was submitted.',
  reference_upload: 'AIVID reference upload controls did not match the requested files.',
  prompt: 'Could not fill the AIVID prompt field.',
  form_verification: 'AIVID form settings did not match after preparation. No video was submitted.',
  credit_reading: 'Could not identify the AIVID account balance and video price. A zero balance is allowed for this check.',
  browser_check: 'The AIVID operation failed. Inspect Chrome and the Agent window; no automatic resubmission is allowed.',
});
function diagnosticCode(error) {
  return Object.hasOwn(DIAGNOSTICS, error?.aividCode) ? error.aividCode : 'browser_check';
}
function diagnosticMessage(code) {
  return DIAGNOSTICS[Object.hasOwn(DIAGNOSTICS, code) ? code : 'browser_check'];
}
async function step(code, action, onProgress) {
  if (onProgress) onProgress(code);
  try { return await action(); }
  catch (error) {
    // Preserve a more specific nested stage, without copying its raw message.
    const known = Object.hasOwn(DIAGNOSTICS, error?.aividCode) ? error.aividCode : code;
    throw Object.assign(new Error(diagnosticMessage(known)), { aividCode: known });
  }
}

function validateJob(value, references = []) {
  if (!value || typeof value !== 'object') throw new Error('An AIVID job is required.');
  const spec=aividModel(value.model || DEFAULT_ID);
  if(!spec)throw new Error('Unknown AIVID Premium model.');
  const job = { modelId:spec.id, modelLabel:spec.name, providerModelId:spec.providerId,
    prompt: String(value.prompt || '').trim(), duration: Number(value.duration),
    aspectRatio: String(value.aspectRatio || value.aspect_ratio || '16:9'), resolution: String(value.resolution || '480p') };
  if (!job.prompt || job.prompt.length > 50000) throw new Error('Prompt must contain 1–50,000 characters.');
  if (!Number.isInteger(job.duration) || job.duration < 4 || job.duration > spec.maxSeconds) throw new Error('The selected model does not support this duration.');
  if (!['16:9', '9:16', '1:1'].includes(job.aspectRatio)) throw new Error('Unsupported Mini aspect ratio.');
  if (!spec.resolutions.includes(job.resolution)) throw new Error('Unsupported model resolution.');
  if (!Array.isArray(references) || references.length > spec.refs.image+spec.refs.video+spec.refs.audio) throw new Error('Too many references for this model.');
  const counts = { image: 0, video: 0, audio: 0 }; let totalBytes = 0;
  for (const ref of references) {
    if (!MIME[ref.kind]?.includes(ref.mimeType) || !Buffer.isBuffer(ref.data) || !ref.data.length)
      throw new Error('A reference has an unsupported kind, format or empty file.');
    counts[ref.kind]++; totalBytes += ref.data.length;
    if (ref.data.length > (ref.kind === 'image' ? 10 : 30) * 1024 * 1024)
      throw new Error('A reference exceeds the adapter file size limit.');
  }
  if (counts.image > spec.refs.image || counts.video > spec.refs.video || counts.audio > spec.refs.audio || totalBytes > 64 * 1024 * 1024)
    throw new Error('The reference count or combined file size exceeds the current adapter limit.');
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
// prove the requested public visibility or that every upload reached the paid request.
function validateSubmission(body, job) {
  if (!body || typeof body !== 'object' || body.model !== job.providerModelId || body.prompt !== job.prompt ||
    Number(body.duration) !== job.duration || body.resolution !== job.resolution ||
    (body.aspectRatio ?? body.aspect_ratio) !== job.aspectRatio)
    throw new Error('AIVID submission settings differ from the prepared job.');
  const publicChecks = [];
  for (const key of ['isPublic', 'public']) if (Object.hasOwn(body, key)) publicChecks.push(body[key] === true);
  for (const key of ['isPrivate', 'private']) if (Object.hasOwn(body, key)) publicChecks.push(body[key] === false);
  if (Object.hasOwn(body, 'visibility')) publicChecks.push(body.visibility === 'public');
  if (!publicChecks.length || publicChecks.some(ok => !ok)) throw new Error('AIVID public visibility could not be verified before submission.');
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

function promptEditors(page) {
  // The signed-in editor can be contenteditable. Placeholder-only lookup can
  // find a hidden fallback textarea or miss the actual rich-text editor.
  return page.locator('main').first().locator('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]').filter({ visible: true });
}
function sessionFailure(code) { return Object.assign(new Error(diagnosticMessage(code)), { aividCode: code }); }
async function waitForSession(page, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs; let stableSince = null, signedOut = false, count = 0;
  do {
    if (new URL(page.url()).origin !== ORIGIN) throw sessionFailure('session_page_left');
    signedOut = await page.getByRole('button', { name: 'Sign In', exact: true }).filter({ visible: true }).count() > 0;
    count = await promptEditors(page).count();
    const ready = !signedOut && count === 1;
    if (ready) { stableSince ??= Date.now(); if (Date.now() - stableSince >= 1000) return; }
    else stableSince = null;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw sessionFailure(signedOut ? 'session_sign_in' : count > 1 ? 'session_form_ambiguous' : 'session_form_missing');
}

async function promptValue(editor) {
  return editor.evaluate(element => element.tagName === 'TEXTAREA' ? element.value : element.innerText);
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

// Observed AIVID form: Public / <label><input class="sr-only" ...></label> / Private.
// Its checked state is !isPublic. Click the visible label, never the hidden
// input or an unrelated checkbox (for example the reference bypass toggle).
async function setPublicVisibility(main) {
  const group = main.locator('div:has(> span:text-is("Public")):has(> span:text-is("Private"))');
  if (await group.count() !== 1 || !await group.isVisible()) throw new Error('Unknown AIVID privacy control.');
  const checkbox = group.locator('label input[type="checkbox"]');
  if (await checkbox.count() !== 1 || !await checkbox.isEnabled()) throw new Error('Unknown AIVID privacy switch.');
  if (await checkbox.isChecked()) {
    const label = group.locator('label:has(input[type="checkbox"])');
    if (await label.count() !== 1) throw new Error('Ambiguous AIVID privacy switch.');
    await label.click();
  }
  if (await checkbox.isChecked()) throw new Error('AIVID did not select public visibility.');
  return checkbox;
}

async function prepare(page, value, references = [], { onProgress } = {}) {
  const job = validateJob(value, references);
  await step('page_navigation', () => page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }), onProgress);
  await step('session_check', () => waitForSession(page), onProgress);
  const main = page.locator('main').first();
  await step('model_selection', async () => {
    await main.getByRole('button', { name: /Seedance|MiniMax/ }).first().click();
    const pattern=job.modelId==='aivid_seedance_2_0'
      ? /^Seedance 2\.0(?! \(Mini\))(?:\s|$)/
      : job.modelId==='aivid_seedance_2_0_mini'
        ? /^Seedance 2\.0 \(Mini\)(?:\s|$)/
        : /^Seedance 2\.5(?:\s|$)/;
    const candidate=main.getByRole('button',{name:pattern});
    if(await candidate.count()!==1)throw new Error('AIVID model option was not unique.');
    await candidate.click();
  }, onProgress);
  await step('aspect_ratio', () => choose(page, /^\d+:\d+$/, job.aspectRatio), onProgress);
  await step('resolution', () => choose(page, /^\d+p$/, job.resolution), onProgress);
  const slider = main.locator('input[type="range"][min="4"]');
  await step('duration', async () => {
    if (await slider.count() !== 1 || Number(await slider.getAttribute('max'))<job.duration) throw new Error();
    // Keyboard events update the app's duration state as well as the DOM value.
    await slider.press('Home');
    for (let second = 4; second < job.duration; second++) await slider.press('ArrowRight');
    if (await slider.inputValue() !== String(job.duration)) throw new Error();
  }, onProgress);
  // Owner-selected Public mode must be set before reading its price.
  // Both the visible form and the outgoing payload independently verify it.
  const privacy = await step('privacy', () => setPublicVisibility(main), onProgress);
  await step('reference_upload', async () => {
    for (const kind of Object.keys(INPUTS)) {
      const refs = references.filter(ref => ref.kind === kind);
      if (!refs.length) continue;
      const input = main.locator(INPUTS[kind]);
      if (await input.count() !== 1) throw new Error('AIVID reference upload control changed.');
      await input.setInputFiles(refs.map((r, i) => ({ name: 'reference-' + kind + '-' + (i + 1) + '.' + r.mimeType.split('/')[1], mimeType: r.mimeType, buffer: r.data })));
    }
  }, onProgress);
  const prompt = promptEditors(page);
  await step('prompt', () => prompt.fill(job.prompt), onProgress);
  await step('form_verification', async () => {
    if (await privacy.isChecked() || await slider.inputValue() !== String(job.duration) || await promptValue(prompt) !== job.prompt ||
        !await main.getByRole('button', { name: job.modelLabel, exact: true }).isVisible() ||
        !await main.getByRole('button', { name: job.aspectRatio, exact: true }).isVisible() ||
        !await main.getByRole('button', { name: job.resolution, exact: true }).isVisible())
      throw new Error('AIVID form verification failed.');
  }, onProgress);
  return job;
}

async function installRequestGuard(page, job) {
  const cdp = await page.context().newCDPSession(page);
  let guardError = null, allowed = false, armed = false;
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
      if (!armed) throw new Error('AIVID submission was blocked before its durable reservation.');
      allowed = true;
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
    } catch (error) {
      guardError = error instanceof SyntaxError ? new Error('AIVID submission schema needs verification.') : error;
      await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }).catch(() => {});
    }
  };
  cdp.on('Fetch.requestPaused', handler);
  return { arm() { armed = true; }, get error() { return guardError; }, get allowed() { return allowed; },
    close: async () => { await cdp.send('Fetch.disable').catch(() => {}); await cdp.detach().catch(() => {}); } };
}

class AividBrowserlessClient {
  constructor({ connectUrl, maxSourceCredits = 0, connect = connectSession, download = null, onProgress = null } = {}) {
    this.connectUrl = connectUrl; this.maxSourceCredits = maxSourceCredits; this.connect = connect; this.download = download; this.onProgress = onProgress;
  }
  async withPage(fn) {
    const session = await step('browser_connection', () => this.connect(this.connectUrl), this.onProgress);
    try { return await fn(session.page); }
    finally { await session.close(); } // Retains the persistent session; never DELETE its stop URL.
  }
  async preflight(value, references = []) {
    return this.withPage(async page => {
      const job = await prepare(page, value, references, { onProgress: this.onProgress });
      const credits = await step('credit_reading', async () => creditState(await page.locator('body').innerText()), this.onProgress);
      return { ready: true, model: job.modelLabel, modelId: job.modelId, duration: job.duration, resolution: job.resolution,
        aspectRatio: job.aspectRatio, referenceCounts: job.counts, ...credits, submitted: false };
    });
  }
  async startVideo(value, references = [], { beforeClick } = {}) {
    if (typeof beforeClick !== 'function') throw new Error('A durable submission reservation is required.');
    if (!Number.isFinite(this.maxSourceCredits) || this.maxSourceCredits <= 0) throw new Error('Set an explicit AIVID source credit limit before submission.');
    return this.withPage(async page => {
      const job = await prepare(page, value, references, { onProgress: this.onProgress });
      const credits = await step('credit_reading', async () => creditState(await page.locator('body').innerText()), this.onProgress);
      if (credits.price <= 0 || credits.price > this.maxSourceCredits || credits.balance < credits.price)
        throw new Error('AIVID price exceeds the limit or the account has insufficient credits.');
      const guard = await installRequestGuard(page, job);
      try {
        // Commit before any click, even if the process dies inside click().
        await beforeClick({ price: credits.price });
        const responsePromise = page.waitForResponse(isGenerationResponse, { timeout: 45000 }).catch(() => null);
        guard.arm();
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
      if (this.download) return { state: 'completed', output: await this.download(page) };
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
  isGenerationResponse, waitForSession, promptEditors, promptValue, openLoginPage, prepare, installRequestGuard, DIAGNOSTICS, diagnosticCode, diagnosticMessage, MINI, ID };

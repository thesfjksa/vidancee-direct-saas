'use strict';

// CreatePulse API (createpulse.online/docs). POST /api/generate with
// "X-API-Key: cp_…" → {ok, batchId, cost, status}; GET /api/status?batchId=…
// until "done" (url) or "failed" (refunded by CreatePulse). Reference images
// are public URLs (the app's signed links). The API refuses every request
// while the account holds less than $10 (HTTP 403). Errors: 401 bad key,
// 402 no balance, 403 disabled or under $10, 404 unknown batch.
const { readBounded, checkOutputUrl, VIDEO_LIMIT } = require('./vercel.js');
const { API_ORIGIN } = require('../createpulse_models.js');

const USER_AGENT = 'CMMTools/1.0 (+https://cmmtools.site)';

class CreatePulseClient {
  constructor({ apiKey = '', fetchImpl = fetch } = {}) { this.apiKey = String(apiKey || '').trim(); this.fetch = fetchImpl; }

  async json(path, { body, timeoutMs = 30000 } = {}) {
    if (!this.apiKey) throw new Error('Save a CreatePulse API key in Admin first.');
    let response;
    try {
      response = await this.fetch(API_ORIGIN + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, 'x-api-key': this.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('CreatePulse could not be reached. Please try again later.'), { statusCode: 502, retryable: true });
    }
    let parsed = null;
    try { parsed = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')); } catch {}
    if (!response.ok || parsed?.ok === false) {
      const s = response.status, detail = String(parsed?.error || parsed?.message || '').slice(0, 300);
      const text = s === 401 ? 'CreatePulse rejected the API key.' :
        s === 402 ? 'CreatePulse has insufficient balance.' :
          s === 403 ? 'CreatePulse refused the request: ' + (detail || 'the account is disabled or holds less than $10.') :
            'CreatePulse: ' + (detail || 'request failed (HTTP ' + s + ')');
      throw Object.assign(new Error(text), { statusCode: 502, providerStatus: s, detail, retryable: s === 429 || s >= 500 });
    }
    if (!parsed) throw Object.assign(new Error('CreatePulse returned an invalid response.'), { statusCode: 502, retryable: true });
    return parsed;
  }

  // The request body for one job. references: [{role, mimeType, url}].
  videoRequest(model, params, references = []) {
    const images = references.filter(r => String(r.mimeType || '').startsWith('image/'));
    const start = images.find(r => r.role === 'start_image'), end = images.find(r => r.role === 'end_image');
    const others = images.filter(r => r !== start && r !== end);
    if (end && !start) throw new Error('Add a start frame before an end frame.');
    const body = { kind: 'video', model: model.createPulse?.model || model.providerModelId, prompt: String(params.prompt || ''),
      aspect: String(params.aspectRatio), duration: Number(params.duration) };
    if (start) body.init_image_url = start.url;
    if (end) body.end_frame_url = end.url;
    if (others.length) body.image_reference_urls = others.slice(0, 4).map(r => r.url);
    return body;
  }

  // Returns {requestId, cost}; saved so a restart resumes the job.
  async startVideo(model, params, references = []) {
    const r = await this.json('/api/generate', { body: this.videoRequest(model, params, references), timeoutMs: 120000 });
    const id = String(r.batchId || '');
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) throw new Error('CreatePulse did not return a batch id.');
    return { requestId: id, cost: Number.isFinite(Number(r.cost)) ? Number(r.cost) : null };
  }

  // {status: 'done'|'failed'|'pending', url?, error?}
  async videoStatus(op) {
    const id = String(op?.requestId || '');
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) throw new Error('The video operation could not be resumed.');
    const r = await this.json('/api/status?batchId=' + encodeURIComponent(id), { timeoutMs: 20000 });
    const status = String(r.status || '').toLowerCase();
    if (status === 'done') return r.url ? { status: 'done', url: String(r.url) } : { status: 'failed', error: 'No video was returned.' };
    if (status === 'failed') return { status: 'failed', error: String(r.error || 'Video not generated').slice(0, 200), refunded: r.refunded === true };
    return { status: 'pending' };
  }

  // Videos on CreatePulse's own host get the key; other hosts never see it.
  async download(url) {
    const target = new URL(checkOutputUrl(url));
    const own = target.origin === API_ORIGIN;
    let response;
    try {
      response = await this.fetch(target.toString(), { redirect: own ? 'manual' : 'follow', signal: AbortSignal.timeout(180000),
        headers: { 'user-agent': USER_AGENT, ...(own ? { 'x-api-key': this.apiKey } : {}) } });
      // A redirect off CreatePulse's host is followed without the key.
      const next = response.headers.get('location');
      if (own && response.status >= 300 && response.status < 400 && next) {
        await response.body?.cancel?.().catch(() => {});
        response = await this.fetch(checkOutputUrl(new URL(next, target).toString()), { signal: AbortSignal.timeout(180000), headers: { 'user-agent': USER_AGENT } });
      }
    } catch { throw Object.assign(new Error('The video could not be downloaded from CreatePulse.'), { retryable: true }); }
    if (!response?.ok) { await response?.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('The video could not be downloaded from CreatePulse.'), { retryable: true }); }
    const data = await readBounded(response, VIDEO_LIMIT);
    if (!data.length || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('CreatePulse did not return a supported MP4 video.');
    return { data, mimeType: 'video/mp4' };
  }

  // Key check without spending: an unknown batch answers 404 for a valid key
  // and 401 for a wrong one. 403 means the account is disabled or under $10.
  async verifyKey() {
    try { await this.json('/api/status?batchId=cmm-key-check'); }
    catch (error) { if (error.providerStatus !== 404) throw error; }
    return true;
  }
}

module.exports = { CreatePulseClient };

'use strict';

// Sluice API (getsluice.com/docs). POST /v1/videos/generations with
// "Authorization: Bearer slu_live_…" and an Idempotency-Key → 202 {job};
// GET /v1/videos/generations/{id} until succeeded (video_url), failed or
// canceled. Failed and canceled jobs are refunded by Sluice. Errors are
// {error: {code, message}}; 402 means no balance, 429 is concurrency/rate.
// Unknown fields are rejected, and there is no aspect-ratio field: the chosen
// ratio is written into the prompt. Requests need a non-default User-Agent.
const { readBounded, checkOutputUrl, VIDEO_LIMIT } = require('./vercel.js');
const { API_ORIGIN } = require('../sluice_models.js');

const USER_AGENT = 'CMMTools/1.0 (+https://cmmtools.site)';
// Sluice's body ceiling is 72 MiB; inline images (base64) are kept well under it.
const INLINE_LIMIT = 48 * 1024 * 1024;
const RATIO_WORDS = { '16:9': '16:9 widescreen', '9:16': '9:16 vertical', '1:1': '1:1 square', '4:3': '4:3', '3:4': '3:4 vertical', '21:9': '21:9 cinematic widescreen' };

class SluiceClient {
  constructor({ apiKey = '', fetchImpl = fetch } = {}) { this.apiKey = String(apiKey || '').trim(); this.fetch = fetchImpl; }

  async json(path, { body, headers = {}, timeoutMs = 30000, auth = true } = {}) {
    if (auth && !this.apiKey) throw new Error('Save a Sluice API key in Admin first.');
    let response;
    try {
      response = await this.fetch(API_ORIGIN + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(auth ? { authorization: 'Bearer ' + this.apiKey } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Sluice could not be reached. Please try again later.'), { statusCode: 502, retryable: true });
    }
    let parsed = null;
    try { parsed = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')); } catch {}
    if (!response.ok) {
      const s = response.status, err = parsed?.error || {};
      const code = String(err.code || ''), detail = String(err.message || '').slice(0, 300);
      const text = s === 401 ? 'Sluice rejected the API key.' :
        s === 402 ? (code === 'spend_limit_exceeded' ? 'The Sluice key reached its monthly spend limit.' : 'Sluice has insufficient balance.') :
          s === 429 ? 'Sluice is at its job limit. Please try again shortly.' :
            'Sluice: ' + (detail || 'request failed (HTTP ' + s + ')');
      throw Object.assign(new Error(text), { statusCode: 502, providerStatus: s, providerCode: code, detail, retryable: s === 429 || s >= 500 });
    }
    if (!parsed) throw Object.assign(new Error('Sluice returned an invalid response.'), { statusCode: 502, retryable: true });
    return parsed;
  }

  // The request body for one job. references: [{role, mimeType, url, data?}];
  // images with data go inline (data_uri) up to INLINE_LIMIT, others by URL.
  videoRequest(model, params, references = []) {
    const kind = r => String(r.mimeType || '').split('/')[0];
    let inline = 0;
    const ref = r => {
      if (Buffer.isBuffer(r.data) && r.data.length) {
        const size = Math.ceil(r.data.length / 3) * 4;
        if (inline + size <= INLINE_LIMIT) { inline += size; return { data_uri: 'data:' + r.mimeType + ';base64,' + r.data.toString('base64') }; }
      }
      return { url: r.url };
    };
    const images = references.filter(r => kind(r) === 'image');
    const start = images.find(r => r.role === 'start_image'), end = images.find(r => r.role === 'end_image');
    const others = images.filter(r => r !== start && r !== end);
    if (end && !start) throw new Error('Add a start frame before an end frame.');
    const ratio = String(params.aspectRatio || '');
    const prompt = String(params.prompt || '').trim() + (RATIO_WORDS[ratio] ? '\n\nAspect ratio: ' + RATIO_WORDS[ratio] + '.' : '');
    const body = { model: model.sluice?.model || model.providerModelId, prompt, duration_seconds: Number(params.duration), resolution: String(params.resolution) };
    if (others.length) body.references = others.map(ref);
    if (start) body.first_frame = ref(start);
    if (end) body.last_frame = ref(end);
    return body;
  }

  // Returns {requestId}; saved so a restart resumes the job. The idempotency
  // key makes a resend after a lost answer return the same job.
  async startVideo(model, params, references = [], idempotencyKey = null) {
    const body = this.videoRequest(model, params, references);
    const r = await this.json('/v1/videos/generations', { body, timeoutMs: 180000, headers: idempotencyKey ? { 'idempotency-key': String(idempotencyKey) } : {} });
    const id = String(r?.job?.id || '');
    if (!/^job_[A-Za-z0-9]+$/.test(id)) throw new Error('Sluice did not return a video job.');
    return { requestId: id, costMicros: Number(r.job.cost_micros) || null };
  }

  // {status: 'done'|'failed'|'pending', url?, error?}
  async videoStatus(op) {
    if (!/^job_[A-Za-z0-9]+$/.test(String(op?.requestId || ''))) throw new Error('The video operation could not be resumed.');
    const r = await this.json('/v1/videos/generations/' + encodeURIComponent(op.requestId), { timeoutMs: 20000 });
    const job = r?.job || {}, status = String(job.status || '').toLowerCase();
    if (status === 'succeeded') return job.video_url ? { status: 'done', url: String(job.video_url) } : { status: 'failed', error: 'No video was returned.' };
    if (status === 'failed' || status === 'canceled' || status === 'cancelled') return { status: 'failed', error: String(job.error_message || job.error_code || status).slice(0, 200) };
    return { status: 'pending' };
  }

  async download(url) {
    let current = checkOutputUrl(url), response;
    try {
      for (let hop = 0; hop < 4; hop++) {
        response = await this.fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(180000), headers: { 'user-agent': USER_AGENT } });
        const next = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && next) { await response.body?.cancel?.().catch(() => {}); current = checkOutputUrl(new URL(next, current).toString()); continue; }
        break;
      }
    } catch { throw Object.assign(new Error('The video could not be downloaded from Sluice.'), { retryable: true }); }
    if (!response?.ok) { await response?.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('The video could not be downloaded from Sluice.'), { retryable: true }); }
    const data = await readBounded(response, VIDEO_LIMIT);
    if (!data.length || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Sluice did not return a supported MP4 video.');
    return { data, mimeType: 'video/mp4' };
  }

  // The key check also reads the balance: {availableUsd, spendLimitUsd, monthSpendUsd}.
  async balance() {
    const r = await this.json('/v1/balance');
    const usd = micros => (Number.isFinite(Number(micros)) ? Number(micros) / 1e6 : null);
    return { availableUsd: usd(r?.balance?.available_micros), reservedUsd: usd(r?.balance?.reserved_micros),
      spendLimitUsd: usd(r?.spend_limit_micros), monthSpendUsd: usd(r?.month_spend_micros) };
  }
}

module.exports = { SluiceClient, RATIO_WORDS };

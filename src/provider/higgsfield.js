'use strict';

// Higgsfield API (docs.higgsfield.ai). POST {origin}/{endpoint} with
// "Authorization: Key KEY_ID:KEY_SECRET" and an Idempotency-Key → {request_id,
// status_url}; GET status_url until completed (video.url), failed, nsfw or
// canceled. POST /estimate/{endpoint} gives {credits, usd} without charging.
// POST /files/generate-upload-url gives a presigned upload for input files.
// Failed and moderated requests are not charged. HTTP 403 means no credits.
const { readBounded, checkOutputUrl, VIDEO_LIMIT } = require('./vercel.js');
const { API_ORIGIN } = require('../higgsfield_models.js');

// Content types Higgsfield's upload endpoint takes; other files keep the app's signed link.
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'audio/wav', 'audio/x-wav', 'video/mp4'];
const TERMINAL_FAILURES = ['failed', 'nsfw', 'canceled', 'cancelled'];

function statusUrl(value) {
  const url = String(value || '');
  if (!url.startsWith(API_ORIGIN + '/requests/')) throw new Error('Higgsfield returned an unexpected status address.');
  return url;
}

class HiggsfieldClient {
  // apiKey is "KEY_ID:KEY_SECRET", as Higgsfield Console shows the pair.
  constructor({ apiKey = '', fetchImpl = fetch } = {}) { this.apiKey = String(apiKey || '').trim(); this.fetch = fetchImpl; }

  async json(url, { body, headers = {}, timeoutMs = 30000 } = {}) {
    if (!this.apiKey) throw new Error('Save a Higgsfield API key in Admin first.');
    let response;
    try {
      response = await this.fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: 'Key ' + this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Higgsfield could not be reached. Please try again later.'), { statusCode: 502, retryable: true });
    }
    let parsed = null;
    try { parsed = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')); } catch {}
    if (!response.ok) {
      const s = response.status;
      const raw = parsed?.detail ?? parsed?.error ?? parsed?.message ?? '';
      const detail = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(d => [d?.loc?.slice?.(-1)?.[0], d?.msg].filter(Boolean).join(': ')).join('; ') : '').slice(0, 300);
      const busy = s === 400 && /concurrent/i.test(detail);
      const text = s === 401 ? 'Higgsfield rejected the API key.' :
        s === 403 ? 'Higgsfield has insufficient credits.' :
          busy ? 'Higgsfield is at its concurrency limit. Please try again shortly.' :
            s === 423 || s === 503 ? 'This Higgsfield model is temporarily unavailable.' :
              'Higgsfield request failed (HTTP ' + s + ')' + (detail ? ': ' + detail : '.');
      throw Object.assign(new Error(text), { statusCode: 502, providerStatus: s, detail, retryable: busy || s === 423 || s === 503 || s >= 500 });
    }
    if (!parsed) throw Object.assign(new Error('Higgsfield returned an invalid response.'), { statusCode: 502, retryable: true });
    return parsed;
  }

  // {credits, usd} for a request, without charging.
  async estimate(path, input) {
    const r = await this.json(API_ORIGIN + '/estimate/' + path, { body: input, timeoutMs: 20000 });
    return { credits: Number(r.credits), usd: Number(r.usd) };
  }

  // Puts one input file in Higgsfield's storage and returns its public URL.
  async upload({ data, mimeType }) {
    const type = String(mimeType || '').toLowerCase();
    if (!UPLOAD_TYPES.includes(type)) throw new Error('Higgsfield storage does not take ' + (type || 'this file type') + '.');
    const u = await this.json(API_ORIGIN + '/files/generate-upload-url', { body: { content_type: type }, timeoutMs: 20000 });
    if (!u?.upload_url || !u?.public_url) throw new Error('Higgsfield returned no upload address.');
    let put;
    try {
      // No Higgsfield credentials go to the presigned storage address.
      put = await this.fetch(String(u.upload_url), { method: 'PUT', body: data, redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': type, ...(u.upload_headers && typeof u.upload_headers === 'object' ? u.upload_headers : {}) } });
    } catch { throw Object.assign(new Error('The file could not be uploaded to Higgsfield.'), { retryable: true }); }
    await put.body?.cancel?.().catch(() => {});
    if (!put.ok) throw Object.assign(new Error('The file could not be uploaded to Higgsfield (HTTP ' + put.status + ').'), { retryable: put.status >= 500 });
    return String(u.public_url);
  }

  // The request for one job: start/end frames use the image route; reference
  // images, videos and sound clips the reference route (cited as @Image1,
  // @Video1, @Audio1 in the prompt); otherwise text. Prompts are sent as written.
  videoRequest(model, params, references = []) {
    const paths = model.higgsfield?.paths || {};
    const kind = r => String(r.mimeType || '').split('/')[0];
    const start = references.find(r => r.role === 'start_image'), end = references.find(r => r.role === 'end_image');
    const images = references.filter(r => kind(r) === 'image' && r !== start && r !== end);
    const videos = references.filter(r => kind(r) === 'video');
    const audios = references.filter(r => kind(r) === 'audio');
    const input = { prompt: String(params.prompt || ''), duration: Number(params.duration), resolution: String(params.resolution),
      generate_audio: Boolean(params.generateAudio) };
    if (start || end) {
      if (images.length || videos.length || audios.length) throw new Error('Use either start/end frames or reference files in a single video request.');
      if (!start) throw new Error('Add a start frame before an end frame.');
      // The video takes the start frame's shape.
      return { path: paths.i2v, input: { ...input, aspect_ratio: 'adaptive', image_url: start.url, ...(end ? { end_image_url: end.url } : {}) } };
    }
    input.aspect_ratio = String(params.aspectRatio);
    if (images.length || videos.length || audios.length) {
      if (images.length) input.image_urls = images.map(r => r.url);
      if (videos.length) input.video_urls = videos.map(r => r.url);
      if (audios.length) input.audio_urls = audios.map(r => r.url);
      return { path: paths.r2v, input };
    }
    return { path: paths.t2v, input };
  }

  // Returns {requestId, statusUrl}; saved so a restart resumes the job. The
  // idempotency key makes a resend after a lost answer return the same request.
  async startVideo(model, params, references = [], idempotencyKey = null) {
    const { path, input } = this.videoRequest(model, params, references);
    if (!path) throw new Error('This model is not set up for that request.');
    const r = await this.json(API_ORIGIN + '/' + path, { body: input, timeoutMs: 120000,
      headers: idempotencyKey ? { 'idempotency-key': String(idempotencyKey) } : {} });
    if (!r?.request_id) throw new Error('Higgsfield did not return a video job.');
    return { requestId: String(r.request_id), statusUrl: statusUrl(r.status_url || API_ORIGIN + '/requests/' + encodeURIComponent(r.request_id) + '/status') };
  }

  // {status: 'done'|'failed'|'pending', url?, error?}
  async videoStatus(op) {
    const r = await this.json(statusUrl(op?.statusUrl), { timeoutMs: 20000 });
    const status = String(r?.status || '').toLowerCase();
    if (status === 'completed') return r?.video?.url ? { status: 'done', url: String(r.video.url) } : { status: 'failed', error: 'No video was returned.' };
    if (status === 'nsfw') return { status: 'failed', error: 'The content filter blocked this request.' };
    if (TERMINAL_FAILURES.includes(status)) return { status: 'failed', error: String(r.error || status).slice(0, 200) };
    return { status: 'pending' };
  }

  async download(url) {
    let response;
    try { response = await this.fetch(checkOutputUrl(url), { signal: AbortSignal.timeout(180000) }); }
    catch { throw Object.assign(new Error('The video could not be downloaded from Higgsfield.'), { retryable: true }); }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('The video could not be downloaded from Higgsfield.'), { retryable: true }); }
    const data = await readBounded(response, VIDEO_LIMIT);
    if (!data.length || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Higgsfield did not return a supported MP4 video.');
    return { data, mimeType: 'video/mp4' };
  }

  // Key check without starting a job: a status read for an unknown request
  // answers 401 for a bad key and 404 for a good one.
  async verifyKey() {
    try { await this.json(API_ORIGIN + '/requests/00000000-0000-0000-0000-000000000000/status', { timeoutMs: 10000 }); }
    catch (error) { if (error.providerStatus === 401 || !error.providerStatus || error.retryable) throw error; }
    return true;
  }
}

module.exports = { HiggsfieldClient, UPLOAD_TYPES };

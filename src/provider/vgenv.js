const crypto = require('node:crypto');
const { isLongH3Duration, H3_LONG_MAX_SECONDS } = require('../pricing.js');
const LONG_VIDEOS = '/v3/long-videos';

function normalizeBaseUrl(value) {
  return String(value || 'https://api.vgenv.com').replace(/\/$/, '');
}

function extractPrice(value) {
  // /v3 (and newer /v1) answers give {price: {currency, amount_micros}}.
  const micros = Number(value?.price?.amount_micros);
  if (value?.price?.amount_micros != null && Number.isFinite(micros) && micros >= 0) return micros / 1e6;
  const candidates = [
    value?.price,
    value?.price?.amount,
    value?.quote,
    value?.quote?.amount,
    value?.cost,
    value?.cost?.amount,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

// Sound and video references are vgenv Project Assets (api.vgenv.com/docs-json):
// POST /v1/assets/uploads {fileName, contentType, sizeBytes} → {asset: {id},
// upload: {url, method: PUT, headers}}, PUT the bytes, then POST
// /v1/assets/{id}/complete. A video request then names them by id:
// reference_audios: [{asset_id}] (1-2, "Audio 1/2") and reference_video:
// {asset_id} (one MP4). Reference images stay URLs.
const ASSET_TYPES = { 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg', 'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'video/mp4': 'video/mp4', 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };
const ASSET_ID = /^asset_[a-zA-Z0-9_-]+$/;

class VgenvClient {
  constructor({ baseUrl = 'https://api.vgenv.com', apiKey }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = String(apiKey || '').trim();
    this.videoApiPrefix = '/v1';
  }

  async request(path, options = {}) {
    if (!this.apiKey) throw new Error('vgenv API key is not configured.');
    const response = await fetch(this.baseUrl + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + this.apiKey,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });

    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch {
      const error = new Error('vgenv returned a non-JSON response (HTTP ' + response.status + ').');
      error.statusCode = response.status;
      throw error;
    }

    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        ('vgenv HTTP ' + response.status);
      const error = new Error(String(message));
      error.statusCode = response.status;
      if (typeof payload?.error?.code === 'string') error.code = payload.error.code;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
      throw error;
    }

    return payload;
  }

  async videoRequest(path, options = {}) {
    const prefixes = this.videoApiPrefix === '/v2' ? ['/v2','/v1'] : ['/v1','/v2'];
    let lastError = null;
    for (const prefix of prefixes) {
      try {
        const payload = await this.request(prefix + path, options);
        this.videoApiPrefix = prefix;
        return payload;
      } catch (error) {
        lastError = error;
        if (Number(error.statusCode) !== 404) throw error;
      }
    }
    throw lastError || new Error('vgenv video API endpoint was not found.');
  }

  // model is vgenv's base model: 'base' (MiniMax H3, sent the way it always
  // was, on /v1), 'cinematic' or 'origin' (only on /v3, which names them).
  videoPayload({
    model = 'base',
    tier = 'fast',
    prompt,
    duration,
    resolution = '768p',
    aspectRatio,
    referenceImageUrls = [],
    referenceAudioAssetIds = [],
    referenceVideoAssetId = null,
    videoEdit = null,
  }) {
    const v3 = Boolean(videoEdit) || model === 'cinematic' || model === 'origin';
    const qualityTier = String(tier || 'fast').toLowerCase();
    if (!['fast', 'standard', 'enhanced', 'quality'].includes(qualityTier))
      throw new Error('Unsupported vgenv quality tier.');
    const body = {
      model: v3 ? model : 'minimax/h3',
      tier: qualityTier,
      prompt,
      duration: Number(duration),
      resolution: String(resolution || '768p'),
      aspect_ratio: aspectRatio,
    };

    if (referenceImageUrls.length) {
      body.reference_images = referenceImageUrls.slice(0, 9).map(url => ({
        type: 'image_url',
        image_url: { url },
      }));
    }
    if (referenceAudioAssetIds.length) body.reference_audios = referenceAudioAssetIds.slice(0, 2).map(asset_id => ({ asset_id }));
    if (referenceVideoAssetId) body.reference_video = { asset_id: referenceVideoAssetId };

    // /v3 enhances the prompt unless told not to; /v1 sends it as written.
    if (v3) body.prompt_optimization = { mode: 'raw' };
    if (videoEdit) {
      body.preserve_source_audio = videoEdit.preserveAudio === true;
      if (videoEdit.replacement) {
        body.creation_intent = 'person_replacement';
        body.motion_start_seconds = videoEdit.motionStart;
        delete body.prompt_optimization;
      }
    }
    return { body, v3 };
  }

  longVideoPayload({ model = 'base', tier = 'fast', prompt, duration, resolution = '768p', aspectRatio, inputs = [] }) {
    const seconds = Number(duration);
    if (!Number.isInteger(seconds) || !isLongH3Duration(seconds) || seconds > H3_LONG_MAX_SECONDS)
      throw Object.assign(new Error('Choose a long video duration from 16 to 30 seconds.'), { statusCode: 400 });
    return {
      model, tier, duration: seconds, resolution, aspect_ratio: aspectRatio,
      ...(prompt === undefined ? {} : { prompt }),
      ...(inputs.length ? { inputs } : {}),
    };
  }

  async longVideoCapabilities() {
    return this.request(LONG_VIDEOS + '/capabilities', { signal: AbortSignal.timeout(10000) });
  }

  async quoteLongVideo(params) {
    const { prompt, ...body } = this.longVideoPayload(params);
    const payload = await this.request(LONG_VIDEOS + '/quote', {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    return { price: extractPrice(payload), currency: payload?.price?.currency || null };
  }

  async quoteVideoEdit(params) {
    const { body } = this.videoPayload(params);
    const payload = await this.request('/v3/videos/quote', {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    return { price: extractPrice(payload), currency: payload?.price?.currency || null };
  }

  async generateVideo(params) {
    const { idempotencyKey, videoEdit } = params;
    const long = isLongH3Duration(params.duration);
    if (long && videoEdit) throw Object.assign(new Error('Video Tools support up to 15 seconds.'), { statusCode: 400 });
    const { body, v3 } = long ? { body: this.longVideoPayload(params), v3: true } : this.videoPayload(params);
    const options = {
      method: 'POST',
      headers: {
        'Idempotency-Key': String(idempotencyKey || ('mehroz-' + crypto.randomUUID())),
      },
      body: JSON.stringify(body),
      ...(videoEdit || long ? { signal: AbortSignal.timeout(60000) } : {}),
    };
    let payload;
    try {
      payload = long ? await this.request(LONG_VIDEOS, options) : v3 ? await this.request('/v3/videos', options) : await this.videoRequest('/videos', options);
      if (!payload?.id) throw new Error('vgenv returned no video ID.');
    } catch (error) {
      if ((videoEdit || long) && (!error.statusCode || error.statusCode < 400 ||
          error.statusCode >= 500 || [408,409].includes(error.statusCode))) {
        if (videoEdit) error.videoEditSubmissionUncertain = true;
        if (long) error.longVideoSubmissionUncertain = true;
      }
      throw error;
    }

    return {
      id: String(payload.id),
      status: String(payload.status || 'queued').toLowerCase(),
      price: extractPrice(payload),
      currency: payload?.price?.currency || null,
      raw: payload,
    };
  }

  // Uploads one file as a vgenv Project Asset and returns its id once vgenv has confirmed it.
  async uploadAsset({ data, mimeType, fileName = 'reference' }) {
    const contentType = ASSET_TYPES[String(mimeType || '').toLowerCase()];
    if (!contentType) throw new Error('vgenv does not take ' + (mimeType || 'this file type') + ' references.');
    if (!Buffer.isBuffer(data) || !data.length) throw new Error('The reference file is empty.');
    const created = await this.request('/v1/assets/uploads', { method: 'POST',
      body: JSON.stringify({ fileName: String(fileName).slice(0, 255) || 'reference', contentType, sizeBytes: data.length }) });
    const id = String(created?.asset?.id || ''), upload = created?.upload;
    if (!ASSET_ID.test(id) || !upload?.url) throw new Error('vgenv returned no upload address.');
    let put;
    try {
      // Only vgenv's own upload headers go to the storage address, never the API key.
      put = await fetch(String(upload.url), { method: upload.method || 'PUT', body: data, redirect: 'error', signal: AbortSignal.timeout(180000),
        headers: { ...(upload.headers && typeof upload.headers === 'object' ? upload.headers : {}) } });
    } catch { throw Object.assign(new Error('The reference file could not be uploaded to vgenv.'), { retryable: true }); }
    await put.body?.cancel?.().catch(() => {});
    if (!put.ok) throw new Error('The reference file could not be uploaded to vgenv (HTTP ' + put.status + ').');
    const done = await this.request('/v1/assets/' + encodeURIComponent(id) + '/complete', { method: 'POST' });
    if (done?.status && done.status !== 'ready') throw new Error('vgenv did not accept the uploaded reference file (' + done.status + ').');
    return id;
  }

  // Cinematic and Origin videos were made on /v3 and are read there first.
  async getVideo(videoId, { v3 = false, long = false, timeoutMs = 20000 } = {}) {
    const path = '/videos/' + encodeURIComponent(videoId);
    // One deadline covers headers, response body and all version fallbacks.
    // A stuck read must not hold the generation worker indefinitely. This is
    // deliberately read-only: paid submissions keep their existing behavior.
    const options = { signal: AbortSignal.timeout(timeoutMs) };
    let payload = null;
    if (long) payload = await this.request(LONG_VIDEOS + '/' + encodeURIComponent(videoId), options);
    else if (v3) {
      try { payload = await this.request('/v3' + path, options); }
      catch (error) { if (Number(error.statusCode) !== 404) throw error; }
    }
    if (!payload) payload = await this.videoRequest(path, options);
    return {
      id: String(payload.id || videoId),
      status: String(payload.status || 'queued').toLowerCase(),
      progress: payload.progress == null ? null : Number(payload.progress),
      outputUrl: payload?.output?.url || payload?.output_url || payload?.url || null,
      error:
        payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        null,
      price: extractPrice(payload),
      raw: payload,
      ...(payload?.price?.currency ? { currency: payload.price.currency } : {}),
      ...(typeof payload?.error?.code === 'string' ? { errorCode: payload.error.code } : {}),
    };
  }
}

module.exports = { VgenvClient, ASSET_TYPES };


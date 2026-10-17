const crypto = require('node:crypto');

function normalizeBaseUrl(value) {
  return String(value || 'https://api.vgenv.com').replace(/\/$/, '');
}

function extractPrice(value) {
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

// Sound references for MiniMax H3. vgenv's docs could not be read when this
// was added, so the field follows the shape of its reference_images. If vgenv
// rejects or ignores it, change it here only (Admin -> Activity shows its reply).
const AUDIO_FIELD = 'reference_audios';
const audioItems = urls => urls.slice(0, 3).map(url => ({ type: 'audio_url', audio_url: { url } }));

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

  async generateVideo({
    prompt,
    duration,
    resolution = '768p',
    aspectRatio,
    referenceImageUrls = [],
    referenceAudioUrls = [],
    idempotencyKey = null,
  }) {
    const body = {
      model: 'minimax/h3',
      tier: 'fast',
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
    if (referenceAudioUrls.length) body[AUDIO_FIELD] = audioItems(referenceAudioUrls);

    const payload = await this.videoRequest('/videos', {
      method: 'POST',
      headers: {
        'Idempotency-Key': String(idempotencyKey || ('mehroz-' + crypto.randomUUID())),
      },
      body: JSON.stringify(body),
    });

    if (!payload?.id) throw new Error('vgenv returned no video ID.');
    return {
      id: String(payload.id),
      status: String(payload.status || 'queued').toLowerCase(),
      price: extractPrice(payload),
      raw: payload,
    };
  }

  async getVideo(videoId) {
    const payload = await this.videoRequest('/videos/' + encodeURIComponent(videoId));
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
    };
  }
}

module.exports = { VgenvClient, AUDIO_FIELD };

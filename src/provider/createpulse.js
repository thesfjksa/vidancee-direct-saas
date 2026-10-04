class CreatePulseError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'CreatePulseError';
    this.details = details;
  }
}

const MODEL_MAP = {
  'seedance_2.5:10': 'dreamina-seedance-2.5',
  'seedance_2.0_fast:10': 'dreamina-seedance-2.0',
  'seedance_2.0_fast:15': 'dreamina-seedance-2.0-15s',
};

const SUPPORTED_ASPECTS = new Set(['9:16','16:9','1:1','4:3']);

class CreatePulseClient {
  constructor({ baseUrl = 'https://createpulse.online', apiKey, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') throw new CreatePulseError('Global fetch is unavailable. Use Node.js 18+.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
  }

  configured() { return Boolean(this.apiKey); }

  mapModel(model, duration) {
    return MODEL_MAP[String(model) + ':' + Number(duration)] || null;
  }

  supports({ model, duration, aspectRatio, mode = 'text-to-video', imageCount = 0 }) {
    if (!this.configured()) return false;
    if (!this.mapModel(model, duration)) return false;
    if (!SUPPORTED_ASPECTS.has(String(aspectRatio))) return false;
    if (mode === 'image-to-video' && (imageCount < 1 || imageCount > 5)) return false;
    return mode === 'text-to-video' || mode === 'image-to-video';
  }

  async request(path, init = {}) {
    if (!this.apiKey) throw new CreatePulseError('CREATEPULSE_API_KEY is not configured.');
    const headers = new Headers(init.headers || {});
    headers.set('X-API-Key', this.apiKey);
    headers.set('accept', 'application/json');
    const response = await this.fetchImpl(new URL(path, this.baseUrl + '/'), { ...init, headers });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch {
      throw new CreatePulseError('CreatePulse returned non-JSON content.', { status: response.status, preview: text.slice(0, 500) });
    }
    if (!response.ok || data?.ok === false) {
      throw new CreatePulseError(data?.error || ('CreatePulse HTTP ' + response.status), { status: response.status, data });
    }
    return data;
  }

  async generateVideo({ prompt, model, duration, aspectRatio, initImageUrl = null, imageReferenceUrls = [] }) {
    const mappedModel = this.mapModel(model, duration);
    if (!mappedModel) throw new CreatePulseError('This model/duration is not supported by CreatePulse.');
    if (!SUPPORTED_ASPECTS.has(String(aspectRatio))) throw new CreatePulseError('This aspect ratio is not supported by CreatePulse.');

    const body = { kind: 'video', model: mappedModel, prompt: String(prompt || ''), aspect: String(aspectRatio), duration: Number(duration) };
    if (initImageUrl) body.init_image_url = initImageUrl;
    if (Array.isArray(imageReferenceUrls) && imageReferenceUrls.length) body.image_reference_urls = imageReferenceUrls.slice(0, 4);

    const data = await this.request('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!data.batchId) throw new CreatePulseError('CreatePulse accepted the request but returned no batchId.', data);
    return { batchId: String(data.batchId), cost: data.cost == null ? null : Number(data.cost), status: data.status || 'processing', raw: data };
  }

  async getStatus(batchId) {
    const data = await this.request('/api/status?batchId=' + encodeURIComponent(batchId), { method: 'GET' });
    return { status: data.status, url: data.url || null, error: data.error || null, refunded: Boolean(data.refunded), amount: data.amount == null ? null : Number(data.amount), raw: data };
  }
}

module.exports = { CreatePulseClient, CreatePulseError, MODEL_MAP, SUPPORTED_ASPECTS };

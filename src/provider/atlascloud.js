const { getImageModelSpec } = require('../image_pricing.js');

function normalizeBaseUrl(value) {
  return String(value || 'https://api.atlascloud.ai').replace(/\/$/, '');
}

function unwrap(payload) {
  return payload && payload.data && typeof payload.data === 'object' ? payload.data : payload;
}

class AtlasCloudClient {
  constructor({ baseUrl = 'https://api.atlascloud.ai', apiKey }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = String(apiKey || '').trim();
  }

  async request(path, options = {}) {
    if (!this.apiKey) throw new Error('Atlas Cloud API key is not configured.');
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
      throw new Error('Atlas Cloud returned a non-JSON response (HTTP ' + response.status + ').');
    }

    if (!response.ok) {
      const data = unwrap(payload) || {};
      throw new Error(data.error || payload.message || payload.error || ('Atlas Cloud HTTP ' + response.status));
    }
    return payload;
  }

  async generateImage({ model, prompt, aspectRatio, imageUrls = [] }) {
    const spec = getImageModelSpec(model);
    const body = spec.buildPayload({ prompt, aspectRatio, imageUrls });
    const payload = await this.request('/api/v1/model/generateImage', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = unwrap(payload) || {};
    const id = data.id || payload.id;
    if (!id) throw new Error('Atlas Cloud returned no prediction ID.');
    return {
      id: String(id),
      status: String(data.status || 'processing').toLowerCase(),
      outputs: Array.isArray(data.outputs) ? data.outputs : [],
      raw: payload,
    };
  }

  async getPrediction(predictionId) {
    const payload = await this.request('/api/v1/model/prediction/' + encodeURIComponent(predictionId));
    const data = unwrap(payload) || {};
    return {
      id: String(data.id || predictionId),
      status: String(data.status || 'processing').toLowerCase(),
      outputs: Array.isArray(data.outputs) ? data.outputs.filter(Boolean) : [],
      error: data.error || payload.error || null,
      raw: payload,
    };
  }
}

module.exports = { AtlasCloudClient };

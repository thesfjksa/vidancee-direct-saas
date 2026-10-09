const { smartImageRequestSpec } = require('../smartaipi_images.js');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
function smartAipiBaseUrl(value = 'https://api.smartaipi.com/v1') {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('SmartAIPI base URL must be an HTTPS API endpoint without credentials or query parameters.');
  }
  return url.toString().replace(/\/$/, '');
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Image service returned an unsupported image.');
}

function validateSmartReference(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('Reference image must be a PNG, JPEG or WebP file of at most 20 MB.'), { statusCode: 400 });
  }
  try { imageMime(bytes); }
  catch { throw Object.assign(new Error('Reference image must be a valid PNG, JPEG or WebP file.'), { statusCode: 400 }); }
}

class SmartAipiClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 300000 }) {
    this.baseUrl = smartAipiBaseUrl(baseUrl);
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(endpoint, body, timeoutMs = this.timeoutMs) {
    if (!this.apiKey) throw new Error('Image service API key is not configured.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl + endpoint, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // Do not expose upstream bodies: they can contain prompts, URLs or credentials.
      if (!response.ok) throw new Error('Image service request failed (HTTP ' + response.status + ').');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 30 * 1024 * 1024) { controller.abort(); throw new Error('Image service response is too large.'); }
        chunks.push(Buffer.from(chunk));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('Image service returned an invalid response.'); }
    } catch (error) {
      if (controller.signal.aborted && error.name === 'AbortError') throw new Error('Image service timed out.');
      if (/^Image service /.test(error.message)) throw error;
      throw new Error('Image service connection failed.');
    } finally { clearTimeout(timer); }
  }

  async listModels() {
    const result = await this.request('/models', null, 15000);
    if (!Array.isArray(result.data)) throw new Error('Image service returned an invalid model list.');
    return result.data.map(m => String(m.id || '')).filter(Boolean);
  }

  async generateImage({ model, prompt, aspectRatio, quality = 'medium', images = [] }) {
    const spec = smartImageRequestSpec(model, aspectRatio, quality);
    if (images.length > 1) throw new Error('This image model accepts at most one reference image.');
    const body = { model: spec.apiModel, prompt, size: spec.size, quality: spec.quality, n: 1 };
    if (images.length) {
      const bytes = images[0].data;
      validateSmartReference(bytes);
      body.image = bytes.toString('base64');
    }
    const result = await this.request(images.length ? '/images/edits' : '/images/generations', body);
    const encoded = result.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Image service did not return a valid image.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image service returned an invalid image size.');
    return { data: bytes, mimeType: imageMime(bytes) };
  }
}

module.exports = { SmartAipiClient, smartAipiBaseUrl, MAX_IMAGE_BYTES, validateSmartReference };

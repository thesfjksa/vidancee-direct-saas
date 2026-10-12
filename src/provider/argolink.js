'use strict';

// ArgoLink (argolink.io): OpenAI-style image endpoints and an asynchronous
// video job API (submit, poll /v1/videos/{id}, download /content).
const { validateCanvas } = require('../image_canvas.js');
const { readBounded, imageMime, checkOutputUrl, IMAGE_LIMIT, VIDEO_LIMIT } = require('./vercel.js');
const { CATALOG_URL } = require('../argolink_models.js');
const ORIGIN = 'https://argolink.io';

function providerMessage(body) {
  const e = body?.error && typeof body.error === 'object' ? body.error : body;
  return String(e?.message || '').slice(0, 300);
}

class ArgoLinkClient {
  constructor({ apiKey = '', fetchImpl = fetch } = {}) { this.apiKey = apiKey; this.fetch = fetchImpl; }

  async send(path, { body, method, timeoutMs = 30000 } = {}) {
    if (!this.apiKey) throw new Error('Save an ArgoLink API key in Admin first.');
    const headers = { authorization: 'Bearer ' + this.apiKey, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    try {
      return await this.fetch(ORIGIN + path, { method: method || (body ? 'POST' : 'GET'), headers,
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch {
      throw Object.assign(new Error('ArgoLink could not be reached. Please try again later.'), { statusCode: 502, retryable: true });
    }
  }

  async fail(response) {
    let detail = '';
    try { detail = providerMessage(JSON.parse((await readBounded(response, 65536)).toString('utf8'))); } catch {}
    const s = response.status;
    const text = s === 401 || s === 403 ? 'ArgoLink rejected the API key or model access.' :
      s === 402 ? 'ArgoLink has insufficient balance.' :
        s === 429 ? 'ArgoLink rate limit reached. Please try later.' :
          s === 400 && detail ? 'ArgoLink: ' + detail :
            'ArgoLink request failed (HTTP ' + s + ').';
    throw Object.assign(new Error(text), { statusCode: 502, providerStatus: s, detail, retryable: s === 429 || s === 409 || s >= 500 });
  }

  async json(path, { body, timeoutMs, maxBytes = 2 * 1024 * 1024 } = {}) {
    const response = await this.send(path, { body, timeoutMs });
    if (!response.ok) await this.fail(response);
    try { return JSON.parse((await readBounded(response, maxBytes)).toString('utf8')); }
    catch { throw Object.assign(new Error('ArgoLink returned an invalid response.'), { statusCode: 502, retryable: true }); }
  }

  // The catalog is public and needs no key.
  async catalog() {
    let response;
    try { response = await this.fetch(CATALOG_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error' }); }
    catch { throw Object.assign(new Error('ArgoLink could not be reached. Please try again later.'), { statusCode: 502 }); }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('The ArgoLink catalog is unavailable (HTTP ' + response.status + ').'), { statusCode: 502 }); }
    return JSON.parse((await readBounded(response, 8 * 1024 * 1024)).toString('utf8'));
  }

  // Wallet balance (Sub2API-style /v1/usage). Returns null when not reported.
  async balance() {
    const u = await this.json('/v1/usage', { timeoutMs: 8000 });
    const remaining = Number(u?.remaining ?? u?.balance ?? u?.quota?.remaining);
    if (!Number.isFinite(remaining)) return null;
    const used = Number(u?.usage?.total?.cost ?? u?.used ?? u?.total_used);
    return { remaining, used: Number.isFinite(used) ? used : null, unit: String(u?.unit || 'USD') };
  }

  async generateImage(model, params, images = []) {
    const size = String(params.imageSize || '1K').toLowerCase();
    let prompt = String(params.prompt || '');
    const body = { model: model.providerModelId, n: 1 };
    if (model.argoFrame === 'size') {
      // GPT Image takes pixels in size and needs the ratio spelled out in the prompt.
      const pixels = model.pixelSizes?.[params.aspectRatio]?.[size];
      if (!pixels) throw Object.assign(new Error('This size is not available for this model.'), { statusCode: 400 });
      body.size = pixels;
      body.response_format = 'b64_json';
      if (params.quality) body.quality = params.quality;
      prompt += '\n\nAspect ratio ' + params.aspectRatio + ' composition.';
    } else {
      body.aspect_ratio = params.aspectRatio;
      body.resolution = size;
      body.response_format = 'b64_json';
    }
    body.prompt = prompt;
    // Grok takes {type, image_url: {url}}; GPT Image and Nano Banana take {image_url: "<url>"}.
    if (images.length) body.images = images.map(i => model.providerModelId.startsWith('grok-')
      ? { type: 'image_url', image_url: { url: i.url } } : { image_url: i.url });
    const result = await this.json(images.length ? '/v1/images/edits' : '/v1/images/generations',
      { body, timeoutMs: 600000, maxBytes: 48 * 1024 * 1024 });
    const output = result.data?.[0];
    let data;
    if (output?.b64_json) {
      if (output.b64_json.length > Math.ceil(IMAGE_LIMIT * 4 / 3) + 8) throw new Error('The generated image is too large.');
      data = Buffer.from(output.b64_json, 'base64');
    } else if (output?.url) data = await this.download(output.url, IMAGE_LIMIT);
    if (!data?.length || data.length > IMAGE_LIMIT) throw new Error('The model did not return a usable image.');
    const mimeType = imageMime(data);
    validateCanvas(data, mimeType, params.aspectRatio);
    return { data, mimeType, providerJobId: result.id || null };
  }

  async download(url, maxBytes) {
    const r = await this.fetch(checkOutputUrl(url), { signal: AbortSignal.timeout(90000) });
    if (!r.ok) { await r.body?.cancel?.().catch(() => {}); throw new Error('The generated media could not be downloaded.'); }
    return readBounded(r, maxBytes);
  }

  videoBody(model, params, references = []) {
    const frames = references.filter(r => r.role === 'start_image' || r.role === 'end_image');
    const images = references.filter(r => r.mimeType?.startsWith('image/') && !frames.includes(r));
    const videos = references.filter(r => r.mimeType?.startsWith('video/'));
    if (frames.length && (images.length || videos.length)) throw new Error('Use either frames or reference files in a single video request.');
    const body = { model: model.providerModelId, prompt: String(params.prompt || ''), duration: Number(params.duration),
      resolution: params.resolution, aspect_ratio: params.aspectRatio };
    const start = frames.find(r => r.role === 'start_image'), end = frames.find(r => r.role === 'end_image');
    const grok = model.providerModelId.startsWith('grok-');
    if (start || end) {
      if (!start) throw new Error('Add a start frame before an end frame.');
      if (grok) { body.image = { url: start.url }; if (end) body.last_frame = { url: end.url }; }
      else { body.start_image = { url: start.url }; if (end) body.end_image = { url: end.url }; }
      if (model.adaptiveFrames) body.aspect_ratio = 'adaptive';
    }
    if (images.length) body.reference_images = images.map(r => ({ url: r.url }));
    if (videos.length) body.reference_videos = videos.map(r => ({ url: r.url }));
    if (model.supportsAudio) body.generate_audio = Boolean(params.generateAudio);
    return body;
  }

  // Seedance reads references from ArgoLink's own storage, as the Playground
  // does: ask for an upload ticket, PUT the bytes, then send media_url.
  async uploadMedia(model, { data, mimeType }) {
    const type = String(mimeType || '').split('/')[0];
    if (!['image', 'video', 'audio'].includes(type) || !data?.length) throw new Error('This file cannot be uploaded to ArgoLink.');
    const ticket = await this.json('/v1/media/uploads', { body: { model: model.providerModelId, type, content_type: mimeType, size_bytes: data.length }, timeoutMs: 20000 });
    if (!/^https:\/\//.test(ticket?.upload_url || '') || !/^https:\/\//.test(ticket?.media_url || '')) throw new Error('ArgoLink did not return an upload link.');
    let response;
    try {
      response = await this.fetch(ticket.upload_url, { method: 'PUT', headers: { 'content-type': mimeType }, body: data,
        signal: AbortSignal.timeout(type === 'image' ? 60000 : 300000), redirect: 'error' });
    } catch { throw new Error('The upload to ArgoLink storage could not be completed.'); }
    await response.body?.cancel?.().catch(() => {});
    if (!response.ok) throw new Error('ArgoLink storage rejected the upload (HTTP ' + response.status + ').');
    return ticket.media_url;
  }

  async startVideo(model, params, references = []) {
    const result = await this.json('/v1/videos/generations', { body: this.videoBody(model, params, references), timeoutMs: 120000 });
    if (!result?.request_id) throw new Error('ArgoLink did not return a video job.');
    return String(result.request_id);
  }

  async videoStatus(requestId) {
    return this.json('/v1/videos/' + encodeURIComponent(requestId), { timeoutMs: 20000 });
  }

  async videoContent(requestId) {
    const response = await this.send('/v1/videos/' + encodeURIComponent(requestId) + '/content', { timeoutMs: 180000 });
    if (!response.ok) await this.fail(response);
    const data = await readBounded(response, VIDEO_LIMIT);
    if (!data.length || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('The model did not return a supported MP4 video.');
    return { data, mimeType: 'video/mp4' };
  }
}

module.exports = { ArgoLinkClient, ORIGIN };

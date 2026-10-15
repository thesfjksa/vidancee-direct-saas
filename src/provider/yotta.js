'use strict';

// Yotta Labs AI Gateway video API (docs.yottalabs.ai/products/ai-gateway):
// POST {origin}/{category}/generations with {model, parameters} and the key in
// X-API-KEY → data.request_id; GET {origin}/{category}/generations/{id} until
// data.status is completed (data.output_url), failed or cancelled. Every answer
// is {code, message, data}; code 10000 is success.
const { readBounded, checkOutputUrl, VIDEO_LIMIT } = require('./vercel.js');
const { CATALOG_ORIGIN } = require('../yotta_models.js');

const CATEGORIES = { t2v: 'text-to-video', i2v: 'image-to-video', r2v: 'reference-to-video' };

class YottaClient {
  constructor({ apiKey = '', fetchImpl = fetch } = {}) { this.apiKey = apiKey; this.fetch = fetchImpl; }

  async json(path, { body, timeoutMs = 30000 } = {}) {
    if (!this.apiKey) throw new Error('Save a Yotta API key in Admin first.');
    let response;
    try {
      response = await this.fetch(CATALOG_ORIGIN + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'X-API-KEY': this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Yotta could not be reached. Please try again later.'), { statusCode: 502, retryable: true });
    }
    let parsed = null;
    try { parsed = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')); } catch {}
    const detail = String(parsed?.message || '').slice(0, 300);
    if (!response.ok || !parsed || parsed.code !== 10000) {
      const s = response.status;
      const text = s === 401 || s === 403 || parsed?.code === 10003 ? 'Yotta rejected the API key.' :
        s === 402 ? 'Yotta has insufficient balance.' :
          s === 429 ? 'Yotta rate limit reached. Please try later.' :
            !parsed ? 'Yotta returned an invalid response (HTTP ' + s + ').' :
              'Yotta: ' + (detail || 'request failed (code ' + parsed.code + ')');
      throw Object.assign(new Error(text), { statusCode: 502, providerStatus: s, providerCode: parsed?.code, detail, retryable: s === 429 || s >= 500 || !parsed });
    }
    return parsed.data;
  }

  // The request for one job: a start frame uses the image route; reference
  // images, videos and (Wan 3.0) sound clips the reference route, cited as
  // @Image1, @Video1, @Audio1 in the prompt; otherwise text. On Wan 2.7 a sound
  // file drives a text or start-frame video (audio_url) or voices the first
  // reference video (reference_audio). Prompts are sent as written.
  videoRequest(model, params, references = []) {
    const slugs = model.yotta || {};
    const kind = r => String(r.mimeType || '').split('/')[0];
    const frames = references.filter(r => r.role === 'start_image');
    const images = references.filter(r => kind(r) === 'image' && !frames.includes(r));
    const videos = references.filter(r => kind(r) === 'video');
    const audios = references.filter(r => kind(r) === 'audio');
    const wan3 = slugs.family === 'wan3.0';
    if (frames.length && (images.length || videos.length)) throw new Error('Use either a start frame or reference files in a single video request.');
    const parameters = { prompt: String(params.prompt || ''), resolution: String(params.resolution), duration: Number(params.duration), enhance_prompt: false };
    if (model.supportsAudio) parameters.generate_audio = Boolean(params.generateAudio);
    if (frames.length) {
      if (!slugs.i2v) throw new Error('This model does not take a start frame.');
      if (audios.length && wan3) throw new Error('This model takes sound references with reference images or videos, not with a start frame.');
      parameters.first_frame = frames[0].url;
      if (audios.length) parameters.audio_url = audios[0].url;
      // The video takes the frame's shape where the route has an aspect ratio.
      if (slugs.framesAspectRatio) parameters.aspect_ratio = 'adaptive';
      return { category: CATEGORIES.i2v, body: { model: slugs.i2v, parameters } };
    }
    parameters.aspect_ratio = String(params.aspectRatio);
    if (images.length || videos.length || (wan3 && audios.length)) {
      if (!slugs.r2v) throw new Error('This model does not take reference files.');
      const items = [...images.map(r => ({ url: r.url, type: 'image' })), ...videos.map(r => ({ url: r.url, type: 'video' }))];
      if (wan3) items.push(...audios.map(r => ({ url: r.url, type: 'audio' })));
      else if (audios.length) {
        const first = items.find(item => item.type === 'video');
        if (!first) throw new Error('A sound file can voice a reference video only.');
        first.reference_audio = audios[0].url;
      }
      parameters.reference_items = items;
      return { category: CATEGORIES.r2v, body: { model: slugs.r2v, parameters } };
    }
    if (audios.length) parameters.audio_url = audios[0].url;
    return { category: CATEGORIES.t2v, body: { model: slugs.t2v, parameters } };
  }

  // Returns {requestId, category}; saved so a restart resumes the job.
  async startVideo(model, params, references = []) {
    const { category, body } = this.videoRequest(model, params, references);
    const data = await this.json('/' + category + '/generations', { body, timeoutMs: 120000 });
    if (!data?.request_id) throw new Error('Yotta did not return a video job.');
    return { requestId: String(data.request_id), category };
  }

  // {status: 'done'|'failed'|'pending', url?, error?}
  async videoStatus(op) {
    if (!Object.values(CATEGORIES).includes(op?.category)) throw new Error('The video operation could not be resumed.');
    const data = await this.json('/' + op.category + '/generations/' + encodeURIComponent(op.requestId), { timeoutMs: 20000 });
    const status = String(data?.status || '').toLowerCase();
    if (status === 'completed') return data.output_url ? { status: 'done', url: String(data.output_url) } : { status: 'failed', error: 'No video was returned.' };
    if (status === 'failed' || status === 'cancelled') return { status: 'failed', error: String(data.error_message || data.message || data.error || status).slice(0, 200) };
    return { status: 'pending' };
  }

  async download(url) {
    let response;
    try { response = await this.fetch(checkOutputUrl(url), { signal: AbortSignal.timeout(180000) }); }
    catch { throw Object.assign(new Error('The video could not be downloaded from Yotta.'), { retryable: true }); }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('The video could not be downloaded from Yotta.'), { retryable: true }); }
    const data = await readBounded(response, VIDEO_LIMIT);
    if (!data.length || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Yotta did not return a supported MP4 video.');
    return { data, mimeType: 'video/mp4' };
  }

  // Key check without starting a job: a status read for an unknown request is
  // refused as unauthorized (code 10003) only when the key is wrong.
  async verifyKey() {
    try { await this.json('/text-to-video/generations/00000000-0000-0000-0000-000000000000', { timeoutMs: 10000 }); }
    catch (error) { if (error.providerCode === 10003 || error.providerStatus === 401 || error.providerStatus === 403 || error.retryable) throw error; }
    return true;
  }
}

module.exports = { YottaClient, CATEGORIES };

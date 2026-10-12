'use strict';

// WaveSpeedAI (wavespeed.ai): ByteDance Video Upscaler. Submit a prediction,
// poll /predictions/{id}/result until it is completed, then download outputs[0].
const { readBounded, checkOutputUrl } = require('./vercel.js');
const API = 'https://api.wavespeed.ai/api/v3';
const MODEL_PATH = '/bytedance/video-upscaler';
// 4K output of a long clip is large; chunks are stored 1 MB at a time.
const UPSCALE_LIMIT = 400 * 1024 * 1024;

class WaveSpeedClient {
  constructor({ apiKey = '', fetchImpl = fetch } = {}) { this.apiKey = apiKey; this.fetch = fetchImpl; }

  async json(path, { body, timeoutMs = 30000 } = {}) {
    if (!this.apiKey) throw new Error('Save a WaveSpeed API key in Admin first.');
    let response;
    try {
      response = await this.fetch(API + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: 'Bearer ' + this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('WaveSpeed could not be reached. Please try again later.'), { statusCode: 502, retryable: true });
    }
    let parsed = null;
    try { parsed = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')); } catch {}
    if (!response.ok) {
      const s = response.status, detail = String(parsed?.message || parsed?.error || '').slice(0, 200);
      const text = s === 401 || s === 403 ? 'WaveSpeed rejected the API key.' :
        s === 402 ? 'WaveSpeed has insufficient balance.' :
          s === 429 ? 'WaveSpeed rate limit reached. Please try later.' :
            'WaveSpeed request failed (HTTP ' + s + ')' + (detail ? ': ' + detail : '.');
      throw Object.assign(new Error(text), { statusCode: 502, providerStatus: s, retryable: s === 429 || s >= 500 });
    }
    if (!parsed) throw Object.assign(new Error('WaveSpeed returned an invalid response.'), { statusCode: 502, retryable: true });
    // Responses are wrapped as {code, message, data}.
    return parsed.data ?? parsed;
  }

  async submit(videoUrl, targetResolution) {
    const task = await this.json(MODEL_PATH, { body: { video: videoUrl, target_resolution: targetResolution }, timeoutMs: 60000 });
    if (!task?.id) throw new Error('WaveSpeed did not return a prediction id.');
    return String(task.id);
  }

  // {status: created|processing|completed|failed|cancelled|timeout|deleted, outputs, error}
  async result(id) {
    return this.json('/predictions/' + encodeURIComponent(id) + '/result', { timeoutMs: 20000 });
  }

  async download(url) {
    let response;
    try { response = await this.fetch(checkOutputUrl(url), { signal: AbortSignal.timeout(600000) }); }
    catch { throw Object.assign(new Error('The upscaled video could not be downloaded.'), { retryable: true }); }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('The upscaled video could not be downloaded.'), { retryable: true }); }
    const data = await readBounded(response, UPSCALE_LIMIT);
    if (!data.length || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('The upscaler did not return a supported MP4 video.');
    return { data, mimeType: 'video/mp4' };
  }

  // Wallet balance in USD, or null when not reported.
  async balance() {
    const b = await this.json('/balance', { timeoutMs: 8000 });
    const value = Number(b?.balance ?? b);
    return Number.isFinite(value) ? { remaining: value, unit: 'USD' } : null;
  }
}

module.exports = { WaveSpeedClient, UPSCALE_LIMIT };

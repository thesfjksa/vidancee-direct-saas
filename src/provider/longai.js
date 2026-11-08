'use strict';

const { API_ORIGIN, MODEL_ID } = require('../longai_models.js');
const { fetchPublicMedia } = require('../remote_image.js');
const { isCompleteMp4 } = require('../mp4_trim.js');
const { readBounded, VIDEO_LIMIT } = require('./vercel.js');

const error = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode });
const task = response => response?.data ?? response;
const outputUrl = job => job?.video_url || job?.output?.video_url || job?.output?.url || job?.result?.video_url || job?.result?.url || job?.url;

function pollingPath(value, requestId) {
  if (!value) return '/v1/videos/' + encodeURIComponent(requestId);
  let url;
  try { url = new URL(value, API_ORIGIN); } catch {}
  if (!url || url.origin !== API_ORIGIN || url.username || url.password || url.hash || url.pathname.startsWith('//')) {
    throw error('LONG AI returned an invalid video status URL.');
  }
  return url.pathname + url.search;
}

class LongAiClient {
  constructor({ apiKey = '', fetchImpl = fetch, fetchMedia = fetchPublicMedia } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.fetchMedia = fetchMedia;
  }

  async json(path, body) {
    if (!this.apiKey) throw error('Save a LONG AI API key first.', 400);
    const target = new URL(API_ORIGIN + path);
    if (target.origin !== API_ORIGIN || !path.startsWith('/')) throw error('Invalid LONG AI API path.');
    let response;
    try {
      response = await this.fetch(target.href, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + this.apiKey, accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(body ? 60000 : 15000),
      });
    } catch { throw error('LONG AI could not be reached.'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const message = response.status === 401 || response.status === 403 ? 'LONG AI rejected this API key or its model access.' :
        'LONG AI returned HTTP ' + response.status + '.';
      throw Object.assign(error(message), { providerStatus: response.status });
    }
    try { return { data: JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')), location: response.headers.get('location') }; }
    catch { throw error('LONG AI returned an invalid API response.'); }
  }

  async verifyModel() {
    const { data } = await this.json('/v1/models');
    if (!Array.isArray(data?.data) || !data.data.some(model => model?.id === MODEL_ID)) {
      throw error('The LONG AI key does not list ' + MODEL_ID + '. Check its model permissions.', 400);
    }
  }

  async startVideo(options) {
    const { data, location } = await this.json('/v1/videos', {
      model: MODEL_ID, prompt: options.prompt, duration: options.duration,
      aspect_ratio: options.aspectRatio, resolution: options.resolution,
    });
    const job = task(data);
    const requestId = String(job?.id ?? job?.task_id ?? job?.job_id ?? '');
    if (!/^[\w-]{1,191}$/.test(requestId)) throw error('LONG AI did not return a video task ID.');
    const path = pollingPath(job.status_url || job.poll_url || data.status_url || data.poll_url || location, requestId);
    return { requestId, path };
  }

  async videoStatus(op) {
    const { data } = await this.json(pollingPath(op.path, op.requestId));
    const job = task(data);
    const status = String(job?.status || '').toLowerCase();
    if (['failed', 'failure', 'error', 'canceled', 'cancelled', 'expired'].includes(status)) return { status: 'failed' };
    const url = outputUrl(job);
    if (typeof url === 'string' && ['completed', 'succeeded', 'success', 'done'].includes(status)) {
      return { status: 'done', url: new URL(url, API_ORIGIN).href };
    }
    return { status: 'pending' };
  }

  async download(url) {
    const data = await this.fetchMedia(url, { accept: 'video/mp4', maxBytes: VIDEO_LIMIT, timeoutMs: 90000 });
    if (!isCompleteMp4(data)) throw error('LONG AI did not return an MP4 video.');
    return { data, mimeType: 'video/mp4' };
  }
}

module.exports = { LongAiClient };

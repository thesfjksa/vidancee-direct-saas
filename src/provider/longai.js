'use strict';

const https = require('node:https');
const { Readable } = require('node:stream');
const { API_ORIGIN, MODEL_ID } = require('../longai_models.js');
const { fetchPublicMedia } = require('../remote_image.js');
const { isCompleteMp4 } = require('../mp4_trim.js');
const { readBounded, VIDEO_LIMIT } = require('./vercel.js');

const error = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode });
const task = response => response?.data ?? response;
const outputUrl = job => job?.video_url || job?.output?.video_url || job?.output?.url || job?.result?.video_url || job?.result?.url || job?.url;

const READ_TIMEOUT_MS = 28000;
const SUBMIT_TIMEOUT_MS = 60000;
const ERROR_BODY_LIMIT = 4096;

// Use a single explicit deadline that includes connecting and reading. The
// default fetch transport can abort the connection separately at ~10 s.
function longAiHttps(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, signal }, incoming => {
      const status = incoming.statusCode;
      const hasBody = ![204, 205, 304].includes(status);
      if (!hasBody) incoming.resume();
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(incoming.headers),
        body: hasBody ? Readable.toWeb(incoming) : null,
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}

function defaultTransport() {
  // Retain Node's existing fetch behavior on deployments with an explicit proxy.
  const usesProxy = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
  return usesProxy && (process.env.HTTPS_PROXY || process.env.https_proxy) ? fetch : longAiHttps;
}

function networkError(cause, method, timeoutMs) {
  const codes = [cause?.cause?.code, cause?.code, cause?.name];
  const networkCode = codes.find(code => typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(code)) || 'UNKNOWN';
  const timedOut = ['ABORT_ERR', 'AbortError', 'TimeoutError', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(networkCode);
  const message = timedOut ? 'LONG AI connection timed out from the CMMTools server.' :
    'CMMTools could not connect to LONG AI (' + networkCode + ').';
  return Object.assign(error(message), { networkCode, requestMethod: method, timeoutMs });
}

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
  constructor({ apiKey = '', fetchImpl = defaultTransport(), fetchMedia = fetchPublicMedia } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.fetchMedia = fetchMedia;
  }

  async json(path, body, timeoutMs = body ? SUBMIT_TIMEOUT_MS : READ_TIMEOUT_MS) {
    if (!this.apiKey) throw error('Save a LONG AI API key first.', 400);
    const target = new URL(API_ORIGIN + path);
    if (target.origin !== API_ORIGIN || !path.startsWith('/')) throw error('Invalid LONG AI API path.');
    const response = await this.request(target.href, body, this.apiKey, { timeoutMs });
    if (!response.ok) {
      let code;
      if (response.status === 503 && response.headers.get('content-type')?.includes('application/json')) {
        // Classify known provider errors without logging or displaying their raw bodies.
        try {
          const data = JSON.parse((await readBounded(response, ERROR_BODY_LIMIT)).toString('utf8'));
          const detail = data?.error?.message ?? data?.message;
          if (typeof detail === 'string' && /no upstream provider serves it|no available OpenAI accounts supporting model/i.test(detail)) {
            code = 'LONG_AI_NO_UPSTREAM';
          }
        } catch {}
      }
      await response.body?.cancel().catch(() => {});
      const message = response.status === 401 || response.status === 403 ? 'LONG AI rejected this API key or its model access.' :
        'LONG AI returned HTTP ' + response.status + '.';
      const requestId = response.headers.get('x-request-id') || '';
      const providerRequestId = /^[a-z\d][a-z\d._-]{0,95}$/i.test(requestId) && !/^sk[-_]/i.test(requestId) ? requestId : undefined;
      throw Object.assign(error(message), {
        providerStatus: response.status, providerRequestId, code, requestMethod: body ? 'POST' : 'GET',
      });
    }
    try { return { data: JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')), location: response.headers.get('location') }; }
    catch (cause) {
      if (cause?.name === 'AbortError' || cause?.name === 'TimeoutError' || cause?.code === 'ABORT_ERR') {
        throw networkError(cause, body ? 'POST' : 'GET', timeoutMs);
      }
      throw error('LONG AI returned an invalid API response.');
    }
  }

  async request(url, body, key, {
    timeoutMs = body ? SUBMIT_TIMEOUT_MS : READ_TIMEOUT_MS,
    accept = 'application/json',
  } = {}) {
    const method = body ? 'POST' : 'GET';
    try {
      return await this.fetch(url, {
        method,
        headers: { accept, ...(key ? { authorization: 'Bearer ' + key } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw networkError(cause, method, timeoutMs);
    }
  }

  async checkReachability() {
    const start = Date.now();
    const response = await this.request(API_ORIGIN + '/v1/models');
    await response.body?.cancel().catch(() => {});
    return { providerStatus: response.status, elapsedMs: Date.now() - start };
  }

  async verifyModel(modelId = MODEL_ID, timeoutMs = READ_TIMEOUT_MS) {
    const { data } = await this.json('/v1/models/' + encodeURIComponent(modelId), undefined, timeoutMs);
    if (data?.id !== modelId) {
      throw error('The LONG AI key does not confirm access to ' + modelId + '. Check its model permissions.', 400);
    }
  }

  async videoMarketplace() {
    const response = await this.request(API_ORIGIN + '/model-plaza', undefined, undefined, {
      timeoutMs: 8000, accept: 'text/html',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw error('LONG AI marketplace returned HTTP ' + response.status + '.');
    }
    return (await readBounded(response, 1024 * 1024)).toString('utf8');
  }

  async startVideo(options, modelId = MODEL_ID) {
    const { data, location } = await this.json('/v1/videos', {
      model: modelId, prompt: options.prompt, duration: options.duration,
      aspect_ratio: options.aspectRatio, resolution: options.resolution,
    });
    const job = task(data);
    const requestId = String(job?.id ?? job?.task_id ?? job?.job_id ?? '');
    if (!/^[\w-]{1,191}$/.test(requestId)) throw error('LONG AI did not return a video task ID.');
    const path = pollingPath(job.status_url || job.poll_url || data.status_url || data.poll_url || location, requestId);
    return { requestId, path };
  }

  async videoStatus(op, { reportMissingOutput = false } = {}) {
    const { data } = await this.json(pollingPath(op.path, op.requestId));
    const job = task(data);
    const status = String(job?.status || '').toLowerCase();
    if (['failed', 'failure', 'error', 'canceled', 'cancelled', 'expired'].includes(status)) return { status: 'failed' };
    const url = outputUrl(job);
    if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
      if (typeof url === 'string') return { status: 'done', url: new URL(url, API_ORIGIN).href };
      if (reportMissingOutput) return { status: 'missing_output' };
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

'use strict';

const { ORIGIN } = require('../wxksai_models.js');
const { readBounded, VIDEO_LIMIT } = require('./vercel.js');
const { fetchPublicMedia } = require('../remote_image.js');
const { isCompleteMp4 } = require('../mp4_trim.js');

function safeId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9_-]{1,191}$/.test(id)) throw new Error('WXKSAI did not provide a valid task ID.');
  return id;
}
function providerError(status) {
  const error = new Error(status === 401 || status === 403
    ? 'WXKSAI rejected the saved API key or model access.'
    : 'WXKSAI returned HTTP ' + status + '.');
  error.providerStatus = status;
  error.statusCode = 502;
  return error;
}

class WxksaiClient {
  constructor({ apiKey = '', fetchImpl = fetch, fetchMedia = fetchPublicMedia } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.fetch = fetchImpl;
    this.fetchMedia = fetchMedia;
  }
  async request(path, { method = 'GET', body, timeoutMs = 40000 } = {}) {
    if (!this.apiKey) throw Object.assign(new Error('Configure the WXKSAI API key in Admin.'), { statusCode: 400 });
    if (!/^\/v1\/(?:models|videos(?:\/[a-zA-Z0-9_-]+(?:\/content)?)?)$/.test(path))
      throw new Error('Invalid WXKSAI request path.');
    let response;
    try {
      response = await this.fetch(ORIGIN + path, {
        method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: 'Bearer ' + this.apiKey,
          accept: method === 'GET' && path.endsWith('/content') ? 'video/mp4' : 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      const error = new Error('WXKSAI request failed or timed out. Check task history before retrying a paid submission.');
      error.statusCode = 502;
      error.code = cause?.name === 'TimeoutError' || cause?.name === 'AbortError' ? 'WXKSAI_TIMEOUT' : 'WXKSAI_CONNECTION';
      throw error;
    }
    if (response.status >= 300 && response.status < 400 && !path.endsWith('/content')) {
      await response.body?.cancel?.().catch(()=>{});
      throw new Error('WXKSAI unexpectedly redirected an API request.');
    }
    if (response.status < 300 && !response.ok) {
      await response.body?.cancel?.().catch(()=>{});
      throw providerError(response.status);
    }
    return response;
  }
  async json(path, body, timeoutMs) {
    const response = await this.request(path,{method:body?'POST':'GET',body,timeoutMs:timeoutMs||(body?75000:40000)});
    if (!response.ok) { await response.body?.cancel?.().catch(()=>{}); throw providerError(response.status); }
    try {
      return JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8'));
    } catch {
      throw new Error('WXKSAI returned invalid or oversized JSON.');
    }
  }
  async models() {
    const body = await this.json('/v1/models');
    if (!Array.isArray(body?.data) || !body.data.length) throw new Error('WXKSAI returned an empty model list; the previous catalog was preserved.');
    return body;
  }
  async startVideo(options) {
    const modelId = options?.model?.providerModelId;
    if (!modelId || !options?.prompt) throw new Error('WXKSAI needs a supported model and prompt.');
    // Exactly ONE paid POST: failure or timeout is ambiguous and must never auto-retry.
    const result = await this.json('/v1/videos', {
      model: modelId, prompt: options.prompt, seconds: String(options.duration),
      resolution: options.resolution, aspect_ratio: options.aspectRatio,
    }, 75000);
    const task = result?.data && typeof result.data === 'object' ? result.data : result;
    return { requestId: safeId(task?.id ?? task?.task_id) };
  }
  async videoStatus(operation) {
    const id = safeId(operation?.requestId);
    const data = await this.json('/v1/videos/' + id);
    const task = data?.data && typeof data.data === 'object' ? data.data : data;
    const status = String(task?.status || '').toLowerCase();
    if (status === 'completed') return { status: 'done', requestId: id };
    if (status === 'failed') return { status: 'failed', requestId: id };
    return { status: 'pending', requestId: id };
  }
  async download(operation) {
    const id = safeId(operation?.requestId);
    const response = await this.request('/v1/videos/' + id + '/content', { timeoutMs: 90000 });
    let bytes;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel?.().catch(()=>{});
      if (!location) throw new Error('WXKSAI did not provide the completed video URL.');
      const target = new URL(location, ORIGIN);
      if (target.origin === ORIGIN) {
        // Never follow arbitrary provider redirects with a Bearer token.
        throw new Error('WXKSAI returned an unsupported authenticated media redirect.');
      }
      if (target.protocol !== 'https:' || target.username || target.password)
        throw new Error('WXKSAI returned an unsafe media download link.');
      bytes = await this.fetchMedia(target.href,{accept:'video/mp4',maxBytes:VIDEO_LIMIT,timeoutMs:90000});
    } else {
      if (!response.ok) throw providerError(response.status);
      bytes = await readBounded(response, VIDEO_LIMIT);
    }
    if (!isCompleteMp4(bytes)) throw new Error('WXKSAI output did not contain a complete MP4.');
    return { data: bytes, mimeType: 'video/mp4' };
  }
}
module.exports = { WxksaiClient };

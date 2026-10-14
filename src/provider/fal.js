'use strict';

// fal.ai queue API: POST https://queue.fal.run/{model} returns a request id and
// the status/response URLs to poll. A failed request still reports COMPLETED,
// with an `error` field.
const { readBounded, checkOutputUrl } = require('./vercel.js');
const QUEUE = 'https://queue.fal.run/';
// 4K output of a long clip is large; it is stored 1 MB at a time.
const UPSCALE_LIMIT = 400 * 1024 * 1024;

function queueUrl(value) {
  const url = String(value || '');
  if (!url.startsWith(QUEUE)) throw new Error('fal returned an unexpected queue address.');
  return url;
}

class FalClient {
  constructor({ apiKey = '', fetchImpl = fetch } = {}) { this.apiKey = apiKey; this.fetch = fetchImpl; }

  async json(url, { body, timeoutMs = 30000 } = {}) {
    if (!this.apiKey) throw new Error('Save a fal.ai API key in Admin first.');
    let response;
    try {
      response = await this.fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: 'Key ' + this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('fal.ai could not be reached. Please try again later.'), { statusCode: 502, retryable: true });
    }
    let parsed = null;
    try { parsed = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')); } catch {}
    if (!response.ok) {
      const s = response.status;
      const raw = parsed?.detail ?? parsed?.error ?? parsed?.message ?? '';
      const detail = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(d => d?.msg || '').join('; ') : '').slice(0, 200);
      const text = s === 401 || s === 403 ? 'fal.ai rejected the API key.' :
        s === 402 ? 'fal.ai has insufficient balance.' :
          s === 429 ? 'fal.ai rate limit reached. Please try later.' :
            'fal.ai request failed (HTTP ' + s + ')' + (detail ? ': ' + detail : '.');
      throw Object.assign(new Error(text), { statusCode: 502, providerStatus: s, detail, retryable: s === 429 || s >= 500 });
    }
    if (!parsed) throw Object.assign(new Error('fal.ai returned an invalid response.'), { statusCode: 502, retryable: true });
    return parsed;
  }

  // Returns {requestId, statusUrl, responseUrl}; saved so a restart resumes the job.
  async submit(modelPath, input) {
    const r = await this.json(QUEUE + modelPath, { body: input, timeoutMs: 60000 });
    if (!r?.request_id) throw new Error('fal.ai did not return a request id.');
    return { requestId: String(r.request_id), statusUrl: queueUrl(r.status_url), responseUrl: queueUrl(r.response_url) };
  }

  // {status: IN_QUEUE|IN_PROGRESS|COMPLETED, error?}
  async status(op) { return this.json(queueUrl(op.statusUrl), { timeoutMs: 20000 }); }

  async result(op) { return this.json(queueUrl(op.responseUrl), { timeoutMs: 30000 }); }

  // Key check without starting a job: a status lookup for an unknown request
  // answers 401 for a bad key and 404 (or similar) for a good one.
  async verifyKey() {
    try { await this.json(QUEUE + 'fal-ai/bytedance-upscaler/requests/00000000-0000-0000-0000-000000000000/status', { timeoutMs: 10000 }); }
    catch (error) { if (error.providerStatus === 401 || error.providerStatus === 403 || !error.providerStatus) throw error; }
    return true;
  }

  // One poll: {state:'pending'}, {state:'done', url} or {state:'failed', error}.
  async check(op) {
    const st = await this.status(op);
    if (st?.status !== 'COMPLETED') return { state: 'pending' };
    if (st.error) return { state: 'failed', error: String(st.error).slice(0, 200) };
    let r;
    try { r = await this.result(op); }
    catch (error) {
      const s = Number(error.providerStatus);
      if (s >= 400 && s < 500 && s !== 429) return { state: 'failed', error: String(error.detail || error.message).slice(0, 200) };
      throw error;
    }
    const url = r?.video?.url;
    return url ? { state: 'done', url } : { state: 'failed', error: 'No video was returned.' };
  }

  async download(url) {
    let response;
    try { response = await this.fetch(checkOutputUrl(url), { signal: AbortSignal.timeout(600000) }); }
    catch { throw Object.assign(new Error('The video could not be downloaded from fal.ai.'), { retryable: true }); }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('The video could not be downloaded from fal.ai.'), { retryable: true }); }
    const data = await readBounded(response, UPSCALE_LIMIT);
    if (!data.length || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('fal.ai did not return a supported MP4 video.');
    return { data, mimeType: 'video/mp4' };
  }
}

module.exports = { FalClient, UPSCALE_LIMIT };

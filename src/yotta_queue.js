'use strict';

// Yotta Labs video jobs (Wan 3.0, Wan 2.7). They use the ArgoLink queue's
// claim, heartbeat, restart recovery, refunds and HD enhancement: a 720p or
// 1080p job is rendered lower by Yotta, stored, upscaled by fal.ai and the
// upscale replaces it (see argo_hd.js → yottaPlan). Only the API calls differ.
const { ArgoLinkQueue } = require('./argolink_queue.js');
const { savedOptions } = require('./vercel_queue.js');
const { YottaClient } = require('./provider/yotta.js');

class YottaQueue extends ArgoLinkQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new YottaClient(opts), ...options, provider: 'yotta' });
  }
  apiKey(s) { return s.yottaApiKey || ''; }
  sourceEnabled(s) { return Boolean(s.yottaEnabled); }
  maxInflight(s) { return s.yottaMaxInflight || 3; }

  async submit(db, job, client) {
    const options = savedOptions(job), model = await this.getModel('yotta', job.model, job.media_type);
    if (!model?.ready) throw new Error('This model is currently unavailable. Credits were refunded.');
    // Rendered at the source resolution when HD enhancement follows.
    const params = { ...options, resolution: options.sourceResolution || options.resolution };
    const references = await this.references(db, job);
    let request = null;
    try { request = client.videoRequest?.(model, params, references); } catch {}
    this.log(job, 'yotta.request', 'POST /' + (request?.category || '?') + '/generations · ' + (request?.body?.model || model.providerModelId) + ' · ' + params.resolution,
      { body: request?.body, references: references.map(r => ({ role: r.role, mimeType: r.mimeType })) });
    const op = await client.startVideo(model, params, references);
    this.log(job, 'yotta.accepted', 'Yotta request ' + op.requestId, op);
    // Saved before the first poll, so a restart resumes this job instead of paying again.
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify(op), op.requestId.slice(0, 191), job.id]);
  }

  async pollJob(db, client, job) {
    let op = {};
    try { op = JSON.parse(job.provider_operation || '{}') || {}; } catch {}
    if (op.stage === 'enhance') return this.pollEnhancement(db, job, op);
    if (!op.requestId) throw new Error('The video operation could not be resumed.');
    const result = await client.videoStatus(op);
    if (result.status === 'pending') return this.markProcessing(db, job);
    this.log(job, 'yotta.status', op.requestId + ' → ' + result.status, result, result.status === 'failed' ? 'error' : 'info');
    if (result.status === 'failed') {
      const reason = String(result.error || '').trim().replace(/[.!]?$/, '.');
      return this.refund(job.id, 'failed', 'The video model could not complete this request' + (reason.length > 1 ? ': ' + reason : '.') + ' Credits were refunded.', null);
    }
    const output = await client.download(result.url);
    if (savedOptions(job).enhance?.upscale) await this.startEnhancement(db, job, output, op.requestId);
    else await this.complete(db, job, output);
  }
}

module.exports = { YottaQueue };

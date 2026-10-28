'use strict';

// CreatePulse video jobs (Omni Flash in Video Studio). They use the ArgoLink
// queue's claim, heartbeat, restart recovery and refunds; only the API calls
// differ. CreatePulse fetches reference images from the app's signed links.
// Customers never read CreatePulse's own errors: known reasons (safety, busy)
// get a plain sentence, anything else "Model under maintenance"; the activity
// log keeps the raw text.
const { ArgoLinkQueue } = require('./argolink_queue.js');
const { savedOptions } = require('./vercel_queue.js');
const { CreatePulseClient } = require('./provider/createpulse.js');
const { failureMessage } = require('./provider_errors.js');

class CreatePulseQueue extends ArgoLinkQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new CreatePulseClient(opts), ...options, provider: 'createpulse' });
    // CreatePulse says videos are usually ready in 15 to 40 minutes.
    this.videoTimeoutMs = 3 * 60 * 60 * 1000;
  }
  apiKey(s) { return s.createPulseApiKey || ''; }
  sourceEnabled(s) { return Boolean(s.createPulseEnabled); }
  // CreatePulse runs 3 jobs at a time per account (10 for VIP accounts).
  maxInflight(s) { return s.createPulseMaxInflight || 3; }
  submitFailureMessage(error) { return failureMessage('video', error?.message); }

  async submit(db, job, client) {
    const options = savedOptions(job), model = await this.getModel('createpulse', job.model, job.media_type);
    if (!model?.ready) throw new Error('This model is currently unavailable. Credits were refunded.');
    const references = await this.references(db, job);
    let body = null;
    try { body = client.videoRequest?.(model, options, references); } catch {}
    this.log(job, 'createpulse.request', 'POST /api/generate · ' + (body?.model || model.providerModelId) + ' · ' + options.duration + ' s · ' + options.aspectRatio,
      { body: body && { ...body, prompt: String(body.prompt).slice(0, 4000) } });
    const op = await client.startVideo(model, options, references);
    this.log(job, 'createpulse.accepted', 'CreatePulse batch ' + op.requestId, op);
    // Saved before the first poll, so a restart resumes this job instead of paying again.
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify(op), op.requestId.slice(0, 191), job.id]);
  }

  async pollJob(db, client, job) {
    let op = {};
    try { op = JSON.parse(job.provider_operation || '{}') || {}; } catch {}
    if (!op.requestId) throw new Error('The video operation could not be resumed.');
    const result = await client.videoStatus(op);
    if (result.status === 'pending') return this.markProcessing(db, job);
    this.log(job, 'createpulse.status', op.requestId + ' → ' + result.status, result, result.status === 'failed' ? 'error' : 'info');
    if (result.status === 'failed') return this.refund(job.id, 'failed', failureMessage('video', result.error), null);
    await this.complete(db, job, await client.download(result.url));
  }
}

module.exports = { CreatePulseQueue };

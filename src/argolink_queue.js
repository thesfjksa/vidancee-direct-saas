'use strict';

// ArgoLink jobs run through the same claim, heartbeat, recovery and refund
// logic as the AI Gateway queue; only the API calls differ.
const { VercelQueue, savedOptions } = require('./vercel_queue.js');
const { ArgoLinkClient } = require('./provider/argolink.js');

class ArgoLinkQueue extends VercelQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new ArgoLinkClient(opts), ...options, provider: 'argolink' });
    // ArgoLink queues a job for up to 10 minutes and long Seedance clips can
    // take a while; a refunded job that later finishes would still be billed.
    this.videoTimeoutMs = 3 * 60 * 60 * 1000;
  }
  apiKey(s) { return s.argoLinkApiKey || ''; }
  sourceEnabled(s) { return Boolean(s.argoLinkEnabled); }
  maxInflight(s) { return s.argoLinkMaxInflight || 3; }

  async submit(db, job, client) {
    const options = savedOptions(job), model = await this.getModel('argolink', job.model, job.media_type);
    if (!model?.ready) throw new Error('This model is currently unavailable. Credits were refunded.');
    const references = await this.references(db, job);
    if (job.media_type === 'image') {
      await this.complete(db, job, await client.generateImage(model, options, references));
      return;
    }
    const requestId = await client.startVideo(model, options, references);
    // The request id is saved before the first poll, so a restart resumes the
    // same job instead of paying for a second one.
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify({ requestId }), requestId.slice(0, 191), job.id]);
  }

  async pollJob(db, client, job) {
    let requestId = job.provider_job_id;
    try { requestId = JSON.parse(job.provider_operation || '{}').requestId || requestId; } catch {}
    if (!requestId) throw new Error('The video operation could not be resumed.');
    const result = await client.videoStatus(requestId);
    if (result.status === 'done') {
      await this.complete(db, job, await client.videoContent(requestId));
    } else if (result.status === 'failed' || result.status === 'expired') {
      const reason = String(result.error?.message || '').slice(0, 200);
      await this.refund(job.id, 'failed', (reason ? 'The video model could not complete this request: ' + reason : 'The video model could not complete this request.') + ' Credits were refunded.', null);
    } else if (result.status === 'pending') await this.markProcessing(db, job);
    else throw Object.assign(new Error('The video status was temporarily unavailable.'), { retryable: true });
  }
}

module.exports = { ArgoLinkQueue };

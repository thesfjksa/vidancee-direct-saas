'use strict';

const { VercelQueue, savedOptions } = require('./vercel_queue.js');
const { LongAiClient } = require('./provider/longai.js');

class LongAiQueue extends VercelQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new LongAiClient(opts), ...options, provider: 'longai' });
    this.videoTimeoutMs = 3 * 60 * 60 * 1000;
  }

  apiKey(settings) { return settings.longAiApiKey; }
  sourceEnabled(settings) { return settings.longAiEnabled; }
  maxInflight() { return 1; }

  async submit(db, job, client) {
    const op = await client.startVideo(savedOptions(job));
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify(op), op.requestId, job.id]);
    this.log(job, 'longai.accepted', 'LONG AI accepted the video task.', { requestId: op.requestId });
  }

  async pollJob(db, client, job) {
    const op = JSON.parse(job.provider_operation || 'null');
    if (!op?.requestId) throw new Error('The LONG AI video task could not be resumed.');
    const result = await client.videoStatus(op);
    if (result.status === 'failed') {
      return this.refund(job.id, 'failed', 'The video service could not complete this request. Credits were refunded.', null);
    }
    if (result.status === 'done') return this.complete(db, job, await client.download(result.url));
    await this.markProcessing(db, job);
  }
}

module.exports = { LongAiQueue };

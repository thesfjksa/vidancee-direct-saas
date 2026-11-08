'use strict';

const { VercelQueue, savedOptions } = require('./vercel_queue.js');
const { WxksaiClient } = require('./provider/wxksai.js');

class WxksaiQueue extends VercelQueue {
  constructor(options = {}) {
    super({ ...options, provider: 'wxksai',
      clientFactory: options.clientFactory || (opts => new WxksaiClient(opts)) });
    this.videoTimeoutMs = 24 * 60 * 60 * 1000;
    this.lastProviderPollAt = 0;
  }
  queuedSql() { return super.queuedSql().replace('COALESCE(a.enabled,1)=1','COALESCE(a.enabled,0)=1'); }
  apiKey(settings) { return settings.wxksaiApiKey; }
  sourceEnabled(settings) { return settings.wxksaiEnabled; }
  maxInflight(settings) { return settings.wxksaiMaxInflight || 2; }
  async pollVideos(db, client) {
    // WXKSAI asks callers to poll no more often than once every 30 seconds.
    if (Date.now() - this.lastProviderPollAt < 31000) return;
    this.lastProviderPollAt = Date.now();
    return super.pollVideos(db, client);
  }
  async submit(db, job, client) {
    const options = savedOptions(job);
    const model = await this.getModel('wxksai',job.model,'video');
    if (!model?.ready) throw new Error('This WXKSAI model is unavailable.');
    const refs = await this.references(db, job);
    if (refs.length) throw new Error('WXKSAI reference-media upload is not enabled for this model.');
    const operation = await client.startVideo(options);
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify(operation),operation.requestId,job.id]);
    this.log(job,'wxksai.accepted','WXKSAI accepted the video task.',{requestId:operation.requestId});
  }
  async pollJob(db, client, job) {
    const operation = JSON.parse(job.provider_operation || 'null');
    if (!operation?.requestId) throw new Error('The WXKSAI task ID was not saved.');
    const result = await client.videoStatus(operation);
    if (result.status === 'failed')
      return this.refund(job.id,'failed','The video service failed. CMMTools credits were refunded.',null);
    if (result.status === 'done') return this.complete(db,job,await client.download(operation));
    await this.markProcessing(db,job);
  }
}

module.exports = { WxksaiQueue };

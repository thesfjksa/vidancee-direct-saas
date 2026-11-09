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
  submitFailureMessage(error) {
    // A gateway 5xx/timeout can occur after the paid POST reached WXKSAI.
    // The provider task ID was not returned; do not suggest an automatic retry.
    if (Number(error?.providerStatus) >= 500 && Number(error?.providerStatus) < 600)
      return 'WXKSAI returned HTTP ' + error.providerStatus + ' during submission. Task creation is unconfirmed. CMMTools credits were refunded; check WXKSAI task history before retrying.';
    if (['WXKSAI_TIMEOUT', 'WXKSAI_CONNECTION'].includes(error?.code))
      return 'WXKSAI did not confirm the video submission (network failure or timeout). CMMTools credits were refunded; check WXKSAI task history before retrying.';
    return super.submitFailureMessage(error);
  }
  apiKey(settings) { return settings.wxksaiApiKey; }
  sourceEnabled(settings) { return settings.wxksaiEnabled; }
  maxInflight(settings) { return settings.wxksaiMaxInflight || 2; }
  async pollVideos(db, client) {
    // WXKSAI asks callers to poll no more often than once every 30 seconds.
    if (Date.now() - this.lastProviderPollAt < 31000) return;
    this.lastProviderPollAt = Date.now();
    return super.pollVideos(db, client);
  }
  async referenceFiles(db,job) {
    const [rows]=await db.execute(
      'SELECT position_index,media_kind,media_role,filename,mime_type,media_data FROM generation_media WHERE generation_id=? ORDER BY position_index',
      [job.id]);
    if(!rows.length)return [];
    // Uploaded references can be stored in R2. Hydrate the bytes to send
    // multipart files; NEVER expose signed reference URLs or API keys to WXKSAI.
    await require('./object_storage.js').hydrateBlobs(rows,'media_data');
    return rows.map(row=>({
      kind:row.media_kind,role:row.media_role,filename:row.filename,
      mimeType:row.mime_type,data:row.media_data,
    }));
  }
  async submit(db, job, client) {
    const options = savedOptions(job);
    const model = await this.getModel('wxksai',job.model,'video');
    if (model?.wxksai?.submissionPaused) {
      throw new Error('This Dope model is temporarily paused. CMMTools credits were refunded.');
    }
    if (!model?.ready) throw new Error('This WXKSAI model is unavailable.');
    const refs = await this.referenceFiles(db,job);
    const operation = await client.startVideo(options,refs);
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
    if (result.status === 'done') {
      const output = await client.download(operation);
      try { return await this.complete(db, job, output); }
      finally { await output.cleanup(); }
    }
    await this.markProcessing(db,job);
  }
}

module.exports = { WxksaiQueue };

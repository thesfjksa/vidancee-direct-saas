'use strict';

// Sluice video jobs (Seedance Lite in Video Studio and Cartoon Studio). They
// use the ArgoLink queue's claim, heartbeat, restart recovery and refunds;
// only the API calls differ. Reference images are sent inline, so Sluice never
// has to fetch them from the app's signed links. Cartoon jobs get their style
// direction added to the prompt (cartoon.js providerPrompt).
const { ArgoLinkQueue } = require('./argolink_queue.js');
const { savedOptions } = require('./vercel_queue.js');
const { SluiceClient } = require('./provider/sluice.js');
const { providerPrompt } = require('./cartoon.js');

class SluiceQueue extends ArgoLinkQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new SluiceClient(opts), ...options, provider: 'sluice' });
  }
  apiKey(s) { return s.sluiceApiKey || ''; }
  sourceEnabled(s) { return Boolean(s.sluiceEnabled); }
  // Sluice allows 3 jobs in flight per key.
  maxInflight(s) { return s.sluiceMaxInflight || 3; }

  // The job's reference files with their bytes, in the order they were listed.
  async filesFor(db, job, references) {
    if (!references.length) return references;
    const [rows] = await db.execute('SELECT position_index,mime_type,media_data FROM generation_media WHERE generation_id=? ORDER BY position_index', [job.id]);
    if (!Array.isArray(rows) || rows.length !== references.length) return references;
    return references.map((r, i) => ({ ...r, data: rows[i].media_data }));
  }

  async submit(db, job, client) {
    const options = savedOptions(job), model = await this.getModel('sluice', job.model, job.media_type);
    if (!model?.ready) throw new Error('This model is currently unavailable. Credits were refunded.');
    const params = { ...options, prompt: providerPrompt(job) };
    const references = await this.filesFor(db, job, await this.references(db, job));
    let body = null;
    try { body = client.videoRequest?.(model, params, references); } catch {}
    // The log keeps the request without the inline image data.
    const shown = body && { ...body, prompt: String(body.prompt).slice(0, 4000),
      ...(body.references ? { references: body.references.map(r => (r.data_uri ? { data_uri: r.data_uri.slice(0, 32) + '…' } : r)) } : {}),
      ...(body.first_frame?.data_uri ? { first_frame: { data_uri: '…' } } : {}), ...(body.last_frame?.data_uri ? { last_frame: { data_uri: '…' } } : {}) };
    this.log(job, 'sluice.request', 'POST /v1/videos/generations · ' + (body?.model || model.providerModelId) + ' · ' + params.resolution + ' · ' + params.duration + ' s', { body: shown });
    const op = await client.startVideo(model, params, references, 'cmm-' + job.id);
    this.log(job, 'sluice.accepted', 'Sluice job ' + op.requestId, op);
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
    this.log(job, 'sluice.status', op.requestId + ' → ' + result.status, result, result.status === 'failed' ? 'error' : 'info');
    if (result.status === 'failed') {
      const reason = String(result.error || '').trim().replace(/[.!]?$/, '.');
      return this.refund(job.id, 'failed', 'The video model could not complete this request' + (reason.length > 1 ? ': ' + reason : '.') + ' Credits were refunded.', null);
    }
    await this.complete(db, job, await client.download(result.url));
  }
}

module.exports = { SluiceQueue };

'use strict';

// Higgsfield API video jobs (Wan 3.0). They use the ArgoLink queue's claim,
// heartbeat, restart recovery, refunds and HD enhancement: a 720p or 1080p job
// is rendered lower by Higgsfield, stored, upscaled by fal.ai and the upscale
// replaces it (see argo_hd.js → wanPlan). Only the API calls differ.
const { ArgoLinkQueue } = require('./argolink_queue.js');
const { savedOptions } = require('./vercel_queue.js');
const { HiggsfieldClient, UPLOAD_TYPES } = require('./provider/higgsfield.js');
const { errorDetails } = require('./activity_log.js');
const { mp4Seconds } = require('./vercel_models.js');

class HiggsfieldQueue extends ArgoLinkQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new HiggsfieldClient(opts), ...options, provider: 'higgsfield' });
  }
  apiKey(s) { return s.higgsfieldApiKey || ''; }
  sourceEnabled(s) { return Boolean(s.higgsfieldEnabled); }
  maxInflight(s) { return s.higgsfieldMaxInflight || 3; }

  // Reference files go to Higgsfield's own storage, so Higgsfield does not have
  // to fetch them from the app's signed links. A file type its storage does not
  // take (MP3, MOV), or a failed upload, keeps the signed link.
  async stageReferences(db, job, client, references) {
    if (!references.length || typeof client.upload !== 'function') return references;
    let rows = [];
    try { [rows] = await db.execute('SELECT position_index,mime_type,media_data FROM generation_media WHERE generation_id=? ORDER BY position_index', [job.id]); }
    catch { return references; }
    if (!Array.isArray(rows) || rows.length !== references.length) return references;
    const out = [];
    let uploaded = 0;
    for (const [i, original] of references.entries()) {
      const row = rows[i];
      // Reference video lengths go in the request log entry.
      const seconds = String(row.mime_type || '').startsWith('video/') ? mp4Seconds(row.media_data) : null;
      const ref = seconds == null ? original : { ...original, seconds: Math.round(seconds * 10) / 10 };
      if (!UPLOAD_TYPES.includes(String(row.mime_type || '').toLowerCase())) { out.push(ref); continue; }
      try { out.push({ ...ref, url: await client.upload({ data: row.media_data, mimeType: row.mime_type }) }); uploaded++; }
      catch (error) {
        this.log(job, 'higgsfield.upload_failed', 'Upload to Higgsfield storage failed; sending the signed link instead: ' + error.message, errorDetails(error), 'warn');
        out.push(ref);
      }
    }
    if (uploaded) this.log(job, 'higgsfield.upload', uploaded + ' of ' + references.length + ' reference file(s) uploaded to Higgsfield storage');
    return out;
  }

  async submit(db, job, client) {
    const options = savedOptions(job), model = await this.getModel('higgsfield', job.model, job.media_type);
    if (!model?.ready) throw new Error('This model is currently unavailable. Credits were refunded.');
    // Rendered at the source resolution when HD enhancement follows.
    const params = { ...options, resolution: options.sourceResolution || options.resolution };
    const references = await this.stageReferences(db, job, client, await this.references(db, job));
    let request = null;
    try { request = client.videoRequest?.(model, params, references); } catch {}
    this.log(job, 'higgsfield.request', 'POST /' + (request?.path || '?') + ' · ' + params.resolution,
      { input: request?.input, references: references.map(r => ({ role: r.role, mimeType: r.mimeType, ...(r.seconds != null ? { seconds: r.seconds } : {}), storage: /cmmtools\.site\//.test(r.url) ? 'signed link' : 'higgsfield' })) });
    // The job id as idempotency key: a resend after a lost answer returns the same request.
    const op = await client.startVideo(model, params, references, 'cmm-' + job.id);
    this.log(job, 'higgsfield.accepted', 'Higgsfield request ' + op.requestId, op);
    // Saved before the first poll, so a restart resumes this job instead of paying again.
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify(op), op.requestId.slice(0, 191), job.id]);
  }

  async pollJob(db, client, job) {
    let op = {};
    try { op = JSON.parse(job.provider_operation || '{}') || {}; } catch {}
    if (op.stage === 'enhance') return this.pollEnhancement(db, job, op);
    if (!op.requestId || !op.statusUrl) throw new Error('The video operation could not be resumed.');
    const result = await client.videoStatus(op);
    if (result.status === 'pending') return this.markProcessing(db, job);
    this.log(job, 'higgsfield.status', op.requestId + ' → ' + result.status, result, result.status === 'failed' ? 'error' : 'info');
    if (result.status === 'failed') {
      const reason = String(result.error || '').trim().replace(/[.!]?$/, '.');
      return this.refund(job.id, 'failed', 'The video model could not complete this request' + (reason.length > 1 ? ': ' + reason : '.') + ' Credits were refunded.', null);
    }
    const output = await client.download(result.url);
    if (savedOptions(job).enhance?.upscale) await this.startEnhancement(db, job, output, op.requestId);
    else await this.complete(db, job, output);
  }
}

module.exports = { HiggsfieldQueue };

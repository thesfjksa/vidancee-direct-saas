'use strict';

// ArgoLink jobs run through the same claim, heartbeat, recovery and refund
// logic as the AI Gateway queue; only the API calls differ.
//
// HD enhancement: a Video Studio 720p/1080p job may be rendered lower (see
// argo_hd.js). When ArgoLink finishes, its render is stored and handed to the
// fal.ai upscaler; the upscaled video then replaces it. If the upscale cannot
// run or fails, the customer gets the render and the upscale credits back.
const { VercelQueue, savedOptions } = require('./vercel_queue.js');
const { ArgoLinkClient } = require('./provider/argolink.js');
const { FalClient } = require('./provider/fal.js');
const { providerOutputUrl } = require('./provider/assets.js');
const { saveVideoOutput } = require('./video_outputs.js');

class ArgoLinkQueue extends VercelQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new ArgoLinkClient(opts), ...options, provider: 'argolink' });
    this.falFactory = options.falFactory || (opts => new FalClient(opts));
    // ArgoLink queues a job for up to 10 minutes and long Seedance clips can
    // take a while; a refunded job that later finishes would still be billed.
    this.videoTimeoutMs = 3 * 60 * 60 * 1000;
  }
  apiKey(s) { return s.argoLinkApiKey || ''; }
  sourceEnabled(s) { return Boolean(s.argoLinkEnabled); }
  maxInflight(s) { return s.argoLinkMaxInflight || 3; }

  async runOnce(db, settings = null) {
    const current = settings || await this.getSettings();
    this.settings = current;
    return super.runOnce(db, current);
  }

  fal() {
    const s = this.settings || {};
    return s.falEnabled && s.falApiKey ? this.falFactory({ apiKey: s.falApiKey }) : null;
  }

  async submit(db, job, client) {
    const options = savedOptions(job), model = await this.getModel('argolink', job.model, job.media_type);
    if (!model?.ready) throw new Error('This model is currently unavailable. Credits were refunded.');
    const references = await this.references(db, job);
    if (job.media_type === 'image') {
      await this.complete(db, job, await client.generateImage(model, options, references));
      return;
    }
    // Rendered at the source resolution when HD enhancement follows.
    const requestId = await client.startVideo(model, { ...options, resolution: options.sourceResolution || options.resolution }, references);
    // The request id is saved before the first poll, so a restart resumes the
    // same job instead of paying for a second one.
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify({ requestId }), requestId.slice(0, 191), job.id]);
  }

  async pollJob(db, client, job) {
    let op = {};
    try { op = JSON.parse(job.provider_operation || '{}') || {}; } catch {}
    if (op.stage === 'enhance') return this.pollEnhancement(db, job, op);
    const requestId = op.requestId || job.provider_job_id;
    if (!requestId) throw new Error('The video operation could not be resumed.');
    const result = await client.videoStatus(requestId);
    if (result.status === 'done') {
      const output = await client.videoContent(requestId);
      if (savedOptions(job).enhance?.upscale) await this.startEnhancement(db, job, output, requestId);
      else await this.complete(db, job, output);
    } else if (result.status === 'failed' || result.status === 'expired') {
      const reason = String(result.error?.message || '').slice(0, 200);
      await this.refund(job.id, 'failed', (reason ? 'The video model could not complete this request: ' + reason : 'The video model could not complete this request.') + ' Credits were refunded.', null);
    } else if (result.status === 'pending') await this.markProcessing(db, job);
    else throw Object.assign(new Error('The video status was temporarily unavailable.'), { retryable: true });
  }

  // Stores ArgoLink's render (fal downloads it from a signed link) and starts the upscale.
  async startEnhancement(db, job, output, requestId) {
    await this.storeOutput(db, job, output, false);
    const fal = this.fal();
    if (!fal) return this.finishWithoutEnhancement(db, job);
    const plan = savedOptions(job).enhance.upscale;
    let falOp;
    try { falOp = await fal.submit(plan.path, { video_url: providerOutputUrl(job.id), ...plan.input }); }
    catch (error) {
      console.error('HD enhancement could not start for', job.id, error.message);
      return this.finishWithoutEnhancement(db, job);
    }
    await db.execute("UPDATE generations SET status='processing',provider_operation=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND status IN ('submitted','processing') AND refunded_at IS NULL",
      [JSON.stringify({ requestId, stage: 'enhance', fal: falOp }), job.id]);
  }

  async pollEnhancement(db, job, op) {
    const fal = this.fal();
    if (!fal) return this.finishWithoutEnhancement(db, job);
    const result = await fal.check(op.fal);
    if (result.state === 'done') await this.storeOutput(db, job, await fal.download(result.url), true);
    else if (result.state === 'failed') {
      console.error('HD enhancement failed for', job.id, result.error);
      await this.finishWithoutEnhancement(db, job);
    } else await this.markProcessing(db, job);
  }

  // Saves a video for the job, replacing any earlier one; `finish` completes the job.
  async storeOutput(db, job, output, finish) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[current]] = await conn.execute('SELECT status,refunded_at FROM generations WHERE id=? FOR UPDATE', [job.id]);
      if (!current || current.refunded_at || !['submitting', 'submitted', 'processing'].includes(current.status)) { await conn.rollback(); return false; }
      await conn.execute('DELETE FROM generation_video_chunks WHERE generation_id=?', [job.id]);
      await conn.execute('DELETE FROM generation_video_outputs WHERE generation_id=?', [job.id]);
      await saveVideoOutput(conn, job.id, output);
      if (finish) await conn.execute("UPDATE generations SET status='completed',output_url='db:video',completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),error_message=NULL WHERE id=?", [job.id]);
      await conn.commit();
      return true;
    } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  }

  // Delivers ArgoLink's render and refunds the upscale part of the price.
  async finishWithoutEnhancement(db, job) {
    const credits = Number(savedOptions(job).enhance?.credits || 0);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.execute('SELECT user_id,status,refunded_at,credits_cost FROM generations WHERE id=? FOR UPDATE', [job.id]);
      if (!row || row.refunded_at || !['submitting', 'submitted', 'processing'].includes(row.status)) { await conn.rollback(); return; }
      const refund = Math.min(credits, Number(row.credits_cost));
      await conn.execute(`UPDATE generations SET status='completed',output_url='db:video',completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),
        credits_cost=credits_cost-?,error_message=? WHERE id=?`,
        [refund, 'HD enhancement could not be applied, so this video is at its original resolution.' + (refund > 0 ? ' ' + refund + ' credits were refunded.' : ''), job.id]);
      if (refund > 0) {
        await conn.execute('UPDATE users SET credits = credits + ? WHERE id = ?', [refund, row.user_id]);
        await conn.execute("INSERT INTO credit_transactions (user_id, generation_id, amount, type, note) VALUES (?, ?, ?, 'generation_refund', ?)",
          [row.user_id, job.id, refund, 'HD enhancement refund']);
      }
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  }
}

module.exports = { ArgoLinkQueue };

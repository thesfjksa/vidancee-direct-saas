'use strict';

// ArgoLink jobs run through the same claim, heartbeat, recovery and refund
// logic as the AI Gateway queue; only the API calls differ.
//
// HD enhancement: a Video Studio 720p/1080p job may be rendered lower (see
// argo_hd.js). When ArgoLink finishes, its render is stored and handed to the
// fal.ai upscaler; the upscaled video then replaces it. If the upscale cannot
// run or fails, the customer gets the render and the upscale credits back.
//
// Seedance 2.5 fallback: while ArgoLink is out of credits, a Seedance 2.5 job
// is rendered by Seedance 2.5 on fal.ai instead (see seedance_fal.js), then
// continues through the same HD enhancement. The customer's price is unchanged.
const { VercelQueue, savedOptions } = require('./vercel_queue.js');
const { ArgoLinkClient } = require('./provider/argolink.js');
const { FalClient } = require('./provider/fal.js');
const { providerOutputUrl } = require('./provider/assets.js');
const { saveVideoOutput } = require('./video_outputs.js');
const { errorDetails } = require('./activity_log.js');
const { dimensions } = require('./image_canvas.js');
const { looksOutOfCredits } = require('./cartoon.js');
const { isSeedance25, falSeedanceRequest, falSeedanceUsd } = require('./seedance_fal.js');

class ArgoLinkQueue extends VercelQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new ArgoLinkClient(opts), ...options, provider: options.provider || 'argolink' });
    this.falFactory = options.falFactory || (opts => new FalClient(opts));
    // credits: {isOut(source), markOut(source)}, the worker's out-of-credits marks.
    this.credits = options.credits || null;
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
    const params = { ...options, resolution: options.sourceResolution || options.resolution };
    // fal's Seedance cannot fetch our signed links either, so fal also gets the
    // files from ArgoLink's storage (uploads work while ArgoLink has no balance).
    if (isSeedance25(model) && this.fal() && this.credits?.isOut('argolink')) {
      return this.renderOnFal(db, job, model, params, await this.uploadReferences(db, job, client, model, references), 'ArgoLink is out of credits.');
    }
    const uploaded = await this.uploadReferences(db, job, client, model, references);
    let requestBody = null;
    try { requestBody = client.videoBody?.(model, params, uploaded); } catch {}
    this.log(job, 'argolink.request', 'POST /v1/videos/generations · ' + model.providerModelId + ' · ' + params.resolution, { body: requestBody, references: await this.referenceInfo(db, job, uploaded) });
    let requestId;
    try { requestId = await client.startVideo(model, params, uploaded); }
    catch (error) {
      if (!isSeedance25(model) || !looksOutOfCredits(error)) throw error;
      this.credits?.markOut('argolink');
      if (!this.fal()) throw error;
      return this.renderOnFal(db, job, model, params, uploaded, error.message);
    }
    this.log(job, 'argolink.accepted', 'ArgoLink request ' + requestId, { requestId });
    // The request id is saved before the first poll, so a restart resumes the
    // same job instead of paying for a second one.
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify({ requestId }), requestId.slice(0, 191), job.id]);
  }

  async pollJob(db, client, job) {
    let op = {};
    try { op = JSON.parse(job.provider_operation || '{}') || {}; } catch {}
    if (op.stage === 'enhance') return this.pollEnhancement(db, job, op);
    if (op.stage === 'fal') return this.pollFalRender(db, job, op);
    const requestId = op.requestId || job.provider_job_id;
    if (!requestId) throw new Error('The video operation could not be resumed.');
    const result = await client.videoStatus(requestId);
    // One log line per status change (not on every poll).
    const seen = job.id + ':' + requestId + ':' + result.status;
    if (!this.loggedStatus) this.loggedStatus = new Set();
    if (!this.loggedStatus.has(seen)) {
      this.loggedStatus.add(seen); if (this.loggedStatus.size > 2000) this.loggedStatus.clear();
      this.log(job, 'argolink.status', requestId + ' → ' + result.status, result, result.status === 'failed' || result.status === 'expired' ? 'error' : 'info');
    }
    if (result.status === 'done') {
      const output = await client.videoContent(requestId);
      if (savedOptions(job).enhance?.upscale) await this.startEnhancement(db, job, output, requestId);
      else await this.complete(db, job, output);
    } else if (result.status === 'failed' || result.status === 'expired') {
      const error = result.error || {};
      console.error('ArgoLink job failed for', job.id, requestId, error.code || result.status, error.message || '');
      const options = savedOptions(job);
      if (isSeedance25(options.model) && looksOutOfCredits({ message: [error.code, error.message].join(' ') })) {
        this.credits?.markOut('argolink');
        // If fal cannot take it either, the job is refunded below.
        if (this.fal()) {
          try { return await this.renderOnFal(db, job, options.model, { ...options, resolution: options.sourceResolution || options.resolution },
            await this.uploadReferences(db, job, client, options.model, await this.references(db, job)), error.message || 'ArgoLink is out of credits.'); }
          catch (falError) { this.log(job, 'fal.seedance_failed', 'fal.ai could not take the job: ' + falError.message, errorDetails(falError), 'error'); }
        }
      }
      // ArgoLink marks a failure retryable when nothing was consumed and the
      // same request can safely run again. Try once more before refunding.
      if (result.status === 'failed' && error.retryable === true && !op.retried && await this.retry(db, client, job, op)) return;
      const reason = String(error.message || '').slice(0, 200);
      await this.refund(job.id, 'failed', (reason ? 'The video model could not complete this request: ' + reason : 'The video model could not complete this request.') + ' Credits were refunded.', null);
    } else if (result.status === 'pending') await this.markProcessing(db, job);
    else throw Object.assign(new Error('The video status was temporarily unavailable.'), { retryable: true });
  }

  // Size and format of each reference, for the activity log (ArgoLink rejects
  // some sizes, e.g. Seedance 2.5 images must be 300-6000 px with a 0.4-2.5 ratio).
  async referenceInfo(db, job, references) {
    if (!references.length) return [];
    try {
      const [rows] = await db.execute('SELECT position_index,media_kind,mime_type,LENGTH(media_data) AS bytes,media_data FROM generation_media WHERE generation_id=? ORDER BY position_index', [job.id]);
      await require('./object_storage.js').hydrateBlobs(rows, 'media_data');
      return rows.map((r, i) => {
        let size = null;
        if (r.media_kind === 'image') { try { size = dimensions(r.media_data, r.mime_type); } catch {} }
        return { role: references[i]?.role, kind: r.media_kind, mimeType: r.mime_type, bytes: r.media_data?.length ?? Number(r.bytes),
          ...(size ? { width: size.width, height: size.height, ratio: Math.round(size.width / size.height * 1000) / 1000 } : {}) };
      });
    } catch { return references.map(r => ({ role: r.role, mimeType: r.mimeType })); }
  }

  // Seedance fails jobs whose references it fetches from our signed links,
  // while the same files uploaded to ArgoLink's storage work (that is what the
  // Playground does). Each reference is uploaded and its media_url sent instead;
  // if an upload fails, the job keeps the signed links.
  async uploadReferences(db, job, client, model, references) {
    if (!references.length || !/^seedance-/.test(model.providerModelId || '') || typeof client.uploadMedia !== 'function') return references;
    try {
      const [rows] = await db.execute('SELECT position_index,mime_type,media_data FROM generation_media WHERE generation_id=? ORDER BY position_index', [job.id]);
      await require('./object_storage.js').hydrateBlobs(rows, 'media_data');
      if (rows.length !== references.length) throw new Error('The reference files could not be read.');
      const uploaded = [];
      for (const [i, ref] of references.entries()) uploaded.push({ ...ref, url: await client.uploadMedia(model, { data: rows[i].media_data, mimeType: rows[i].mime_type }) });
      this.log(job, 'argolink.upload', uploaded.length + ' reference file(s) uploaded to ArgoLink storage', { files: rows.map(r => ({ mimeType: r.mime_type, bytes: r.media_data?.length })) });
      return uploaded;
    } catch (error) {
      this.log(job, 'argolink.upload_failed', 'Upload to ArgoLink storage failed; sending signed links instead: ' + error.message, errorDetails(error), 'warn');
      return references;
    }
  }

  // Resubmits a retryable failure once; the new request id replaces the old one.
  async retry(db, client, job, op) {
    try {
      const options = savedOptions(job), model = await this.getModel('argolink', job.model, job.media_type);
      if (!model?.ready) return false;
      const references = await this.uploadReferences(db, job, client, model, await this.references(db, job));
      const requestId = await client.startVideo(model, { ...options, resolution: options.sourceResolution || options.resolution }, references);
      this.log(job, 'argolink.retry', 'Retrying once as ' + requestId + ' (ArgoLink marked the failure retryable)', { firstRequestId: op.requestId || job.provider_job_id, requestId });
      await db.execute("UPDATE generations SET status='processing',provider_operation=?,provider_job_id=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND status IN ('submitted','processing') AND refunded_at IS NULL",
        [JSON.stringify({ requestId, retried: true, firstRequestId: op.requestId || job.provider_job_id }), requestId.slice(0, 191), job.id]);
      return true;
    } catch (error) {
      console.error('ArgoLink retry could not start for', job.id, error.message);
      return false;
    }
  }

  // Seedance 2.5 on fal.ai for a job ArgoLink cannot pay for. fal reads the
  // references from the app's signed links. The request id is saved before the
  // first poll, so a restart resumes this render instead of paying again.
  async renderOnFal(db, job, model, params, references, reason) {
    const fal = this.fal();
    const request = falSeedanceRequest(params, references);
    const renderUsd = falSeedanceUsd(model, params);
    const upscaleUsd = Number(params.enhance?.upscale?.usd || 0);
    this.log(job, 'fal.seedance_request', 'ArgoLink is out of credits; rendering on fal.ai ' + request.path + ' · ' + params.resolution,
      { reason: String(reason || '').slice(0, 300), input: request.input, estimatedUsd: renderUsd }, 'warn');
    const op = await fal.submit(request.path, request.input);
    this.log(job, 'fal.seedance_accepted', 'fal request ' + op.requestId, { requestId: op.requestId });
    await db.execute(`UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,provider_cost=COALESCE(?,provider_cost),
        started_at=COALESCE(started_at,UTC_TIMESTAMP()),updated_at=UTC_TIMESTAMP(),error_message=NULL
      WHERE id=? AND status IN ('submitting','submitted','processing') AND refunded_at IS NULL`,
      [JSON.stringify({ stage: 'fal', fal: op, path: request.path }), op.requestId.slice(0, 191), renderUsd == null ? null : renderUsd + upscaleUsd, job.id]);
  }

  // A fal render, once finished, is handled like ArgoLink's: HD enhancement or completion.
  async pollFalRender(db, job, op) {
    const fal = this.fal();
    if (!fal) throw Object.assign(new Error('fal.ai is not configured, so the Seedance 2.5 render cannot be collected.'), { retryable: true });
    const result = await fal.check(op.fal);
    if (result.state === 'pending') return this.markProcessing(db, job);
    this.log(job, 'fal.seedance_status', op.fal.requestId + ' → ' + result.state, result, result.state === 'failed' ? 'error' : 'info');
    if (result.state === 'failed') {
      const reason = String(result.error || '').trim().replace(/[.!]?$/, '.');
      return this.refund(job.id, 'failed', 'The video model could not complete this request' + (reason.length > 1 ? ': ' + reason : '.') + ' Credits were refunded.', null);
    }
    const output = await fal.download(result.url);
    if (savedOptions(job).enhance?.upscale) await this.startEnhancement(db, job, output, op.fal.requestId);
    else await this.complete(db, job, output);
  }

  // Stores ArgoLink's render (fal downloads it from a signed link) and starts the upscale.
  async startEnhancement(db, job, output, requestId) {
    await this.storeOutput(db, job, output, false);
    const fal = this.fal();
    if (!fal) return this.finishWithoutEnhancement(db, job);
    const plan = savedOptions(job).enhance.upscale;
    let falOp;
    this.log(job, 'enhance.request', 'fal upscale ' + plan.path, { input: plan.input, renderBytes: output.data?.length });
    try { falOp = await fal.submit(plan.path, { video_url: providerOutputUrl(job.id), ...plan.input }); }
    catch (error) {
      console.error('HD enhancement could not start for', job.id, error.message);
      this.log(job, 'enhance.failed', 'fal upscale could not start: ' + error.message, errorDetails(error), 'error');
      return this.finishWithoutEnhancement(db, job);
    }
    await db.execute("UPDATE generations SET status='processing',provider_operation=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND status IN ('submitted','processing') AND refunded_at IS NULL",
      [JSON.stringify({ requestId, stage: 'enhance', fal: falOp }), job.id]);
  }

  async pollEnhancement(db, job, op) {
    const fal = this.fal();
    if (!fal) return this.finishWithoutEnhancement(db, job);
    const result = await fal.check(op.fal);
    if (result.state === 'done') {
      const output = await fal.download(result.url);
      await this.storeOutput(db, job, output, true);
      this.log(job, 'enhance.completed', 'Upscaled video saved', { bytes: output.data.length, falRequestId: op.fal?.requestId });
    } else if (result.state === 'failed') {
      console.error('HD enhancement failed for', job.id, result.error);
      this.log(job, 'enhance.failed', 'fal upscale failed: ' + result.error, { falRequestId: op.fal?.requestId, error: result.error }, 'error');
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
      const storedAt=await saveVideoOutput(conn, job.id, output);
      // Keep intermediate Argo render playable via signed provider-outputs
      // when the HD upscaling step is still running.
      await conn.execute("UPDATE generations SET output_url=? WHERE id=?", [storedAt,job.id]);
      if (finish) await conn.execute("UPDATE generations SET status='completed',output_url=?,completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),error_message=NULL WHERE id=?", [storedAt,job.id]);
      await conn.commit();
      return true;
    } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  }

  // Delivers ArgoLink's render and refunds the upscale part of the price.
  async finishWithoutEnhancement(db, job) {
    this.log(job, 'enhance.skipped', 'Delivered without HD enhancement; upscale credits refunded', null, 'warn');
    const credits = Number(savedOptions(job).enhance?.credits || 0);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.execute('SELECT user_id,status,refunded_at,credits_cost FROM generations WHERE id=? FOR UPDATE', [job.id]);
      if (!row || row.refunded_at || !['submitting', 'submitted', 'processing'].includes(row.status)) { await conn.rollback(); return; }
      const refund = Math.min(credits, Number(row.credits_cost));
      // The intermediate render may be in MySQL or Google Drive.
      await conn.execute(`UPDATE generations SET status='completed',completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),
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

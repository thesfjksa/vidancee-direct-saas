'use strict';

const { VercelQueue } = require('./vercel_queue.js');
const { getPool } = require('./db.js');
const { getProviderSettings } = require('./settings.js');
const { getAividSettings } = require('./aivid_settings.js');
const { AividBrowserlessClient, ID } = require('./provider/aivid.js');

function operation(job) {
  try { return JSON.parse(job.provider_operation || '{}') || {}; } catch { return {}; }
}

async function withAividLock(db, fn) {
  const conn = await db.getConnection(); let locked = false;
  try {
    const [[row]] = await conn.query("SELECT GET_LOCK('cmm_aivid_browser',0) AS acquired");
    locked = Number(row?.acquired) === 1;
    return locked ? await fn() : null;
  } finally {
    if (locked) await conn.query("SELECT RELEASE_LOCK('cmm_aivid_browser')").catch(() => {});
    conn.release();
  }
}

// The public customer catalog is intentionally not registered in this stage.
// This queue supports owner trial rows and the later verified model adapter.
// No generic queue recovery can repeat or refund an ambiguous paid click.
class AividQueue extends VercelQueue {
  constructor({ getConfig = getAividSettings, clientFactory = opts => opts.mode === 'rdp'
    ? new (require('./aivid_rdp.js').AividRdpClient)(opts) : new AividBrowserlessClient(opts), ...options } = {}) {
    super({ ...options, provider: 'aivid', clientFactory });
    this.getConfig = getConfig;
    this.collectionWaitingForAgent = false;
    this.maxSourceInflight=Math.max(1,Math.min(10,Math.floor(Number(process.env.AIVID_MAX_INFLIGHT)||3)));
  }
  health(){return {...super.health(),collectionGuardRevision:1,multiQueueRevision:1,maxSourceInflight:this.maxSourceInflight,collectionWaitingForAgent:this.collectionWaitingForAgent};}
  schedule(delay = 30000) { return super.schedule(delay); }
  async runOnce(db = getPool(), settings = null) {
    const config = await this.getConfig();
    this.sourceReady = false;
    this.collectionWaitingForAgent = false;
    if (config.mode === 'rdp' ? !config.rdpDevice?.tokenHash : !config.connectUrl) return;
    const current = settings || await this.getSettings();
    this.sourceReady = Boolean(config.enabled && config.maxSourceCredits > 0 && current.allowProviderCharges);
    const rdp=config.mode==='rdp'?require('./aivid_rdp.js').publicDevice(config.rdpDevice||{}):null;
    if(rdp&&(!rdp.online||rdp.status!=='ready'))this.sourceReady=false;
    const client = this.clientFactory(config);
    await withAividLock(db, async () => {
      // Holding this lock proves no other live queue operation can be clicking.
      // A restart after click reservation is held for reconciliation forever,
      // even with zero credits or after the normal video timeout.
      const [interrupted] = await db.query("SELECT * FROM generations WHERE provider='aivid' AND status='submitting' AND refunded_at IS NULL ORDER BY created_at LIMIT 20");
      for (const job of interrupted) {
        if (operation(job).stage === 'preparing') {
          await this.refund(job.id, 'submit_error', 'Generation stopped before submission. Credits were refunded.', null);
        } else await this.hold(db, job);
      }
      const [active] = await db.query("SELECT * FROM generations WHERE provider='aivid' AND status IN ('submitted','processing') AND refunded_at IS NULL ORDER BY (provider_job_id IS NULL OR provider_operation LIKE '%review_required%'),updated_at LIMIT 50");
      let inflight=active.filter(row=>operation(row).stage!=='review_required'&&ID.test(String(row.provider_job_id||''))).length;
      if (inflight) {
        // A held/invalid older job must not starve other accepted videos.
        // If all rows need review, preserve the pause on new submissions.
        const job=active.find(row=>operation(row).stage!=='review_required'&&ID.test(String(row.provider_job_id||'')));
        if(!job)return;
        // A needs_login agent cannot claim collection commands. Waiting for
        // one here held the browser lock for 180 seconds, blocking the very
        // Admin preflight that could restore readiness. Keep the accepted ID
        // and release the lock immediately until the live agent is ready.
        if(rdp&&(!rdp.online||rdp.status!=='ready')){
          this.collectionWaitingForAgent=true;return;
        }
        this.tasks.add(job.id);
        try { const state=await this.pollJob(db, client, job);if(['completed','failed'].includes(state))inflight--; }
        catch {
          // Sign-out, missing/private detail page, source failure, download or
          // storage failures retain the accepted ID; never resubmit or refund.
          await db.execute("UPDATE generations SET error_message=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND status IN ('submitted','processing') AND refunded_at IS NULL",
            ['Waiting for the video service. Your existing generation will resume automatically.', job.id]);
        } finally { this.tasks.delete(job.id); }
      }
      if(inflight>=this.maxSourceInflight)return;
      if (!this.sourceReady || this.stopped) return;
      const [rows] = await db.query("SELECT g.* FROM generations g JOIN users u ON u.id=g.user_id AND u.status='active' WHERE g.provider='aivid' AND g.status='queued' ORDER BY g.queue_priority DESC,g.created_at LIMIT 1");
      const job = rows[0]; if (!job) return;
      const [claimed] = await db.execute("UPDATE generations SET status='submitting',submitted_at=UTC_TIMESTAMP(),provider_operation=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND status='queued' AND refunded_at IS NULL",
        [JSON.stringify({ stage: 'preparing' }), job.id]);
      if (!claimed.affectedRows) return;
      this.tasks.add(job.id);
      try { await this.submit(db, job, client); }
      finally { this.tasks.delete(job.id); }
    });
  }
  async filesFor(db, job) {
    const [rows] = await db.execute('SELECT media_kind,filename,mime_type,media_data FROM generation_media WHERE generation_id=? ORDER BY position_index', [job.id]);
    await require('./object_storage.js').hydrateBlobs(rows, 'media_data');
    return rows.map(r => ({ kind: r.media_kind, mimeType: r.mime_type, data: r.media_data }));
  }
  async submit(db, job, client) {
    let clicked = false;
    try {
      const options = JSON.parse(job.generation_options || '{}');
      const references = await this.filesFor(db, job);
      const result = await client.startVideo({ ...options, jobId: job.id, prompt: job.prompt, duration: job.duration,
        aspectRatio: job.aspect_ratio, resolution: job.resolution }, references, { beforeClick: async ({ price }) => {
          if (this.stopped) throw new Error('Worker is stopping before submission.');
          const latest = await this.getSettings();
          const config = await this.getConfig();
          if (!latest.allowProviderCharges || !config.enabled || price > config.maxSourceCredits ||
              (Number.isFinite(Number(options.quotedSourceCredits)) && options.quotedSourceCredits != null && Number(options.quotedSourceCredits)!==price))
            throw new Error('New submissions are paused or the price limit changed.');
          const [reserved] = await db.execute("UPDATE generations SET provider_operation=?,provider_cost=?,provider_cost_unit='aivid_credits',updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND status='submitting' AND refunded_at IS NULL",
            [JSON.stringify({ stage: 'click_reserved', price }), price, job.id]);
          if (!reserved.affectedRows) throw new Error('The submission reservation is unavailable.');
          clicked = true;
        } });
      if (result.state === 'accepted') {
        if (!ID.test(result.providerJobId)) throw new Error('Invalid accepted job ID.');
        const [saved] = await db.execute("UPDATE generations SET status='submitted',provider_job_id=?,provider_operation=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),error_message=NULL WHERE id=? AND provider='aivid' AND status='submitting' AND refunded_at IS NULL",
          [result.providerJobId, JSON.stringify({ stage: 'accepted', providerJobId: result.providerJobId }), job.id]);
        if (!saved.affectedRows) throw new Error('Accepted job could not be persisted.');
      } else if (result.state === 'rejected') {
        await this.refund(job.id, 'failed', 'The video request was rejected before acceptance. Credits were refunded.', null);
      } else await this.hold(db, job);
    } catch {
      if (clicked) await this.hold(db, job);
      else await this.refund(job.id, 'submit_error', 'The video request could not be prepared. Credits were refunded.', null);
    }
  }
  async hold(db, job) {
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,error_message=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND status IN ('submitting','submitted','processing') AND refunded_at IS NULL",
      [JSON.stringify({ ...operation(job), stage: 'review_required' }), 'Submission needs an account history check. No automatic retry will be made.', job.id]);
  }
  async pollJob(db, client, job) {
    const result = await client.collectVideo(job.provider_job_id);
    if (result.state === 'pending'){await this.markProcessing(db,job);return 'pending';}
    if (result.state === 'failed'){await this.refund(job.id, 'failed', 'The video could not be completed. Credits were refunded.', null);return 'failed';}
    if (result.state !== 'completed') throw new Error('Unknown video status.');
    await this.complete(db, job, result.output);return 'completed';
  }
}

// Owner reconciliation attaches a VERIFIED existing source ID. It never
// creates a new source job. Confirmed non-submission uses the normal wallet
// refund transaction. Both actions share the same lock as the queue.
async function reconcileAivid(db, id, input, refund = require('./generations.js').refundGeneration) {
  const result = await withAividLock(db, async () => {
    const [[job]] = await db.execute("SELECT * FROM generations WHERE id=? AND provider='aivid'", [id]);
    if (!job || job.refunded_at || !['submitted', 'submitting'].includes(job.status) || operation(job).stage !== 'review_required')
      throw Object.assign(new Error('Only a held AIVID submission can be reconciled.'), { statusCode: 409 });
    if (input.action === 'attach' && ID.test(String(input.providerJobId || ''))) {
      await db.execute("UPDATE generations SET status='submitted',provider_job_id=?,provider_operation=?,error_message=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND refunded_at IS NULL",
        [input.providerJobId, JSON.stringify({ stage: 'accepted', providerJobId: input.providerJobId }), id]);
    } else if (input.action === 'refund' && input.confirmedNotSubmitted === true) {
      await refund(id, 'submit_error', 'Account history confirmed no generation was submitted. Credits were refunded.', null);
    } else throw Object.assign(new Error('Attach a verified providerJobId or confirm that no submission exists.'), { statusCode: 400 });
    return { reconciled: true };
  });
  if (!result) throw Object.assign(new Error('The AIVID browser is busy. Try again after its current operation.'), { statusCode: 409 });
  return result;
}

module.exports = { AividQueue, withAividLock, reconcileAivid, operation };

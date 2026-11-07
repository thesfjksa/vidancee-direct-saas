'use strict';

const { VercelQueue } = require('./vercel_queue.js');
const { getPool } = require('./db.js');
const { getProviderSettings } = require('./settings.js');
const { getAividSettings } = require('./aivid_settings.js');
const { AividBrowserlessClient, ID, DIAGNOSTICS, diagnosticMessage } = require('./provider/aivid.js');

function operation(job) {
  try { return JSON.parse(job.provider_operation || '{}') || {}; } catch { return {}; }
}

async function withAividLock(db, fn, { keepaliveMs = 10000 } = {}) {
  const conn = await db.getConnection();
  let locked = false, keepalive, heartbeat;
  try {
    const [[row]] = await conn.query("SELECT GET_LOCK('cmm_aivid_browser',0) AS acquired");
    locked = Number(row?.acquired) === 1;
    if (!locked) return null;
    // RDP browser work uses other DB connections. Keep this session active
    // while Chrome prepares the upload so an idle disconnect cannot drop its lock.
    keepalive = setInterval(() => {
      if (!heartbeat) heartbeat = conn.query({sql:'SELECT 1',timeout:5000})
        .catch(() => {}).finally(() => { heartbeat = null; });
    }, keepaliveMs);
    keepalive.unref();
    return await fn(conn);
  } finally {
    clearInterval(keepalive);
    await heartbeat;
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
  health(){return {...super.health(),collectionGuardRevision:1,collectionRetryRevision:1,multiQueueRevision:1,maxSourceInflight:this.maxSourceInflight,collectionWaitingForAgent:this.collectionWaitingForAgent};}
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
    await withAividLock(db, async lockConnection => {
      // A connection failure can release another worker's lock while its
      // RDP command is still live. Let that command finish before recovery.
      const [interrupted] = await db.query("SELECT * FROM generations WHERE provider='aivid' AND status='submitting' AND refunded_at IS NULL ORDER BY created_at LIMIT 20");
      if (rdp && interrupted.length) {
        const ids = interrupted.map(job => job.id);
        const [live] = await db.execute(
          "SELECT id FROM aivid_rdp_commands WHERE kind='submit' AND state<>'cancelled' AND expires_at>UTC_TIMESTAMP(3) AND generation_id IN (" +
          ids.map(() => '?').join(',') + ') LIMIT 1', ids);
        if (live.length) return;
      }
      // A restart after a durable reservation requires reconciliation.
      for (const job of interrupted) {
        if (operation(job).stage === 'preparing') {
          await this.refund(job.id, 'submit_error', 'Generation stopped before submission. Credits were refunded.', null);
        } else await this.hold(db, job);
      }
      const [active] = await db.query("SELECT * FROM generations WHERE provider='aivid' AND status IN ('submitted','processing') AND refunded_at IS NULL ORDER BY (provider_job_id IS NULL OR provider_operation LIKE '%review_required%'),updated_at LIMIT 50");
      let inflight=active.filter(row=>operation(row).stage!=='review_required'&&!operation(row).collectionPaused&&ID.test(String(row.provider_job_id||''))).length;
      if (inflight) {
        // A held/invalid older job must not starve other accepted videos.
        // If all rows need review, preserve the pause on new submissions.
        const job=active.find(row=>operation(row).stage!=='review_required'&&!operation(row).collectionPaused&&!(Number(operation(row).collectionNextAt)>Date.now())&&ID.test(String(row.provider_job_id||'')));
        if(job){
        // A needs_login agent cannot claim collection commands. Waiting for
        // one here held the browser lock for 180 seconds, blocking the very
        // Admin preflight that could restore readiness. Keep the accepted ID
        // and release the lock immediately until the live agent is ready.
        if(rdp&&(!rdp.online||rdp.status!=='ready')){
          this.collectionWaitingForAgent=true;return;
        }
        this.tasks.add(job.id);
        try { const state=await this.pollJob(db, client, job);if(['completed','failed'].includes(state))inflight--; }
        catch(error) {
          // Sign-out, missing/private detail page, source failure, download or
          // storage failures retain the accepted ID; never resubmit or refund.
          const op=operation(job),attempts=(Number(op.collectionFailures)||0)+1,paused=attempts>=3||error?.aividCode==='download_security';
          await db.execute("UPDATE generations SET provider_operation=?,error_message=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND status IN ('submitted','processing') AND refunded_at IS NULL",
            [JSON.stringify({...op,collectionFailures:attempts,collectionPaused:paused,collectionNextAt:Date.now()+Math.min(900000,60000*2**(attempts-1))}),
            paused?(error?.aividCode==='download_security'?'Chrome blocked the download with a security warning. Collection is paused for review; the existing video is preserved.':'Automatic collection paused after repeated transfer errors. Support must review the existing video; it will not be generated again.'):'Video transfer is temporarily unavailable. The existing video will be checked again after a delay.',job.id]);
          if(paused)inflight--;

        } finally { this.tasks.delete(job.id); }
        }
      }
      if(inflight>=this.maxSourceInflight)return;
      if (!this.sourceReady || this.stopped) return;
      const [rows] = await db.query("SELECT g.* FROM generations g JOIN users u ON u.id=g.user_id AND u.status='active' WHERE g.provider='aivid' AND g.status='queued' ORDER BY g.queue_priority DESC,g.created_at LIMIT 1");
      const job = rows[0]; if (!job) return;
      const [claimed] = await db.execute("UPDATE generations SET status='submitting',submitted_at=UTC_TIMESTAMP(),provider_operation=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND status='queued' AND refunded_at IS NULL",
        [JSON.stringify({ stage: 'preparing' }), job.id]);
      if (!claimed.affectedRows) return;
      this.tasks.add(job.id);
      try { await this.submit(db, job, client, lockConnection); }
      finally { this.tasks.delete(job.id); }
    });
  }
  async filesFor(db, job) {
    const [rows] = await db.execute('SELECT media_kind,filename,mime_type,media_data FROM generation_media WHERE generation_id=? ORDER BY position_index', [job.id]);
    await require('./object_storage.js').hydrateBlobs(rows, 'media_data');
    return rows.map(r => ({ kind: r.media_kind, mimeType: r.mime_type, data: r.media_data }));
  }
  async submit(db, job, client, lockConnection) {
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
          const [reserved] = await lockConnection.query("UPDATE generations SET provider_operation=?,provider_cost=?,provider_cost_unit='aivid_credits',updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND status='submitting' AND refunded_at IS NULL AND IS_USED_LOCK('cmm_aivid_browser')=CONNECTION_ID()",
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
        const code=result.errorCode;
        const detail=Object.hasOwn(DIAGNOSTICS,code)
          ? '['+code+'] '+diagnosticMessage(code)+(code==='source_rejected'&&Number.isInteger(result.httpStatus)?' (HTTP '+result.httpStatus+')':'')
          : 'The video request was rejected before acceptance.';
        await this.refund(job.id, 'failed', detail+' Credits were refunded.', null);
      } else await this.hold(db, job);
    } catch(error) {
      if (clicked) await this.hold(db, job);
      else {
        const code=error?.aividCode;
        const detail=Object.hasOwn(DIAGNOSTICS,code)?'['+code+'] '+diagnosticMessage(code):'The video request could not be prepared.';
        await this.refund(job.id, 'submit_error', detail+' Credits were refunded.', null);
      }
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
    if (!job || job.refunded_at || !['submitted', 'submitting','processing'].includes(job.status) || (operation(job).stage !== 'review_required' && !(input.action==='retry_collection'&&operation(job).collectionPaused&&ID.test(String(job.provider_job_id||'')))))
      throw Object.assign(new Error('Only a held AIVID submission can be reconciled.'), { statusCode: 409 });
    if(input.action==='retry_collection'&&operation(job).collectionPaused){
      const {collectionFailures,collectionNextAt,collectionPaused,...op}=operation(job);
      await db.execute("UPDATE generations SET provider_operation=?,error_message=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND refunded_at IS NULL",[JSON.stringify(op),id]);
    } else if (input.action === 'attach' && ID.test(String(input.providerJobId || ''))) {
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

// Admin actions share the submission/collection lock. Stopping local work
// cannot cancel a paid source request, and must never trigger a replacement.
async function manageAividJob(db, id, action, {
  refund = require('./generations.js').refundGeneration,
  remove = require('./generations.js').deleteUserGeneration,
} = {}) {
  if (!['cancel','delete'].includes(action)) throw Object.assign(new Error('Invalid job action.'), {statusCode:400});
  const result = await withAividLock(db, async () => {
    const [[job]] = await db.execute("SELECT * FROM generations WHERE id=? AND provider='aivid' AND media_type='video'", [id]);
    if (!job) throw Object.assign(new Error('Generation not found.'), {statusCode:404});
    const op=operation(job), terminal=['completed','failed','submit_error'].includes(job.status);
    if (action==='delete') {
      if (!terminal) throw Object.assign(new Error('Cancel this job before deleting it.'), {statusCode:409});
      // Preserve the source receipt before deleting the generation. The normal
      // removal also retains credit transactions while clearing their job FK.
      await db.execute(`INSERT INTO activity_log (service,level,category,event,user_id,generation_id,provider,message,details,host)
        VALUES ('web','info','admin','aivid.delete_receipt',?,?, 'aivid', 'Admin requested deletion of stopped video.',?, 'admin')`,
        [job.user_id,id,JSON.stringify({providerJobId:job.provider_job_id||null,status:job.status,creditsCost:job.credits_cost,
          providerCost:job.provider_cost,refundedAt:job.refunded_at||null,stage:op.stage||null})]);
      await remove(job.user_id,id);
      return {deleted:true};
    }
    if (terminal) {
      if (op.adminCancelled) return {cancelled:true,refunded:Boolean(job.refunded_at)};
      throw Object.assign(new Error('This job has already finished.'), {statusCode:409});
    }
    if (!['queued','submitting','submitted','processing'].includes(job.status))
      throw Object.assign(new Error('This job cannot be cancelled in its current state.'), {statusCode:409});
    const safeToRefund=!job.provider_job_id && (job.status==='queued'||(job.status==='submitting'&&op.stage==='preparing'));
    const next={...op,adminCancelled:true,collectionPaused:true,cancelledAt:new Date().toISOString()};
    if (safeToRefund) {
      await refund(id,'failed','Cancelled by an administrator before submission. Credits were refunded.',null);
      await db.execute("UPDATE generations SET provider_operation=? WHERE id=? AND provider='aivid' AND status='failed'",[JSON.stringify(next),id]);
    } else {
      await db.execute("UPDATE generations SET status='failed',provider_operation=?,error_message=?,completed_at=COALESCE(completed_at,UTC_TIMESTAMP()),updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='aivid' AND status IN ('queued','submitting','submitted','processing')",
        [JSON.stringify(next),'Stopped by an administrator. A submitted video may still complete at the video service; credits were not automatically refunded.',id]);
    }
    return {cancelled:true,refunded:safeToRefund||Boolean(job.refunded_at)};
  });
  if (!result) throw Object.assign(new Error('A video operation is currently running. Try again when it finishes.'),{statusCode:409});
  return result;
}

module.exports = { AividQueue, withAividLock, reconcileAivid, manageAividJob, operation };

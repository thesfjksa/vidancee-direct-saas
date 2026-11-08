const { VercelQueue } = require('./vercel_queue.js');
const { Api888Queue } = require('./api888_queue.js');
const { FalImageQueue } = require('./fal_image_queue.js');
const { ArgoLinkQueue } = require('./argolink_queue.js');
const { HiggsfieldQueue } = require('./higgsfield_queue.js');
const { LongAiQueue } = require('./longai_queue.js');
const { WxksaiQueue } = require('./wxksai_queue.js');
const { SluiceQueue } = require('./sluice_queue.js');
const { VidanceeQueue } = require('./vidancee_queue.js');
const { AividQueue } = require('./aivid_queue.js');
const { UpscaleQueue } = require('./upscale_queue.js');
const { getPool, dbConfigured } = require('./db.js');
const { VgenvClient } = require('./provider/vgenv.js');
const { isH3Model, h3VgenvModel, h3VgenvTier } = require('./pricing.js');
const { SmartAipiClient } = require('./provider/smartaipi.js');
const { smartImageModel, smartImageSourcePrice } = require('./smartaipi_images.js');
const { VibiClient } = require('./provider/vibi.js');
const { providerAssetUrl } = require('./provider/assets.js');
const { providerPrompt, looksOutOfCredits } = require('./cartoon.js');
const { recordProviderStatus, readProviderStatus } = require('./provider_usage.js');
const { moveImageJobToArgo } = require('./image_failover.js');
const { logActivity, errorDetails } = require('./activity_log.js');
const { getProviderModelByPublicId } = require('./provider_models.js');
const { getProviderSettings } = require('./settings.js');
const { refundGeneration } = require('./generations.js');
const { sourceToCustomerCredits } = require('./billing.js');
const { saveVideoOutput } = require('./video_outputs.js');
const https = require('node:https');

// Plain HTTPS GET over IPv4 (follows up to 3 redirects), for hosts where
// fetch() cannot connect.
function downloadIPv4(url, { timeoutMs, maxBytes }, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { family: 4, timeout: timeoutMs }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 3) {
        response.resume();
        return resolve(downloadIPv4(new URL(response.headers.location, url).href, { timeoutMs, maxBytes }, redirects + 1));
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error('vgenv video download failed (HTTP ' + response.statusCode + ').')); }
      const chunks = []; let total = 0;
      response.on('data', chunk => { total += chunk.length; if (total > maxBytes) { request.destroy(new Error('vgenv video is too large to keep.')); return; } chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks, total)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('vgenv video download timed out.')));
    request.on('error', reject);
  });
}

// Customer message for a job the source accepted and then failed: its reason
// when it gives one, without links (vendor names are hidden before customers see it).
function failedMessage(reason) {
  const text = (typeof reason === 'string' ? reason : '').replace(/\bhttps?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[.!]?$/, '.');
  return text.length > 1 ? 'Generation failed: ' + text + ' Credits were refunded.' : 'Generation failed during processing. Credits were refunded.';
}

function truthy(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

class GenerationWorker {
  constructor() {
    const credits = {
      isOut: key => Number(this.outOfCreditsUntil?.[key] || 0) > Date.now(),
      markOut: key => this.markOutOfCredits(key),
    };
    // Image Studio: AI Gateway and SmartAIPI first, ArgoLink when they run out of credits.
    this.imageFailover = { ...credits, move: async (db, job) => moveImageJobToArgo(db, job, await getProviderSettings()) };
    this.vercelQueue = new VercelQueue({ failover: this.imageFailover });
    this.api888Queue = new Api888Queue();
    this.falImageQueue = new FalImageQueue();
    // Video Studio: Seedance 2.5 renders on fal.ai while ArgoLink is out of credits.
    this.argoLinkQueue = new ArgoLinkQueue({ credits });
    // Video Studio: Wan 3.0 on the Higgsfield API.
    this.higgsfieldQueue = new HiggsfieldQueue();
    // Seedance Lite on Sluice.
    this.sluiceQueue = new SluiceQueue();
    this.longAiQueue = new LongAiQueue();
    this.wxksaiQueue = new WxksaiQueue();
    // Omni Flash on Vidancee.
    this.vidanceeQueue = new VidanceeQueue();
    this.aividQueue = new AividQueue();
    this.upscaleQueue = new UpscaleQueue();
    this.running = false;
    this.timer = null;
    this.stopped = false;
    this.smartImageLaneActive = false;
    this.smartImageTimer = null;
    this.smartImageRunning = false;
    this.lastTickStartedAt = null;
    this.lastTickFinishedAt = null;
    this.lastSmartTickStartedAt = null;
    this.lastSmartTickFinishedAt = null;
    this.lastSmartTickSucceededAt = null;
    this.smartImageAllowCharges = false;
    this.vgenv = null;
    this.vibi = null;
    this.smartAipi = null;
    this.smartAipiFingerprint = '';
    this.smartImageTasks = new Set();
    this.smartImageJobIds = new Set();
    this.smartAipiEnabled = false;
    this.smartAipiMaxInflight = 2;
    this.smartAipiModels = {};
    this.refundSmartImage = refundGeneration;
    this.vgenvFingerprint = '';
    this.vibiFingerprint = '';
    this.interval = Math.max(3000, Number(process.env.WORKER_POLL_MS || 5000));
    this.vgenvMaxInflight = 4;
    this.vibiMaxInflight = 4;
    this.vgenvEnabled = true;
    this.vibiEnabled = true;
    this.allowProviderCharges = false;
  }

  enabled() {
    return truthy(process.env.WORKER_ENABLED, true);
  }

  start() {
    if (!this.enabled()) return;
    if (!dbConfigured()) return;
    this.stopped = false;
    this.vercelQueue.start();
    this.api888Queue.start();
    this.falImageQueue.start();
    // fal.ai image catalog and prices: shortly after start, then daily.
    const syncFal=()=>Promise.resolve().then(()=>require('./fal_image_queue.js').syncFalImageModels())
      .then(models=>models&&logActivity({category:'system',event:'fal.images_synced',provider:'falimg',message:'fal.ai image models synced',details:{total:models.length,ready:models.filter(m=>m.ready).length,...(models.diagnostics||{})}}))
      .catch(error=>logActivity({level:'warn',category:'system',event:'fal.images_sync_failed',provider:'falimg',message:String(error.message||error).slice(0,300)}));
    this.falSyncTimer=setTimeout(()=>{syncFal();this.falSyncInterval=setInterval(syncFal,24*60*60*1000);this.falSyncInterval.unref?.();},60000);
    this.falSyncTimer.unref?.();
    // Once per start: re-fetch recent 888API videos that were saved incomplete.
    setTimeout(()=>Promise.resolve().then(()=>this.api888Queue.repairIncompleteVideos(getPool())).catch(()=>{}),30000).unref?.();
    this.argoLinkQueue.start();
    this.higgsfieldQueue.start();
    this.sluiceQueue.start();
    this.longAiQueue.start();
    this.wxksaiQueue.start();
    this.vidanceeQueue.start();
    this.aividQueue.start();
    this.upscaleQueue.start();
    this.smartImageLaneActive = true;
    this.scheduleSmartImages(500);
    this.schedule(1200);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.smartImageTimer);
    this.vercelQueue.stop();
    this.api888Queue.stop();
    this.falImageQueue.stop();
    clearTimeout(this.falSyncTimer);clearInterval(this.falSyncInterval);
    this.argoLinkQueue.stop();
    this.higgsfieldQueue.stop();
    this.sluiceQueue.stop();
    this.longAiQueue.stop();
    this.wxksaiQueue.stop();
    this.vidanceeQueue.stop();
    this.aividQueue.stop();
    this.upscaleQueue.stop();
  }

  schedule(delay = this.interval) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    if (this.running) return this.schedule();
    this.running = true;
    this.lastTickStartedAt = new Date().toISOString();
    try { await this.runOnce(); }
    catch (error) { console.error('Worker tick failed:', error); }
    finally { this.running = false; this.lastTickFinishedAt = new Date().toISOString(); this.schedule(); }
  }

  scheduleSmartImages(delay = this.interval) {
    if (this.stopped) return;
    clearTimeout(this.smartImageTimer);
    this.smartImageTimer = setTimeout(() => this.tickSmartImages(), delay);
  }

  async tickSmartImages() {
    if (this.smartImageRunning) return this.scheduleSmartImages();
    this.smartImageRunning = true;
    this.lastSmartTickStartedAt = new Date().toISOString();
    try { await this.runSmartImagesOnce(); this.lastSmartTickSucceededAt = new Date().toISOString(); }
    catch (error) { console.error('Image worker tick failed:', error); }
    finally {
      this.smartImageRunning = false;
      this.lastSmartTickFinishedAt = new Date().toISOString();
      this.scheduleSmartImages();
    }
  }

  async runSmartImagesOnce(db = getPool(), settings = null) {
    const current = settings || await getProviderSettings();
    this.applySmartImageSettings(current);
    await this.syncSmartImages(db);
    await this.submitSmartImages(db, Boolean(current.allowProviderCharges));
  }

  applySmartImageSettings(settings) {
    this.smartImageAllowCharges = Boolean(settings.allowProviderCharges);
    this.smartAipiEnabled = settings.smartAipiEnabled;
    this.smartAipiMaxInflight = settings.smartAipiMaxInflight;
    this.smartAipiModels = settings.smartAipiModels;
    const fingerprint = JSON.stringify([settings.smartAipiBaseUrl, settings.smartAipiApiKey]);
    if (fingerprint !== this.smartAipiFingerprint) {
      this.smartAipiFingerprint = fingerprint;
      this.smartAipi = settings.smartAipiApiKey ? new SmartAipiClient({baseUrl: settings.smartAipiBaseUrl, apiKey: settings.smartAipiApiKey}) : null;
    }
  }

  async refreshProviderSettings() {
    const settings = await getProviderSettings();
    if (!this.creditStatusLoaded && dbConfigured()) {
      // Out-of-credits marks survive a worker restart.
      const status = await readProviderStatus(getPool()).catch(() => ({}));
      this.outOfCreditsUntil = { ...(status.outOfCredits || {}), ...(this.outOfCreditsUntil || {}) };
      this.creditStatusLoaded = true;
    }
    this.vgenvMaxInflight = settings.vgenvMaxInflight;
    this.vibiMaxInflight = settings.vibiMaxInflight;
    this.vgenvEnabled = Boolean(settings.vgenvEnabled);
    this.vibiEnabled = Boolean(settings.vibiEnabled);
    this.allowProviderCharges = settings.allowProviderCharges;
    this.applySmartImageSettings(settings);

    const vgenvFingerprint = JSON.stringify([settings.vgenvBaseUrl, settings.vgenvApiKey]);
    if (vgenvFingerprint !== this.vgenvFingerprint) {
      this.vgenvFingerprint = vgenvFingerprint;
      this.vgenv = settings.vgenvApiKey
        ? new VgenvClient({
            baseUrl: settings.vgenvBaseUrl,
            apiKey: settings.vgenvApiKey,
          })
        : null;
    }

    const vibiFingerprint = JSON.stringify([settings.vibiBaseUrl, settings.vibiApiKey]);
    if (vibiFingerprint !== this.vibiFingerprint) {
      this.vibiFingerprint = vibiFingerprint;
      this.vibi = settings.vibiApiKey
        ? new VibiClient({baseUrl:settings.vibiBaseUrl,apiKey:settings.vibiApiKey})
        : null;
    }
  }

  async syncVgenv(db) {
    if (!this.vgenv) return;

    const [rows] = await db.query(
      "SELECT * FROM generations WHERE media_type='video' AND provider='vgenv' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY created_at ASC LIMIT 100"
    );

    for (const row of rows) {
      try {
        const video = await this.vgenv.getVideo(row.provider_job_id, { v3: h3VgenvModel(row.model) !== 'base' });
        if (video.status === 'succeeded') {
          if (!video.outputUrl) throw new Error('vgenv succeeded without an output URL.');
          await db.execute(
            "UPDATE generations SET status='completed', provider_cost=COALESCE(?,provider_cost), provider_cost_unit='usd', output_url=?, poster_url=NULL, completed_at=UTC_TIMESTAMP(), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
            [video.price, video.outputUrl, row.id]
          );
          logActivity({ level: 'info', category: 'provider', event: 'job.completed', userId: row.user_id, generationId: row.id, provider: 'vgenv', message: 'Completed', details: { providerJobId: row.provider_job_id, price: video.price } });
        } else if (video.status === 'failed' || video.status === 'cancelled') {
          logActivity({ level: 'error', category: 'provider', event: 'job.provider_failed', userId: row.user_id, generationId: row.id, provider: 'vgenv', message: 'vgenv reported ' + video.status, details: video });
          await refundGeneration(
            row.id,
            'failed',
            failedMessage(video.error),
            video.price
          );
          await db.execute("UPDATE generations SET provider_cost_unit='usd' WHERE id=?", [row.id]);
        } else {
          await db.execute(
            "UPDATE generations SET status='processing', provider_cost=COALESCE(?,provider_cost), provider_cost_unit=CASE WHEN ? IS NULL THEN provider_cost_unit ELSE 'usd' END, started_at=COALESCE(started_at,UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
            [video.price, video.price, row.id]
          );
        }
      } catch (error) {
        console.error('vgenv status sync failed for', row.id, error.message);
      }
    }
  }

  // A restart while a video was being sent leaves it in 'submitting' with no
  // provider job. vgenv requests carry an idempotency key, so they are queued again.
  async recoverStaleSubmissions(db, staleMinutes = 5) {
    const [rows] = await db.query(
      "SELECT id, user_id, provider FROM generations WHERE media_type='video' AND provider='vgenv' AND status='submitting' AND provider_job_id IS NULL AND refunded_at IS NULL AND updated_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE LIMIT 20",
      [staleMinutes]
    );
    for (const row of rows) {
      if (row.provider === 'vgenv') {
        const [result] = await db.execute("UPDATE generations SET status='queued', updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND provider_job_id IS NULL", [row.id]);
        if (result.affectedRows) logActivity({ level: 'warn', category: 'provider', event: 'job.requeued', userId: row.user_id, generationId: row.id, provider: 'vgenv', message: 'Sending was interrupted (worker restart); queued again' });
      } else {
        logActivity({ level: 'warn', category: 'provider', event: 'job.submit_interrupted', userId: row.user_id, generationId: row.id, provider: row.provider, message: 'Sending was interrupted (worker restart); refunded' });
        await refundGeneration(row.id, 'submit_error', 'Generation was interrupted. Credits were refunded.', null);
      }
    }
  }

  // vgenv keeps finished videos in Alibaba Cloud storage in Shanghai, which is
  // too slow to stream from on every play (requests timed out after 10 s).
  // Each finished vgenv video is downloaded once and kept with the job, like
  // ArgoLink's; a failed copy is retried after 10 minutes.
  async copyVgenvVideos(db, { fetchImpl = fetch, timeoutMs = 5 * 60 * 1000, maxBytes = 300 * 1024 * 1024 } = {}) {
    const [rows] = await db.query(
      "SELECT id, user_id, output_url FROM generations WHERE media_type='video' AND provider='vgenv' AND status='completed' AND output_url LIKE 'https://%' ORDER BY completed_at DESC LIMIT 20"
    );
    this.vgenvCopyRetryAt = this.vgenvCopyRetryAt || new Map();
    let attempts = 0;
    for (const row of rows) {
      if (Number(this.vgenvCopyRetryAt.get(row.id) || 0) > Date.now()) continue;
      if (attempts++ >= 2) break;
      try {
        let data;
        try {
          const response = await fetchImpl(row.output_url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
          if (!response.ok) throw new Error('vgenv video download failed (HTTP ' + response.status + ').');
          if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('vgenv video is too large to keep.');
          data = Buffer.from(await response.arrayBuffer());
        } catch (first) {
          // fetch() can fail from the host where plain HTTPS over IPv4 works.
          if (/HTTP \d|too large/.test(first.message) || fetchImpl !== fetch) throw first;
          logActivity({ level: 'warn', category: 'provider', event: 'video.store_retry', userId: row.user_id, generationId: row.id, provider: 'vgenv', message: 'fetch failed; retrying over IPv4', details: errorDetails(first) });
          data = await downloadIPv4(row.output_url, { timeoutMs, maxBytes });
        }
        if (!data.length || data.length > maxBytes) throw new Error('vgenv video download was empty or too large.');
        const conn = await db.getConnection();
        try {
          await conn.beginTransaction();
          const [[current]] = await conn.execute('SELECT output_url FROM generations WHERE id=? FOR UPDATE', [row.id]);
          if (!current || current.output_url !== row.output_url) { await conn.rollback(); continue; }
          await conn.execute('DELETE FROM generation_video_chunks WHERE generation_id=?', [row.id]);
          await conn.execute('DELETE FROM generation_video_outputs WHERE generation_id=?', [row.id]);
          const storedAt=await saveVideoOutput(conn, row.id, { data, mimeType: 'video/mp4' });
          await conn.execute("UPDATE generations SET output_url=?, updated_at=UTC_TIMESTAMP() WHERE id=?", [storedAt,row.id]);
          await conn.commit();
        } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
        this.vgenvCopyRetryAt.delete(row.id);
        logActivity({ category: 'provider', event: 'video.stored', userId: row.user_id, generationId: row.id, provider: 'vgenv', message: 'Video copied from vgenv (' + Math.round(data.length / 1024) + ' KB)' });
      } catch (error) {
        this.vgenvCopyRetryAt.set(row.id, Date.now() + 10 * 60 * 1000);
        logActivity({ level: 'warn', category: 'provider', event: 'video.store_failed', userId: row.user_id, generationId: row.id, provider: 'vgenv', message: error.message, details: errorDetails(error) });
      }
    }
  }

  async syncSmartImages(db) {
    // Synchronous image requests have no resumable provider job ID. Every pass
    // marks this worker's in-flight requests as alive; a claim that has not been
    // marked for 3 minutes belongs to a worker that exited mid-request.
    // Never resubmit an ambiguous request, which could charge the provider twice.
    if (this.smartImageJobIds.size) {
      await db.query(`UPDATE generations SET updated_at=UTC_TIMESTAMP() WHERE provider='smartaipi' AND status='processing' AND id IN (?)`,
        [[...this.smartImageJobIds]]);
    }
    const [rows] = await db.query(`SELECT id,status FROM generations WHERE provider='smartaipi' AND media_type='image'
      AND ((status='processing' AND updated_at < DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MINUTE))
        OR (status='submit_error' AND refunded_at IS NULL)) LIMIT 25`);
    for (const row of rows) {
      if (row.status === 'processing') {
        if (this.smartImageJobIds.has(row.id)) continue;
        const [claim] = await db.execute("UPDATE generations SET status='submit_error',error_message='Image generation was interrupted.',updated_at=UTC_TIMESTAMP() WHERE id=? AND status='processing' AND updated_at < DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MINUTE)",[row.id]);
        if (!claim.affectedRows) continue;
      }
      await this.refundSmartImage(row.id,'submit_error','Image generation was interrupted. Credits were refunded.',null);
    }
  }

  async submitSmartImages(db, allowCharges = this.allowProviderCharges) {
    if (!allowCharges || !this.smartAipi || !this.smartAipiEnabled) return;
    // A connection-scoped lock keeps the global inflight limit consistent when
    // an isolated web worker and a standalone worker share this database.
    const conn = await db.getConnection();
    const claimed = [];
    let locked = false;
    try {
      const [[lock]] = await conn.query("SELECT GET_LOCK('cmm_smartaipi_images',0) AS acquired");
      locked = Number(lock?.acquired) === 1;
      if (!locked) return;
      const [[active]] = await conn.query("SELECT COUNT(*) AS total FROM generations WHERE provider='smartaipi' AND media_type='image' AND status IN ('submitting','submitted','processing')");
      let slots = Math.max(0, this.smartAipiMaxInflight - Number(active?.total || 0));
      if (!slots) return;
      const [queued] = await conn.query(`SELECT g.* FROM generations g
        JOIN users u ON u.id=g.user_id AND u.status='active'
        LEFT JOIN user_provider_access a ON a.user_id=g.user_id AND a.provider='smartaipi'
        WHERE g.provider='smartaipi' AND g.media_type='image' AND g.status='queued' AND COALESCE(a.enabled,1)=1
        ORDER BY g.queue_priority DESC,g.created_at ASC LIMIT 25`);
      for (const job of queued) {
        if (!slots) break;
        if (!smartImageModel(job.model) || !this.smartAipiModels[job.model]?.enabled || !(smartImageSourcePrice(this.smartAipiModels[job.model], job.image_quality || 'medium') > 0)) continue;
        const [claim] = await conn.execute("UPDATE generations SET status='processing',submitted_at=UTC_TIMESTAMP(),started_at=UTC_TIMESTAMP(),error_message=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='smartaipi' AND status='queued'",[job.id]);
        if (!claim.affectedRows) continue;
        claimed.push(job); slots -= 1;
      }
    } finally {
      try { if (locked) await conn.query("SELECT RELEASE_LOCK('cmm_smartaipi_images')"); }
      finally { conn.release(); }
      // Start every claimed job even if releasing the advisory lock failed.
      // The synchronous upstream requests run in the background so other
      // providers keep getting polled during a slow image render.
      for (const job of claimed) {
        const client = this.smartAipi;
        const task = this.processSmartImage(db, job, client).catch(error => {
          console.error('GPT image processing failed for', job.id, error.message);
        });
        this.smartImageTasks.add(task);
        this.smartImageJobIds.add(job.id);
        task.finally(() => { this.smartImageTasks.delete(task); this.smartImageJobIds.delete(job.id); });
      }
    }
  }

  async processSmartImage(db, job, client) {
    if (this.imageFailover.isOut('smartaipi') && await this.imageFailover.move(db, job)) return;
    let result;
    try {
      const [images] = await db.execute('SELECT image_data FROM generation_images WHERE generation_id=? ORDER BY position_index ASC',[job.id]);
      if (images.some(image => require('./object_storage.js').isBlobRef(image.image_data))) await require('./object_storage.js').hydrateBlobs(images,'image_data');
      // No automatic upstream retry: a timeout can still have incurred a charge.
      result = await client.generateImage({model:job.model,prompt:job.prompt,aspectRatio:job.aspect_ratio,quality:job.image_quality||'medium',
        images:images.map(image=>({data:image.image_data}))});
    } catch (error) {
      console.error('GPT image request failed for', job.id, error.message);
      logActivity({ level: 'error', category: 'provider', event: 'job.failed', userId: job.user_id, generationId: job.id, provider: 'smartaipi', message: error.message, details: errorDetails(error) });
      if (looksOutOfCredits(error)) {
        this.imageFailover.markOut('smartaipi');
        if (await this.imageFailover.move(db, job).catch(() => false)) return;
      }
      const message = error.code === 'IMAGE_ASPECT_RATIO_MISMATCH'
        ? 'The image service returned the wrong aspect ratio for your '+job.aspect_ratio+' image. Credits were refunded. Use Reuse prompt to try again.'
        : 'Image generation failed. Credits were refunded.';
      await this.refundSmartImage(job.id,'failed',message,null);
      return;
    }
    // Cloud storage when enabled; the BLOB keeps a tag.
    const imageData = await require('./object_storage.js').offloadBlob('images/'+job.id, result.data, result.mimeType).catch(() => result.data);
    // Retry only local persistence, never the paid API operation.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let conn;
      try {
        conn = await db.getConnection();
        await conn.beginTransaction();
        const [rows] = await conn.execute('SELECT status,refunded_at FROM generations WHERE id=? FOR UPDATE',[job.id]);
        if (!rows[0] || rows[0].status !== 'processing' || rows[0].refunded_at) { await conn.rollback(); return; }
        await conn.execute('INSERT INTO generation_image_outputs (generation_id,mime_type,image_data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE mime_type=VALUES(mime_type),image_data=VALUES(image_data)',[job.id,result.mimeType,imageData]);
        await conn.execute("UPDATE generations SET status='completed',output_url='db:image',completed_at=UTC_TIMESTAMP(),error_message=NULL,updated_at=UTC_TIMESTAMP() WHERE id=?",[job.id]);
        await conn.commit();
        logActivity({ category: 'provider', event: 'job.completed', userId: job.user_id, generationId: job.id, provider: 'smartaipi', message: 'Completed', details: { bytes: result.data.length } });
        return;
      } catch (error) {
        if (conn) await conn.rollback();
        if (attempt === 2) {
          console.error('GPT image storage failed for',job.id,error.message);
          await this.refundSmartImage(job.id,'failed','Generated image could not be saved. Credits were refunded.',null);
        }
      } finally { if (conn) conn.release(); }
    }
  }

  // Atlas Cloud, Yotta Labs and CreatePulse were removed. Jobs still open on them can no
  // longer be followed, so they are refunded (once; refundGeneration is idempotent).
  // Vidancee returns for Omni Flash; do not retire new Vidancee jobs.
  async retireRemovedSources(db) {
    // MiniMax H3 jobs queued under the old default source belong to vgenv.
    await db.execute("UPDATE generations SET provider='vgenv', updated_at=UTC_TIMESTAMP() WHERE provider IN ('vidancee','createpulse') AND model='minimax_h3' AND status='queued' AND refunded_at IS NULL");
    // Old Higgsfield (MCP) jobs were refunded when it was removed; 'higgsfield'
    // is the Higgsfield API source again, so only Atlas and Yotta are retired here.
    const [rows] = await db.query(`SELECT id FROM generations WHERE provider IN ('atlascloud','yotta','createpulse')
      AND status IN ('queued','submitting','submitted','processing') AND refunded_at IS NULL LIMIT 50`);
    for (const row of rows) {
      await refundGeneration(row.id, 'failed', 'This generation source was retired. Credits were refunded.', null)
        .catch(error => console.error('Refund for a retired source failed:', row.id, error.message));
    }
  }

  async imageCount(db, generationId) {
    const [[row]] = await db.query('SELECT COUNT(*) AS total FROM generation_images WHERE generation_id=?', [generationId]);
    return Number(row?.total || 0);
  }

  markOutOfCredits(key) {
    logActivity({ level: 'warn', category: 'provider', event: 'source.out_of_credits', provider: key, message: key + ' is out of credits; skipped for 10 minutes' });
    this.outOfCreditsUntil = { ...(this.outOfCreditsUntil || {}), [key]: Date.now() + 10 * 60 * 1000 };
    if (dbConfigured()) recordProviderStatus(getPool(), { outOfCredits: this.outOfCreditsUntil }).catch(() => {});
  }

  // Video jobs this queue runs: MiniMax H3 Base, Cinematic and Origin on vgenv.
  chooseProvider(job, vgenvSlots, access = {}) {
    if (!isH3Model(job.model)) return null;
    return access.vgenv !== false && this.vgenvEnabled && this.vgenv && vgenvSlots > 0 ? 'vgenv' : null;
  }

  async submitVgenv(db, job, imageCount) {
    if (!this.vgenv) throw new Error('MiniMax H3 provider is not configured.');
    if (Number(job.duration) < 4 || Number(job.duration) > 15 || !Number.isInteger(Number(job.duration))) {
      throw new Error('MiniMax H3 duration must be an integer from 4 to 15 seconds.');
    }

    let referenceImageUrls = [];
    if (job.mode === 'image-to-video' && imageCount > 0) {
      if (imageCount > 6) throw new Error('MiniMax H3 supports up to 6 reference images in this app.');
      const [images] = await db.execute(
        'SELECT position_index FROM generation_images WHERE generation_id=? ORDER BY position_index ASC',
        [job.id]
      );
      referenceImageUrls = images.map(image => providerAssetUrl(job.id, image.position_index));
    }

    // Sound clips and a reference video (Video Studio only) are uploaded to
    // vgenv as assets. Their ids are saved on the job first, so a resend after
    // a restart reuses them and repeats the same request (same idempotency key).
    const { referenceAudioAssetIds, referenceVideoAssetId } = job.mode === 'image-to-video'
      ? await this.vgenvAssets(db, job) : { referenceAudioAssetIds: [], referenceVideoAssetId: null };
    if (job.mode === 'image-to-video' && !referenceImageUrls.length && !referenceVideoAssetId) {
      throw new Error('MiniMax H3 needs a reference image or video for this job.');
    }

    const result = await this.vgenv.generateVideo({
      // The base model the customer chose; the price was charged for it.
      model: h3VgenvModel(job.model),
      tier: h3VgenvTier(job.model),
      prompt: providerPrompt(job),
      duration: Number(job.duration),
      // The customer's choice (480p or 768p); the price was charged for it.
      resolution: job.resolution === '480p' ? '480p' : '768p',
      aspectRatio: job.aspect_ratio,
      referenceImageUrls,
      referenceAudioAssetIds,
      referenceVideoAssetId,
      idempotencyKey: 'mehroz-' + job.id,
    });

    await db.execute(
      "UPDATE generations SET provider='vgenv', status='submitted', provider_job_id=?, provider_cost=?, provider_cost_unit=?, submitted_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
      [result.id, result.price, result.currency === 'CNY' ? 'cny' : 'usd', job.id]
    );
  }

  // vgenv asset ids for a job's sound clips and reference video, uploading
  // only the files not uploaded before (kept in provider_operation.vgenvAssets).
  async vgenvAssets(db, job) {
    const [rows] = await db.execute(
      "SELECT position_index, media_kind, filename, mime_type, media_data FROM generation_media WHERE generation_id=? AND media_kind IN ('audio','video') ORDER BY position_index ASC",
      [job.id]
    );
    const media = Array.isArray(rows) ? rows : [];
    await require('./object_storage.js').hydrateBlobs(media, 'media_data');
    if (!media.length) return { referenceAudioAssetIds: [], referenceVideoAssetId: null };
    let op = {};
    try { op = JSON.parse(job.provider_operation || '{}') || {}; } catch {}
    const saved = op.vgenvAssets && typeof op.vgenvAssets === 'object' ? { ...op.vgenvAssets } : {};
    let uploaded = 0;
    for (const row of media) {
      const key = String(row.position_index);
      if (saved[key]) continue;
      saved[key] = await this.vgenv.uploadAsset({ data: row.media_data, mimeType: row.mime_type, fileName: row.filename || (row.media_kind + '-' + key) });
      uploaded++;
      await db.execute('UPDATE generations SET provider_operation=?, updated_at=UTC_TIMESTAMP() WHERE id=?', [JSON.stringify({ ...op, vgenvAssets: saved }), job.id]);
    }
    if (uploaded) logActivity({ category: 'provider', event: 'vgenv.assets_uploaded', userId: job.user_id, generationId: job.id, provider: 'vgenv', message: uploaded + ' reference file(s) uploaded to vgenv', details: { assets: saved } });
    return {
      referenceAudioAssetIds: media.filter(r => r.media_kind === 'audio').map(r => saved[String(r.position_index)]),
      referenceVideoAssetId: media.filter(r => r.media_kind === 'video').map(r => saved[String(r.position_index)])[0] || null,
    };
  }

  async syncVibi(db) {
    if (!this.vibiEnabled || !this.vibi) return;
    const [rows] = await db.query(
      "SELECT * FROM generations WHERE media_type='audio' AND provider='vibi' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY updated_at ASC LIMIT 50"
    );
    for (const row of rows) {
      try {
        const job = await this.vibi.getHistoryDetail(row.provider_job_id);
        if (job.status === 'completed' && job.outputUrl) {
          await this.reconcileVibiCredits(db,row,job.creditsDeducted);
          await db.execute(
            "UPDATE generations SET status='completed', provider_cost=?, provider_cost_unit='credits', output_url=?, completed_at=UTC_TIMESTAMP(), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
            [job.creditsDeducted,job.outputUrl,row.id]
          );
        } else if (job.status === 'failed') {
          await refundGeneration(row.id,'failed','Voice generation failed during processing. Credits were refunded.',job.creditsDeducted);
          await db.execute("UPDATE generations SET provider_cost_unit='credits' WHERE id=?",[row.id]);
        } else {
          await db.execute(
            "UPDATE generations SET status='processing', provider_cost=COALESCE(?,provider_cost), provider_cost_unit='credits', started_at=COALESCE(started_at,UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
            [job.creditsDeducted||null,row.id]
          );
        }
      } catch (error) {
        console.error('Vibi voice status sync failed for', row.id, error.message);
      }
    }
  }

  async submitVibiQueued(db) {
    if (!this.vibiEnabled || !this.vibi) return;
    const [[active]] = await db.query(
      "SELECT COUNT(*) AS total FROM generations WHERE media_type='audio' AND provider='vibi' AND status IN ('submitting','submitted','processing')"
    );
    let slots=Math.max(0,this.vibiMaxInflight-Number(active?.total||0));
    if(slots<=0)return;

    const [queued]=await db.query(
      "SELECT * FROM generations WHERE media_type='audio' AND provider='vibi' AND status='queued' ORDER BY queue_priority DESC,created_at ASC LIMIT 25"
    );
    for(const job of queued){
      if(slots<=0)break;
      const [claim]=await db.execute(
        "UPDATE generations SET status='submitting',error_message=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND status='queued'",
        [job.id]
      );
      if(!claim.affectedRows)continue;
      try{
        const params=JSON.parse(job.provider_meta||'{}');
        const result=await this.vibi.textToSpeech({
          voiceId:params.voiceId,
          text:job.prompt,
          modelId:params.modelId,
          provider:params.provider,
          languageCode:params.languageCode,
          voiceSettings:params.voiceSettings||{},
          exportTranscript:false,
        });
        if(!result.id)throw new Error('Vibi did not return a task ID.');
        await db.execute(
          "UPDATE generations SET status='submitted',provider_job_id=?,submitted_at=UTC_TIMESTAMP(),started_at=COALESCE(started_at,UTC_TIMESTAMP()),updated_at=UTC_TIMESTAMP() WHERE id=?",
          [result.id,job.id]
        );
        slots-=1;
      }catch(error){
        console.error('Vibi voice submission failed for',job.id,error);
        await refundGeneration(job.id,'submit_error','Voice generation could not be submitted. Credits were refunded.',null);
      }
    }
  }

  async syncVibiClones(db){
    if(!this.vibiEnabled||!this.vibi)return;
    const [rows]=await db.query(
      "SELECT * FROM user_voice_clones WHERE provider='vibi' AND status='processing' AND provider_clone_id IS NOT NULL ORDER BY updated_at ASC LIMIT 50"
    );
    if(!rows.length)return;
    let remote=[];
    try{remote=await this.vibi.listClonedVoices()}catch(error){console.error('Vibi clone list failed:',error.message);return}
    const byId=new Map(remote.map(v=>[String(v.id),v]));
    for(const row of rows){
      const v=byId.get(String(row.provider_clone_id));if(!v)continue;
      const status=String(v.status||'processing').toLowerCase();
      await db.execute(
        "UPDATE user_voice_clones SET status=?,sample_audio_url=?,cover_url=?,error_message=?,updated_at=UTC_TIMESTAMP() WHERE id=?",
        [status==='done'?'done':(status==='failed'?'failed':'processing'),v.sample_audio_url||null,v.cover_url||null,status==='failed'?'Voice cloning failed.':null,row.id]
      );
    }
  }

  async submitVibiCloneQueue(db){
    if(!this.vibiEnabled||!this.vibi)return;
    const [rows]=await db.query(
      "SELECT * FROM user_voice_clones WHERE provider='vibi' AND status='queued' ORDER BY created_at ASC LIMIT 3"
    );
    for(const row of rows){
      const [claim]=await db.execute(
        "UPDATE user_voice_clones SET status='submitting',updated_at=UTC_TIMESTAMP() WHERE id=? AND status='queued'",
        [row.id]
      );
      if(!claim.affectedRows)continue;
      try{
        const result=await this.vibi.cloneVoice({
          data:row.sample_data,
          filename:row.sample_filename,
          mimeType:row.sample_mime_type,
          voiceName:row.voice_name,
          languageTag:row.language_tag,
          gender:row.gender,
          needNoiseReduction:true,
          previewText:row.preview_text||'Hello',
        });
        await db.execute(
          "UPDATE user_voice_clones SET provider_clone_id=?,status=?,sample_data=NULL,error_message=NULL,updated_at=UTC_TIMESTAMP() WHERE id=?",
          [String(result.id||''),String(result.status||'processing').toLowerCase()==='done'?'done':'processing',row.id]
        );
      }catch(error){
        console.error('Vibi voice clone submission failed for',row.id,error);
        const conn=await db.getConnection();
        try{
          await conn.beginTransaction();
          const [freshRows]=await conn.execute('SELECT * FROM user_voice_clones WHERE id=? FOR UPDATE',[row.id]);
          const fresh=freshRows[0];
          if(fresh){
            await conn.execute("UPDATE user_voice_clones SET status='failed',error_message=?,updated_at=UTC_TIMESTAMP() WHERE id=?",[String(error.message||'Voice clone failed').slice(0,1000),row.id]);
            if(!fresh.refunded_at && Number(fresh.credits_cost||0)>0){
              const amount=Number(fresh.credits_cost);
              await conn.execute('UPDATE users SET credits=credits+? WHERE id=?',[amount,fresh.user_id]);
              await conn.execute("INSERT INTO credit_transactions (user_id,generation_id,amount,type,note) VALUES (?,NULL,?,'voice_clone_refund',?)",[fresh.user_id,amount,'Voice cloning failed. Credits were refunded.']);
              await conn.execute('UPDATE user_voice_clones SET refunded_at=UTC_TIMESTAMP() WHERE id=?',[row.id]);
            }
          }
          await conn.commit();
        }catch(refundError){await conn.rollback();throw refundError}finally{conn.release()}
      }
    }
  }

  async runOnce() {
    const db = getPool();
    await this.refreshProviderSettings();

    await this.retireRemovedSources(db);
    await this.syncVgenv(db);
    // In the background: a slow download must not hold up the other jobs.
    if (!this.vgenvCopyRunning) {
      this.vgenvCopyRunning = true;
      this.copyVgenvVideos(db).catch(error => console.error('vgenv video copy failed:', error.message)).finally(() => { this.vgenvCopyRunning = false; });
    }
    if (!this.smartImageLaneActive) await this.syncSmartImages(db);
    await this.syncVibi(db);
    await this.syncVibiClones(db);

    if (!this.allowProviderCharges) return;

    if (!this.smartImageLaneActive) await this.submitSmartImages(db);
    await this.submitVibiQueued(db);
    await this.submitVibiCloneQueue(db);

    if (!(this.vgenvEnabled && this.vgenv)) return;

    await this.recoverStaleSubmissions(db);

    const [[active]] = await db.query(
      "SELECT COUNT(*) AS total FROM generations WHERE media_type='video' AND provider='vgenv' AND status IN ('submitting','submitted','processing')"
    );
    let vgenvSlots = Math.max(0, this.vgenvMaxInflight - Number(active?.total || 0));
    if (vgenvSlots <= 0) return;
    const [queued] = await db.query("SELECT * FROM generations WHERE media_type='video' AND provider='vgenv' AND status='queued' ORDER BY queue_priority DESC, created_at ASC LIMIT 25");

    const queuedUserIds=[...new Set(queued.map(job=>Number(job.user_id)).filter(Boolean))];
    const accessByUser=new Map();
    if(queuedUserIds.length){
      const [accessRows]=await db.query(
        'SELECT user_id,provider,enabled FROM user_provider_access WHERE user_id IN ('+
        queuedUserIds.map(()=>'?').join(',')+')',
        queuedUserIds
      );
      for(const row of accessRows){
        const userId=Number(row.user_id);
        if(!accessByUser.has(userId))accessByUser.set(userId,{});
        accessByUser.get(userId)[String(row.provider)]=Boolean(row.enabled);
      }
    }

    for (const job of queued) {
      if (vgenvSlots <= 0) break;
      const chosen = this.chooseProvider(job, vgenvSlots, accessByUser.get(Number(job.user_id)) || {});
      if (!chosen) continue;
      const count = job.mode === 'image-to-video' ? await this.imageCount(db, job.id) : 0;

      const [claim] = await db.execute(
        "UPDATE generations SET status='submitting', provider=?, error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=? AND status='queued'",
        [chosen, job.id]
      );
      if (!claim.affectedRows) continue;
      await this.submitVideoJob(db, job, count);
      vgenvSlots -= 1;
    }
  }

  // Sends one queued MiniMax H3 job to vgenv; a refusal refunds it.
  async submitVideoJob(db, job, count) {
    try {
      await this.submitVgenv(db, job, count);
      logActivity({ category: 'provider', event: 'job.submitted', userId: job.user_id, generationId: job.id, provider: 'vgenv', message: 'Sent to vgenv (' + job.model + ', ' + job.duration + 's)' });
    } catch (error) {
      console.error('Generation submission failed for', job.id, error);
      logActivity({ level: 'error', category: 'provider', event: 'job.submit_failed', userId: job.user_id, generationId: job.id, provider: 'vgenv', message: error.message, details: errorDetails(error) });
      await refundGeneration(job.id, 'submit_error', 'Generation could not be submitted. Credits were refunded.', null);
    }
  }
}

module.exports = { GenerationWorker };



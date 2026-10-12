const { VercelQueue } = require('./vercel_queue.js');
const { ArgoLinkQueue } = require('./argolink_queue.js');
const { getPool, dbConfigured } = require('./db.js');
const { VidanceeClient } = require('./provider/vidancee.js');
const { CreatePulseClient } = require('./provider/createpulse.js');
const { VgenvClient } = require('./provider/vgenv.js');
const { SmartAipiClient } = require('./provider/smartaipi.js');
const { smartImageModel, smartImageSourcePrice } = require('./smartaipi_images.js');
const { VibiClient } = require('./provider/vibi.js');
const { providerAssetUrl } = require('./provider/assets.js');
const { isCartoonJob, providerPrompt, vidanceeCreditsNeeded, looksOutOfCredits } = require('./cartoon.js');
const { recordProviderStatus, readProviderStatus } = require('./provider_usage.js');
const { moveImageJobToArgo } = require('./image_failover.js');
const { getProviderModelByPublicId } = require('./provider_models.js');
const { getProviderSettings } = require('./settings.js');
const { refundGeneration } = require('./generations.js');
const { sourceToCustomerCredits } = require('./billing.js');

function truthy(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

class GenerationWorker {
  constructor() {
    // Image Studio: AI Gateway and SmartAIPI first, ArgoLink when they run out of credits.
    this.imageFailover = {
      isOut: key => Number(this.outOfCreditsUntil?.[key] || 0) > Date.now(),
      markOut: key => this.markOutOfCredits(key),
      move: async (db, job) => moveImageJobToArgo(db, job, await getProviderSettings()),
    };
    this.vercelQueue = new VercelQueue({ failover: this.imageFailover });
    this.argoLinkQueue = new ArgoLinkQueue();
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
    this.vidancee = null;
    this.createPulse = null;
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
    this.vidanceeFingerprint = '';
    this.createPulseFingerprint = '';
    this.vgenvFingerprint = '';
    this.vibiFingerprint = '';
    this.interval = Math.max(3000, Number(process.env.WORKER_POLL_MS || 5000));
    this.createPulseMaxInflight = 3;
    this.vgenvMaxInflight = 4;
    this.vibiMaxInflight = 4;
    this.vidanceeEnabled = true;
    this.createPulseEnabled = true;
    this.vgenvEnabled = true;
    this.vibiEnabled = true;
    this.routing = 'overflow';
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
    this.argoLinkQueue.start();
    this.smartImageLaneActive = true;
    this.scheduleSmartImages(500);
    this.schedule(1200);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.smartImageTimer);
    this.vercelQueue.stop();
    this.argoLinkQueue.stop();
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
    this.routing = settings.routing;
    this.createPulseMaxInflight = settings.createPulseMaxInflight;
    this.vgenvMaxInflight = settings.vgenvMaxInflight;
    this.vibiMaxInflight = settings.vibiMaxInflight;
    this.vidanceeEnabled = Boolean(settings.vidanceeEnabled);
    this.createPulseEnabled = Boolean(settings.createPulseEnabled);
    this.vgenvEnabled = Boolean(settings.vgenvEnabled);
    this.vibiEnabled = Boolean(settings.vibiEnabled);
    this.allowProviderCharges = settings.allowProviderCharges;
    this.applySmartImageSettings(settings);

    const vidFingerprint = JSON.stringify([settings.vidanceeBaseUrl, settings.vidanceeEmail, settings.vidanceePassword]);
    if (vidFingerprint !== this.vidanceeFingerprint) {
      this.vidanceeFingerprint = vidFingerprint;
      this.vidancee = settings.vidanceeEmail && settings.vidanceePassword
        ? new VidanceeClient({
            baseUrl: settings.vidanceeBaseUrl,
            email: settings.vidanceeEmail,
            password: settings.vidanceePassword,
          })
        : null;
    }

    const cpFingerprint = JSON.stringify([settings.createPulseBaseUrl, settings.createPulseApiKey]);
    if (cpFingerprint !== this.createPulseFingerprint) {
      this.createPulseFingerprint = cpFingerprint;
      this.createPulse = settings.createPulseApiKey
        ? new CreatePulseClient({
            baseUrl: settings.createPulseBaseUrl,
            apiKey: settings.createPulseApiKey,
          })
        : null;
    }

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

  async syncVidancee(db) {
    if (!this.vidancee) return null;
    let snapshot;
    try { snapshot = await this.vidancee.getJobs(100); }
    catch (error) { console.error('Primary provider status sync failed:', error.message); return null; }
    // Admin "Usage & limits" reads the balance from here, at most once a minute.
    if (Date.now() - Number(this.vidanceeStatusSavedAt || 0) > 60000) {
      this.vidanceeStatusSavedAt = Date.now();
      recordProviderStatus(db, { vidancee: { credits: snapshot.credits, reserved: snapshot.reserved, concurrency: snapshot.concurrency,
        processing: snapshot.processing, at: new Date().toISOString() } }).catch(error => console.error('Provider status save failed:', error.message));
    }

    const allProviderJobs = [...(snapshot.active || []), ...(snapshot.jobs || [])];
    const providerById = new Map(allProviderJobs.map(job => [String(job.id), job]));
    const [rows] = await db.query(
      "SELECT * FROM generations WHERE media_type='video' AND provider='vidancee' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY created_at ASC LIMIT 100"
    );

    for (const row of rows) {
      const providerJob = providerById.get(String(row.provider_job_id));
      if (!providerJob) continue;
      if (providerJob.status === 'completed') {
        const normalized = this.vidancee.normalizeJob(providerJob);
        await db.execute(
          "UPDATE generations SET status='completed', provider_cost=?, provider_cost_unit='credits', output_url=?, poster_url=?, started_at=COALESCE(started_at, ?), completed_at=COALESCE(?, UTC_TIMESTAMP()), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
          [
            providerJob.cost_credits == null ? null : Number(providerJob.cost_credits),
            normalized.output_absolute_url,
            normalized.poster_absolute_url,
            providerJob.started_at || null,
            providerJob.completed_at || null,
            row.id,
          ]
        );
      } else if (providerJob.status === 'failed') {
        await refundGeneration(row.id, 'failed', 'Generation failed during processing. Credits were refunded.',
          providerJob.cost_credits == null ? null : Number(providerJob.cost_credits));
      } else if (providerJob.status === 'processing') {
        await db.execute(
          "UPDATE generations SET status='processing', started_at=COALESCE(started_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
          [row.id]
        );
      }
    }
    return snapshot;
  }

  async syncCreatePulse(db) {
    if (!this.createPulse) return;
    const [rows] = await db.query(
      "SELECT * FROM generations WHERE media_type='video' AND provider='createpulse' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY created_at ASC LIMIT 50"
    );
    for (const row of rows) {
      try {
        const status = await this.createPulse.getStatus(row.provider_job_id);
        if (status.status === 'done') {
          await db.execute(
            "UPDATE generations SET status='completed', output_url=?, poster_url=NULL, completed_at=UTC_TIMESTAMP(), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
            [status.url, row.id]
          );
        } else if (status.status === 'failed') {
          await refundGeneration(row.id, 'failed', 'Generation failed during processing. Credits were refunded.', status.amount);
          await db.execute("UPDATE generations SET provider_cost_unit='usd' WHERE id=?", [row.id]);
        } else {
          await db.execute(
            "UPDATE generations SET status='processing', started_at=COALESCE(started_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
            [row.id]
          );
        }
      } catch (error) {
        console.error('Overflow provider status sync failed for', row.id, error.message);
      }
    }
  }

  async syncVgenv(db) {
    if (!this.vgenv) return;

    const [rows] = await db.query(
      "SELECT * FROM generations WHERE media_type='video' AND provider='vgenv' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY created_at ASC LIMIT 100"
    );

    for (const row of rows) {
      try {
        const video = await this.vgenv.getVideo(row.provider_job_id);
        if (video.status === 'succeeded') {
          if (!video.outputUrl) throw new Error('vgenv succeeded without an output URL.');
          await db.execute(
            "UPDATE generations SET status='completed', provider_cost=COALESCE(?,provider_cost), provider_cost_unit='usd', output_url=?, poster_url=NULL, completed_at=UTC_TIMESTAMP(), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
            [video.price, video.outputUrl, row.id]
          );
        } else if (video.status === 'failed' || video.status === 'cancelled') {
          await refundGeneration(
            row.id,
            'failed',
            video.error || 'Generation failed during processing. Credits were refunded.',
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
      // No automatic upstream retry: a timeout can still have incurred a charge.
      result = await client.generateImage({model:job.model,prompt:job.prompt,aspectRatio:job.aspect_ratio,quality:job.image_quality||'medium',
        images:images.map(image=>({data:image.image_data}))});
    } catch (error) {
      console.error('GPT image request failed for', job.id, error.message);
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
    // Retry only local persistence, never the paid API operation.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let conn;
      try {
        conn = await db.getConnection();
        await conn.beginTransaction();
        const [rows] = await conn.execute('SELECT status,refunded_at FROM generations WHERE id=? FOR UPDATE',[job.id]);
        if (!rows[0] || rows[0].status !== 'processing' || rows[0].refunded_at) { await conn.rollback(); return; }
        await conn.execute('INSERT INTO generation_image_outputs (generation_id,mime_type,image_data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE mime_type=VALUES(mime_type),image_data=VALUES(image_data)',[job.id,result.mimeType,result.data]);
        await conn.execute("UPDATE generations SET status='completed',output_url='db:image',completed_at=UTC_TIMESTAMP(),error_message=NULL,updated_at=UTC_TIMESTAMP() WHERE id=?",[job.id]);
        await conn.commit();
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

  // Atlas Cloud and Higgsfield were removed. Jobs still open on them can no
  // longer be followed, so they are refunded (once; refundGeneration is idempotent).
  async retireRemovedSources(db) {
    const [rows] = await db.query(`SELECT id FROM generations WHERE provider IN ('atlascloud','higgsfield')
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

  // Cartoon jobs only go to a source that can pay for them: Vidancee needs its
  // reported balance (credits minus reserved) to cover the job, and a source that
  // just refused a job for lack of credits is skipped for 10 minutes.
  hasProviderCredits(key, job) {
    if (!isCartoonJob(job)) return true;
    if (Number(this.outOfCreditsUntil?.[key] || 0) > Date.now()) return false;
    if (key === 'vidancee' && this.vidanceeBalance != null) return this.vidanceeBalance >= vidanceeCreditsNeeded(job);
    return true;
  }

  markOutOfCredits(key) {
    this.outOfCreditsUntil = { ...(this.outOfCreditsUntil || {}), [key]: Date.now() + 10 * 60 * 1000 };
    if (key === 'vidancee') this.vidanceeBalance = 0;
    if (dbConfigured()) recordProviderStatus(getPool(), { outOfCredits: this.outOfCreditsUntil }).catch(() => {});
  }

  chooseProvider(job, imageCount, vidSlots, cpSlots, vgenvSlots, access = {}) {
    const allowed = key => access[key] !== false && this.hasProviderCredits(key, job);
    if (job.model === 'minimax_h3') {
      return allowed('vgenv') && this.vgenvEnabled && this.vgenv && vgenvSlots > 0 ? 'vgenv' : null;
    }
    const cpEligible = allowed('createpulse') && this.createPulseEnabled && this.createPulse && cpSlots > 0 && this.createPulse.supports({
      model: job.model,
      duration: Number(job.duration),
      resolution: job.resolution || '768p',
      aspectRatio: job.aspect_ratio,
      mode: job.mode,
      imageCount,
    });
    const vidEligible = allowed('vidancee') && this.vidanceeEnabled && this.vidancee && vidSlots > 0;

    if (this.routing === 'createpulse-first') {
      if (cpEligible) return 'createpulse';
      if (vidEligible) return 'vidancee';
      return null;
    }
    if (this.routing === 'balanced') {
      if (cpEligible && vidEligible) return cpSlots >= vidSlots ? 'createpulse' : 'vidancee';
      if (cpEligible) return 'createpulse';
      if (vidEligible) return 'vidancee';
      return null;
    }
    if (vidEligible) return 'vidancee';
    if (cpEligible) return 'createpulse';
    return null;
  }

  async submitVidancee(db, job) {
    let result;
    if (job.mode === 'image-to-video') {
      const [imageRows] = await db.execute(
        'SELECT filename, mime_type, image_data FROM generation_images WHERE generation_id=? ORDER BY position_index ASC',
        [job.id]
      );
      if (!imageRows.length) throw new Error('Reference images are missing for this image-to-video job.');
      result = await this.vidancee.generateImage({
        prompt: providerPrompt(job),
        model: job.model,
        duration: Number(job.duration),
        aspectRatio: job.aspect_ratio,
        quantity: 1,
        maxRetries: 3,
        images: imageRows.map(image => ({ filename: image.filename, mimeType: image.mime_type, data: image.image_data })),
      });
    } else {
      result = await this.vidancee.generateText({
        prompt: providerPrompt(job),
        model: job.model,
        duration: Number(job.duration),
        aspectRatio: job.aspect_ratio,
        quantity: 1,
      });
    }

    const providerJobId = result.job_id || (Array.isArray(result.job_ids) ? result.job_ids[0] : null);
    if (!providerJobId) throw new Error('Primary provider returned no job ID.');
    await db.execute(
      "UPDATE generations SET provider='vidancee', status='submitted', provider_job_id=?, submitted_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
      [String(providerJobId), job.id]
    );
  }

  async submitVgenv(db, job, imageCount) {
    if (!this.vgenv) throw new Error('MiniMax H3 provider is not configured.');
    if (Number(job.duration) < 4 || Number(job.duration) > 15 || !Number.isInteger(Number(job.duration))) {
      throw new Error('MiniMax H3 duration must be an integer from 4 to 15 seconds.');
    }

    let referenceImageUrls = [];
    if (job.mode === 'image-to-video') {
      if (imageCount < 1 || imageCount > 6) {
        throw new Error('MiniMax H3 supports 1 to 6 reference images in this app.');
      }
      const [images] = await db.execute(
        'SELECT position_index FROM generation_images WHERE generation_id=? ORDER BY position_index ASC',
        [job.id]
      );
      referenceImageUrls = images.map(image => providerAssetUrl(job.id, image.position_index));
    }

    const result = await this.vgenv.generateVideo({
      prompt: providerPrompt(job),
      duration: Number(job.duration),
      aspectRatio: job.aspect_ratio,
      referenceImageUrls,
      idempotencyKey: 'mehroz-' + job.id,
    });

    await db.execute(
      "UPDATE generations SET provider='vgenv', status='submitted', provider_job_id=?, provider_cost=?, provider_cost_unit='usd', submitted_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
      [result.id, result.price, job.id]
    );
  }

  async submitCreatePulse(db, job, imageCount) {
    let initImageUrl = null;
    let imageReferenceUrls = [];
    if (job.mode === 'image-to-video') {
      if (imageCount < 1 || imageCount > 6) throw new Error('Image reference count is outside the supported range.');
      const [images] = await db.execute(
        'SELECT position_index FROM generation_images WHERE generation_id=? ORDER BY position_index ASC',
        [job.id]
      );
      const urls = images.map(image => providerAssetUrl(job.id, image.position_index));
      initImageUrl = urls[0] || null;
      imageReferenceUrls = urls.slice(1, 6);
    }

    const result = await this.createPulse.generateVideo({
      prompt: providerPrompt(job),
      model: job.model,
      duration: Number(job.duration),
      aspectRatio: job.aspect_ratio,
      initImageUrl,
      imageReferenceUrls,
    });

    await db.execute(
      "UPDATE generations SET provider='createpulse', status='submitted', provider_job_id=?, provider_cost=?, provider_cost_unit='usd', submitted_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
      [result.batchId, result.cost, job.id]
    );
  }

  async reconcileVibiCredits(db,row,sourceCredits){
    const actualSource=Math.max(0,Number(sourceCredits||0));
    const actualCustomer=Number(sourceToCustomerCredits(actualSource)||0);
    const reserved=Math.max(0,Number(row.credits_cost||0));
    const delta=Math.round((reserved-actualCustomer)*100)/100;
    if(Math.abs(delta)<0.005)return actualCustomer;

    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [freshRows]=await conn.execute('SELECT * FROM generations WHERE id=? FOR UPDATE',[row.id]);
      const fresh=freshRows[0];
      if(!fresh){await conn.rollback();return actualCustomer}
      const currentReserved=Number(fresh.credits_cost||0);
      const currentDelta=Math.round((currentReserved-actualCustomer)*100)/100;
      if(Math.abs(currentDelta)>=0.005){
        await conn.execute('UPDATE users SET credits=credits+? WHERE id=?',[currentDelta,fresh.user_id]);
        await conn.execute(
          "INSERT INTO credit_transactions (user_id,generation_id,amount,type,note) VALUES (?,?,?,'generation_adjustment',?)",
          [fresh.user_id,fresh.id,currentDelta,'Adjusted to final Vibi voice cost']
        );
        await conn.execute('UPDATE generations SET credits_cost=? WHERE id=?',[actualCustomer,fresh.id]);
      }
      await conn.commit();
    }catch(error){await conn.rollback();throw error}finally{conn.release()}
    return actualCustomer;
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
    const vidSnapshot = await this.syncVidancee(db);
    await this.syncCreatePulse(db);
    await this.syncVgenv(db);
    if (!this.smartImageLaneActive) await this.syncSmartImages(db);
    await this.syncVibi(db);
    await this.syncVibiClones(db);

    if (!this.allowProviderCharges) return;

    if (!this.smartImageLaneActive) await this.submitSmartImages(db);
    await this.submitVibiQueued(db);
    await this.submitVibiCloneQueue(db);

    if (
      !(this.vidanceeEnabled && this.vidancee) &&
      !(this.createPulseEnabled && this.createPulse) &&
      !(this.vgenvEnabled && this.vgenv)
    ) return;

    this.vidanceeBalance = vidSnapshot && Number.isFinite(Number(vidSnapshot.credits))
      ? Number(vidSnapshot.credits) - Math.max(0, Number(vidSnapshot.reserved || 0))
      : null;
    let vidSlots = 0;
    if (this.vidanceeEnabled && this.vidancee && vidSnapshot) {
      const concurrency = Math.max(1, Number(vidSnapshot.concurrency || 1));
      const activeCount = Math.max(
        Number(vidSnapshot.processing || 0),
        Array.isArray(vidSnapshot.active) ? vidSnapshot.active.length : 0
      );
      vidSlots = Math.max(0, concurrency - activeCount);
    }

    let cpSlots = 0;
    if (this.createPulseEnabled && this.createPulse) {
      const [[row]] = await db.query(
        "SELECT COUNT(*) AS total FROM generations WHERE media_type='video' AND provider='createpulse' AND status IN ('submitting','submitted','processing')"
      );
      cpSlots = Math.max(0, this.createPulseMaxInflight - Number(row?.total || 0));
    }

    let vgenvSlots = 0;
    if (this.vgenvEnabled && this.vgenv) {
      const [[row]] = await db.query(
        "SELECT COUNT(*) AS total FROM generations WHERE media_type='video' AND provider='vgenv' AND status IN ('submitting','submitted','processing')"
      );
      vgenvSlots = Math.max(0, this.vgenvMaxInflight - Number(row?.total || 0));
    }

    if (vidSlots <= 0 && cpSlots <= 0 && vgenvSlots <= 0) return;
    const [queued] = await db.query("SELECT * FROM generations WHERE media_type='video' AND provider IN ('vidancee','createpulse','vgenv') AND status='queued' ORDER BY queue_priority DESC, created_at ASC LIMIT 25");

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
      if (vidSlots <= 0 && cpSlots <= 0 && vgenvSlots <= 0) break;
      const count = job.mode === 'image-to-video' ? await this.imageCount(db, job.id) : 0;
      const chosen = this.chooseProvider(job, count, vidSlots, cpSlots, vgenvSlots, accessByUser.get(Number(job.user_id))||{});
      if (!chosen) continue;

      const [claim] = await db.execute(
        "UPDATE generations SET status='submitting', provider=?, error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=? AND status='queued'",
        [chosen, job.id]
      );
      if (!claim.affectedRows) continue;

      try {
        if (chosen === 'createpulse') {
          await this.submitCreatePulse(db, job, count);
          cpSlots -= 1;
        } else if (chosen === 'vgenv') {
          await this.submitVgenv(db, job, count);
          vgenvSlots -= 1;
        } else {
          await this.submitVidancee(db, job);
          vidSlots -= 1;
          if (isCartoonJob(job) && this.vidanceeBalance != null) this.vidanceeBalance -= vidanceeCreditsNeeded(job);
        }
      } catch (error) {
        console.error('Generation submission failed for', job.id, error);
        let submitted = false;
        if (looksOutOfCredits(error)) {
          this.markOutOfCredits(chosen);
          // Cartoon Studio switches to the other source when one runs out of credits.
          const other = isCartoonJob(job) && (chosen === 'vidancee' || chosen === 'createpulse')
            ? this.chooseProvider(job, count, chosen === 'vidancee' ? 0 : vidSlots, chosen === 'createpulse' ? 0 : cpSlots, 0, accessByUser.get(Number(job.user_id)) || {})
            : null;
          if (other) {
            try {
              await db.execute("UPDATE generations SET provider=?, updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting'", [other, job.id]);
              if (other === 'createpulse') { await this.submitCreatePulse(db, job, count); cpSlots -= 1; }
              else { await this.submitVidancee(db, job); vidSlots -= 1; }
              submitted = true;
            } catch (second) {
              console.error('Fallback submission failed for', job.id, second);
              if (looksOutOfCredits(second)) this.markOutOfCredits(other);
            }
          }
        }
        if (!submitted) await refundGeneration(job.id, 'submit_error', 'Generation could not be submitted. Credits were refunded.', null);
      }
    }
  }
}

module.exports = { GenerationWorker };


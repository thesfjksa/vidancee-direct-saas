const { getPool, dbConfigured } = require('./db.js');
const { VidanceeClient } = require('./provider/vidancee.js');
const { CreatePulseClient } = require('./provider/createpulse.js');
const { providerAssetUrl } = require('./provider/assets.js');
const { getProviderSettings } = require('./settings.js');
const { refundGeneration } = require('./generations.js');

function truthy(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

class GenerationWorker {
  constructor() {
    this.running = false;
    this.timer = null;
    this.vidancee = null;
    this.createPulse = null;
    this.vidanceeFingerprint = '';
    this.createPulseFingerprint = '';
    this.interval = Math.max(3000, Number(process.env.WORKER_POLL_MS || 5000));
    this.createPulseMaxInflight = 3;
    this.routing = 'overflow';
    this.allowProviderCharges = false;
  }

  enabled() {
    return truthy(process.env.WORKER_ENABLED, true) && truthy(process.env.ALLOW_PROVIDER_CHARGES, false);
  }

  start() {
    if (!this.enabled()) {
      console.log('Generation worker disabled (WORKER_ENABLED or ALLOW_PROVIDER_CHARGES is off).');
      return;
    }
    if (!dbConfigured()) {
      console.warn('Generation worker waiting: database configuration incomplete.');
      return;
    }

    this.vidancee = createVidancee();
    this.createPulse = createCreatePulse();

    if (!this.vidancee && !this.createPulse) {
      console.warn('Generation worker waiting: no generation provider is configured.');
      return;
    }

    console.log('Generation providers:', {
      vidancee: Boolean(this.vidancee),
      createpulse: Boolean(this.createPulse),
      routing: this.routing,
      createPulseMaxInflight: this.createPulseMaxInflight,
    });
    this.schedule(1200);
  }

  schedule(delay = this.interval) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  async tick() {
    if (this.running) return this.schedule();
    this.running = true;
    try { await this.runOnce(); }
    catch (error) { console.error('Worker tick failed:', error); }
    finally { this.running = false; this.schedule(); }
  }

  async refreshProviderSettings() {
    const settings = await getProviderSettings();
    this.routing = settings.routing;
    this.createPulseMaxInflight = settings.createPulseMaxInflight;
    this.allowProviderCharges = settings.allowProviderCharges;

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
  }

  async syncVidancee(db) {
    if (!this.vidancee) return null;
    let snapshot;
    try { snapshot = await this.vidancee.getJobs(100); }
    catch (error) {
      console.error('Vidancee status sync failed:', error.message);
      return null;
    }

    const allProviderJobs = [...(snapshot.active || []), ...(snapshot.jobs || [])];
    const providerById = new Map(allProviderJobs.map((job) => [String(job.id), job]));
    const [rows] = await db.query(
      "SELECT * FROM generations WHERE provider='vidancee' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY created_at ASC LIMIT 100"
    );

    for (const row of rows) {
      const providerJob = providerById.get(String(row.provider_job_id));
      if (!providerJob) continue;
      if (providerJob.status === 'completed') {
        const normalized = this.vidancee.normalizeJob(providerJob);
        await db.execute(
          `UPDATE generations SET status='completed', provider_cost=?, provider_cost_unit='credits',
           output_url=?, poster_url=?, started_at=COALESCE(started_at, ?),
           completed_at=COALESCE(?, UTC_TIMESTAMP()), error_message=NULL,
           updated_at=UTC_TIMESTAMP() WHERE id=?`,
          [providerJob.cost_credits == null ? null : Number(providerJob.cost_credits),
           normalized.output_absolute_url, normalized.poster_absolute_url,
           providerJob.started_at || null, providerJob.completed_at || null, row.id]
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
      "SELECT * FROM generations WHERE provider='createpulse' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY created_at ASC LIMIT 50"
    );
    for (const row of rows) {
      try {
        const status = await this.createPulse.getStatus(row.provider_job_id);
        if (status.status === 'done') {
          await db.execute(
            "UPDATE generations SET status='completed', output_url=?, poster_url=NULL, completed_at=UTC_TIMESTAMP(), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
            [status.url, row.id]
          );
          await db.execute('DELETE FROM generation_images WHERE generation_id=?', [row.id]);
        } else if (status.status === 'failed') {
          await refundGeneration(row.id, 'failed', 'Generation failed during processing. Credits were refunded.', status.amount);
          await db.execute("UPDATE generations SET provider_cost_unit='usd' WHERE id=?", [row.id]);
          await db.execute('DELETE FROM generation_images WHERE generation_id=?', [row.id]);
        } else {
          await db.execute(
            "UPDATE generations SET status='processing', started_at=COALESCE(started_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
            [row.id]
          );
        }
      } catch (error) {
        console.error('CreatePulse status sync failed for', row.id, error.message);
      }
    }
  }

  async imageCount(db, generationId) {
    const [[row]] = await db.query('SELECT COUNT(*) AS total FROM generation_images WHERE generation_id=?', [generationId]);
    return Number(row?.total || 0);
  }

  chooseProvider(job, imageCount, vidSlots, cpSlots) {
    const cpEligible = this.createPulse && cpSlots > 0 && this.createPulse.supports({
      model: job.model, duration: Number(job.duration), aspectRatio: job.aspect_ratio,
      mode: job.mode, imageCount,
    });
    const vidEligible = this.vidancee && vidSlots > 0;

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
        prompt: job.prompt, model: job.model, duration: Number(job.duration),
        aspectRatio: job.aspect_ratio, quantity: 1, maxRetries: 3,
        images: imageRows.map((image) => ({ filename: image.filename, mimeType: image.mime_type, data: image.image_data })),
      });
    } else {
      result = await this.vidancee.generateText({
        prompt: job.prompt, model: job.model, duration: Number(job.duration),
        aspectRatio: job.aspect_ratio, quantity: 1,
      });
    }

    const providerJobId = result.job_id || (Array.isArray(result.job_ids) ? result.job_ids[0] : null);
    if (!providerJobId) throw new Error('Vidancee returned no job ID.');
    await db.execute(
      "UPDATE generations SET provider='vidancee', status='submitted', provider_job_id=?, submitted_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
      [String(providerJobId), job.id]
    );
    if (job.mode === 'image-to-video') await db.execute('DELETE FROM generation_images WHERE generation_id=?', [job.id]);
    console.log('Submitted generation', job.id, 'to Vidancee job', providerJobId);
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
      const urls = images.map((image) => providerAssetUrl(job.id, image.position_index));
      initImageUrl = urls[0] || null;
      imageReferenceUrls = urls.slice(1, 6);
    }

    const result = await this.createPulse.generateVideo({
      prompt: job.prompt, model: job.model, duration: Number(job.duration),
      aspectRatio: job.aspect_ratio, initImageUrl, imageReferenceUrls,
    });

    await db.execute(
      "UPDATE generations SET provider='createpulse', status='submitted', provider_job_id=?, provider_cost=?, provider_cost_unit='usd', submitted_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
      [result.batchId, result.cost, job.id]
    );
    console.log('Submitted generation', job.id, 'to CreatePulse batch', result.batchId);
  }

  async runOnce() {
    const db = getPool();
    await this.refreshProviderSettings();
    const vidSnapshot = await this.syncVidancee(db);
    await this.syncCreatePulse(db);

    // Pausing submissions does not stop polling jobs that are already running.
    if (!this.allowProviderCharges) return;
    if (!this.vidancee && !this.createPulse) return;

    let vidSlots = 0;
    if (this.vidancee && vidSnapshot) {
      const concurrency = Math.max(1, Number(vidSnapshot.concurrency || 1));
      const activeCount = Math.max(Number(vidSnapshot.processing || 0), Array.isArray(vidSnapshot.active) ? vidSnapshot.active.length : 0);
      vidSlots = Math.max(0, concurrency - activeCount);
    }

    let cpSlots = 0;
    if (this.createPulse) {
      const [[row]] = await db.query(
        "SELECT COUNT(*) AS total FROM generations WHERE provider='createpulse' AND status IN ('submitting','submitted','processing')"
      );
      cpSlots = Math.max(0, this.createPulseMaxInflight - Number(row?.total || 0));
    }

    if (vidSlots <= 0 && cpSlots <= 0) return;
    const [queued] = await db.query("SELECT * FROM generations WHERE status='queued' ORDER BY created_at ASC LIMIT 25");

    for (const job of queued) {
      if (vidSlots <= 0 && cpSlots <= 0) break;
      const count = job.mode === 'image-to-video' ? await this.imageCount(db, job.id) : 0;
      const chosen = this.chooseProvider(job, count, vidSlots, cpSlots);
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
        } else {
          await this.submitVidancee(db, job);
          vidSlots -= 1;
        }
      } catch (error) {
        console.error(chosen, 'submission failed for', job.id, error);
        await refundGeneration(job.id, 'submit_error', 'Generation could not be submitted. Credits were refunded.', null);
        await db.execute('DELETE FROM generation_images WHERE generation_id=?', [job.id]);
      }
    }
  }
}

module.exports = { GenerationWorker };

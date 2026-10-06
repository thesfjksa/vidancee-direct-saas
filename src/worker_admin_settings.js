const { getPool, dbConfigured } = require('./db.js');
const { VidanceeClient } = require('./provider/vidancee.js');
const { CreatePulseClient } = require('./provider/createpulse.js');
const { AtlasCloudClient } = require('./provider/atlascloud.js');
const { VgenvClient } = require('./provider/vgenv.js');
const { providerAssetUrl } = require('./provider/assets.js');
const { getProviderModelByPublicId } = require('./provider_models.js');
const { submitHiggsfieldGeneration, waitForHiggsfieldJob } = require('./provider/higgsfield_mcp.js');
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
    this.atlasCloud = null;
    this.vgenv = null;
    this.vidanceeFingerprint = '';
    this.createPulseFingerprint = '';
    this.atlasCloudFingerprint = '';
    this.vgenvFingerprint = '';
    this.interval = Math.max(3000, Number(process.env.WORKER_POLL_MS || 5000));
    this.createPulseMaxInflight = 3;
    this.atlasCloudMaxInflight = 4;
    this.vgenvMaxInflight = 4;
    this.higgsfieldMaxInflight = 4;
    this.higgsfieldConnected = false;
    this.vidanceeEnabled = true;
    this.createPulseEnabled = true;
    this.atlasCloudEnabled = true;
    this.vgenvEnabled = true;
    this.higgsfieldEnabled = true;
    this.routing = 'overflow';
    this.allowProviderCharges = false;
  }

  enabled() {
    return truthy(process.env.WORKER_ENABLED, true);
  }

  start() {
    if (!this.enabled()) return;
    if (!dbConfigured()) return;
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
    this.atlasCloudMaxInflight = settings.atlasCloudMaxInflight;
    this.vgenvMaxInflight = settings.vgenvMaxInflight;
    this.higgsfieldMaxInflight = settings.higgsfieldMaxInflight;
    this.higgsfieldConnected = Boolean(settings.higgsfieldOauthTokens);
    this.vidanceeEnabled = Boolean(settings.vidanceeEnabled);
    this.createPulseEnabled = Boolean(settings.createPulseEnabled);
    this.atlasCloudEnabled = Boolean(settings.atlasCloudEnabled);
    this.vgenvEnabled = Boolean(settings.vgenvEnabled);
    this.higgsfieldEnabled = Boolean(settings.higgsfieldEnabled);
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

    const atlasFingerprint = JSON.stringify([settings.atlasCloudBaseUrl, settings.atlasCloudApiKey]);
    if (atlasFingerprint !== this.atlasCloudFingerprint) {
      this.atlasCloudFingerprint = atlasFingerprint;
      this.atlasCloud = settings.atlasCloudApiKey
        ? new AtlasCloudClient({
            baseUrl: settings.atlasCloudBaseUrl,
            apiKey: settings.atlasCloudApiKey,
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
  }

  async syncVidancee(db) {
    if (!this.vidancee) return null;
    let snapshot;
    try { snapshot = await this.vidancee.getJobs(100); }
    catch (error) { console.error('Primary provider status sync failed:', error.message); return null; }

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

  async syncAtlasImages(db) {
    if (!this.atlasCloud) return;
    const [rows] = await db.query(
      "SELECT * FROM generations WHERE media_type='image' AND provider='atlascloud' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY created_at ASC LIMIT 100"
    );

    for (const row of rows) {
      try {
        const prediction = await this.atlasCloud.getPrediction(row.provider_job_id);
        if (prediction.status === 'completed') {
          const output = prediction.outputs[0] || null;
          if (!output) throw new Error('Atlas Cloud completed without an output image URL.');
          await db.execute(
            "UPDATE generations SET status='completed', output_url=?, poster_url=NULL, completed_at=UTC_TIMESTAMP(), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
            [output, row.id]
          );
        } else if (prediction.status === 'failed' || prediction.status === 'timeout') {
          await refundGeneration(
            row.id,
            'failed',
            prediction.error || 'Image generation failed. Credits were refunded.',
            null
          );
        } else {
          await db.execute(
            "UPDATE generations SET status='processing', started_at=COALESCE(started_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
            [row.id]
          );
        }
      } catch (error) {
        console.error('Atlas Cloud image status sync failed for', row.id, error.message);
      }
    }
  }

  async submitAtlasImages(db) {
    if (!this.atlasCloud || !this.atlasCloudEnabled) return;

    const [[activeRow]] = await db.query(
      "SELECT COUNT(*) AS total FROM generations WHERE media_type='image' AND provider='atlascloud' AND status IN ('submitting','submitted','processing')"
    );
    let slots = Math.max(0, this.atlasCloudMaxInflight - Number(activeRow?.total || 0));
    if (slots <= 0) return;

    const [queued] = await db.query(
      "SELECT * FROM generations WHERE media_type='image' AND provider='atlascloud' AND status='queued' ORDER BY queue_priority DESC, created_at ASC LIMIT 25"
    );

    for (const job of queued) {
      if (slots <= 0) break;

      const [claim] = await db.execute(
        "UPDATE generations SET status='submitting', provider='atlascloud', error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=? AND media_type='image' AND status='queued'",
        [job.id]
      );
      if (!claim.affectedRows) continue;

      try {
        const [images] = await db.execute(
          'SELECT position_index FROM generation_images WHERE generation_id=? ORDER BY position_index ASC',
          [job.id]
        );
        const imageUrls = images.map(image => providerAssetUrl(job.id, image.position_index));

        const result = await this.atlasCloud.generateImage({
          model: job.model,
          prompt: job.prompt,
          aspectRatio: job.aspect_ratio,
          imageUrls,
        });

        await db.execute(
          "UPDATE generations SET status='submitted', provider_job_id=?, submitted_at=UTC_TIMESTAMP(), started_at=COALESCE(started_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
          [result.id, job.id]
        );
        slots -= 1;
      } catch (error) {
        console.error('Atlas Cloud image submission failed for', job.id, error);
        await refundGeneration(job.id, 'submit_error', 'Image generation could not be submitted. Credits were refunded.', null);
      }
    }
  }

  async syncHiggsfield(db) {
    const [rows] = await db.query(
      "SELECT * FROM generations WHERE provider='higgsfield' AND status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY updated_at ASC LIMIT 12"
    );

    for (const row of rows) {
      try {
        const result = await waitForHiggsfieldJob(row.provider_job_id, 4500);
        const status = String(result.status || '').toLowerCase();

        if (['completed','succeeded','success','done'].includes(status)) {
          if (!result.outputUrl) {
            await db.execute(
              "UPDATE generations SET status='processing', provider_cost=COALESCE(?,provider_cost), provider_cost_unit='credits', updated_at=UTC_TIMESTAMP() WHERE id=?",
              [result.cost, row.id]
            );
            continue;
          }
          await db.execute(
            "UPDATE generations SET status='completed', provider_cost=COALESCE(?,provider_cost), provider_cost_unit='credits', output_url=?, poster_url=NULL, completed_at=UTC_TIMESTAMP(), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
            [result.cost, result.outputUrl, row.id]
          );
        } else if (['failed','error','cancelled','canceled','nsfw'].includes(status)) {
          await refundGeneration(
            row.id,
            'failed',
            'Generation failed during processing. Credits were refunded.',
            result.cost
          );
          await db.execute("UPDATE generations SET provider_cost_unit='credits' WHERE id=?", [row.id]);
        } else {
          await db.execute(
            "UPDATE generations SET status='processing', provider_cost=COALESCE(?,provider_cost), provider_cost_unit='credits', started_at=COALESCE(started_at,UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
            [result.cost, row.id]
          );
        }
      } catch (error) {
        console.error('Higgsfield MCP status sync failed for', row.id, error.message);
      }
    }
  }

  async submitHiggsfieldJob(db, job) {
    const mediaType = job.media_type === 'image' ? 'image' : 'video';
    const model = await getProviderModelByPublicId('higgsfield', job.model, mediaType);
    if (!model) throw new Error('The selected model is no longer available from this source.');

    const [images] = await db.execute(
      'SELECT position_index FROM generation_images WHERE generation_id=? ORDER BY position_index ASC',
      [job.id]
    );
    const referenceImageUrls = images.map(image => providerAssetUrl(job.id, image.position_index));

    const result = await submitHiggsfieldGeneration(
      model,
      {
        prompt: job.prompt,
        duration: Number(job.duration),
        resolution: job.resolution || '',
        aspectRatio: job.aspect_ratio,
        mode: job.mode,
      },
      referenceImageUrls,
    );

    if (result.outputUrl && ['completed','succeeded','success','done'].includes(String(result.status || '').toLowerCase())) {
      await db.execute(
        "UPDATE generations SET status='completed', provider_job_id=?, provider_cost=COALESCE(?,provider_cost), provider_cost_unit='credits', output_url=?, poster_url=NULL, submitted_at=COALESCE(submitted_at,UTC_TIMESTAMP()), started_at=COALESCE(started_at,UTC_TIMESTAMP()), completed_at=UTC_TIMESTAMP(), error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?",
        [result.jobId, result.cost, result.outputUrl, job.id]
      );
      return;
    }

    if (!result.jobId) throw new Error('The generation source accepted the request but returned no job ID.');

    await db.execute(
      "UPDATE generations SET status='submitted', provider_job_id=?, provider_cost=COALESCE(?,provider_cost), provider_cost_unit='credits', submitted_at=UTC_TIMESTAMP(), started_at=COALESCE(started_at,UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
      [result.jobId, result.cost, job.id]
    );
  }

  async submitHiggsfieldQueued(db, slots) {
    if (!this.higgsfieldEnabled || !this.higgsfieldConnected || slots <= 0) return slots;

    const [queued] = await db.query(
      "SELECT * FROM generations WHERE provider='higgsfield' AND status='queued' ORDER BY queue_priority DESC, created_at ASC LIMIT 25"
    );

    for (const job of queued) {
      if (slots <= 0) break;
      const [claim] = await db.execute(
        "UPDATE generations SET status='submitting', error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=? AND provider='higgsfield' AND status='queued'",
        [job.id]
      );
      if (!claim.affectedRows) continue;

      try {
        await this.submitHiggsfieldJob(db, job);
        slots -= 1;
      } catch (error) {
        console.error('Higgsfield MCP submission failed for', job.id, error);
        await refundGeneration(job.id, 'submit_error', 'Generation could not be submitted. Credits were refunded.', null);
      }
    }
    return slots;
  }

  async imageCount(db, generationId) {
    const [[row]] = await db.query('SELECT COUNT(*) AS total FROM generation_images WHERE generation_id=?', [generationId]);
    return Number(row?.total || 0);
  }

  chooseProvider(job, imageCount, vidSlots, cpSlots, vgenvSlots) {
    if (job.model === 'minimax_h3') {
      return this.vgenvEnabled && this.vgenv && vgenvSlots > 0 ? 'vgenv' : null;
    }
    const cpEligible = this.createPulseEnabled && this.createPulse && cpSlots > 0 && this.createPulse.supports({
      model: job.model,
      duration: Number(job.duration),
      resolution: job.resolution || '768p',
      aspectRatio: job.aspect_ratio,
      mode: job.mode,
      imageCount,
    });
    const vidEligible = this.vidanceeEnabled && this.vidancee && vidSlots > 0;

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
        prompt: job.prompt,
        model: job.model,
        duration: Number(job.duration),
        aspectRatio: job.aspect_ratio,
        quantity: 1,
        maxRetries: 3,
        images: imageRows.map(image => ({ filename: image.filename, mimeType: image.mime_type, data: image.image_data })),
      });
    } else {
      result = await this.vidancee.generateText({
        prompt: job.prompt,
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
      prompt: job.prompt,
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
      prompt: job.prompt,
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

  async runOnce() {
    const db = getPool();
    await this.refreshProviderSettings();

    const vidSnapshot = await this.syncVidancee(db);
    await this.syncCreatePulse(db);
    await this.syncVgenv(db);
    await this.syncAtlasImages(db);
    await this.syncHiggsfield(db);

    if (!this.allowProviderCharges) return;

    let higgsfieldSlots = 0;
    if (this.higgsfieldEnabled && this.higgsfieldConnected) {
      const [[row]] = await db.query(
        "SELECT COUNT(*) AS total FROM generations WHERE provider='higgsfield' AND status IN ('submitting','submitted','processing')"
      );
      higgsfieldSlots = Math.max(0, this.higgsfieldMaxInflight - Number(row?.total || 0));
      higgsfieldSlots = await this.submitHiggsfieldQueued(db, higgsfieldSlots);
    }

    await this.submitAtlasImages(db);

    if (
      !(this.vidanceeEnabled && this.vidancee) &&
      !(this.createPulseEnabled && this.createPulse) &&
      !(this.vgenvEnabled && this.vgenv)
    ) return;

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
    const [queued] = await db.query("SELECT * FROM generations WHERE media_type='video' AND provider<>'higgsfield' AND status='queued' ORDER BY queue_priority DESC, created_at ASC LIMIT 25");

    for (const job of queued) {
      if (vidSlots <= 0 && cpSlots <= 0 && vgenvSlots <= 0) break;
      const count = job.mode === 'image-to-video' ? await this.imageCount(db, job.id) : 0;
      const chosen = this.chooseProvider(job, count, vidSlots, cpSlots, vgenvSlots);
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
        }
      } catch (error) {
        console.error('Generation submission failed for', job.id, error);
        await refundGeneration(job.id, 'submit_error', 'Generation could not be submitted. Credits were refunded.', null);
      }
    }
  }
}

module.exports = { GenerationWorker };

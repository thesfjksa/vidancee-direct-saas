const { getPool, dbConfigured } = require('./db.js');
const { VidanceeClient } = require('./provider/vidancee.js');
const { refundGeneration } = require('./generations.js');

function providerConfigured() {
  return Boolean(
    String(process.env.VIDANCEE_EMAIL || '').trim() &&
    String(process.env.VIDANCEE_PASSWORD || '')
  );
}

function createProvider() {
  return new VidanceeClient({
    baseUrl: String(process.env.VIDANCEE_BASE_URL || 'https://vidancee.com'),
    email: String(process.env.VIDANCEE_EMAIL || '').trim(),
    password: String(process.env.VIDANCEE_PASSWORD || ''),
  });
}

class GenerationWorker {
  constructor() {
    this.running = false;
    this.timer = null;
    this.provider = null;
    this.interval = Math.max(3000, Number(process.env.WORKER_POLL_MS || 5000));
  }

  enabled() {
    const workerEnabled=/^(1|true|yes|on)$/i.test(String(process.env.WORKER_ENABLED || 'true'));
    const providerChargesAllowed=/^(1|true|yes|on)$/i.test(String(process.env.ALLOW_PROVIDER_CHARGES || 'no'));
    return workerEnabled && providerChargesAllowed;
  }

  start() {
    if (!this.enabled()) {
      console.log('Generation worker disabled (WORKER_ENABLED or ALLOW_PROVIDER_CHARGES is off).');
      return;
    }
    if (!dbConfigured() || !providerConfigured()) {
      console.warn('Generation worker waiting: database/provider configuration incomplete.');
      return;
    }
    this.provider = createProvider();
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
    try {
      await this.runOnce();
    } catch (error) {
      console.error('Worker tick failed:', error);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  async runOnce() {
    const db = getPool();
    const snapshot = await this.provider.getJobs(100);
    const allProviderJobs = [...(snapshot.active || []), ...(snapshot.jobs || [])];
    const providerById = new Map(allProviderJobs.map((job) => [String(job.id), job]));

    const [activeRows] = await db.query(
      "SELECT * FROM generations WHERE status IN ('submitted','processing') AND provider_job_id IS NOT NULL ORDER BY created_at ASC LIMIT 100"
    );

    for (const row of activeRows) {
      const providerJob = providerById.get(String(row.provider_job_id));
      if (!providerJob) continue;

      if (providerJob.status === 'completed') {
        const normalized = this.provider.normalizeJob(providerJob);
        await db.execute(
          `UPDATE generations SET status='completed', provider_cost=?, output_url=?, poster_url=?,
           started_at=COALESCE(started_at, ?), completed_at=COALESCE(?, UTC_TIMESTAMP()),
           error_message=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?`,
          [
            providerJob.cost_credits == null ? null : Number(providerJob.cost_credits),
            normalized.output_absolute_url,
            normalized.poster_absolute_url,
            providerJob.started_at || null,
            providerJob.completed_at || null,
            row.id,
          ],
        );
      } else if (providerJob.status === 'failed') {
        await refundGeneration(
          row.id,
          'failed',
          providerJob.error_message || 'Provider generation failed.',
          providerJob.cost_credits == null ? null : Number(providerJob.cost_credits),
        );
      } else if (providerJob.status === 'processing') {
        await db.execute(
          "UPDATE generations SET status='processing', started_at=COALESCE(started_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?",
          [row.id],
        );
      }
    }

    const concurrency = Math.max(1, Number(snapshot.concurrency || 1));
    const activeCount = Math.max(
      Number(snapshot.processing || 0),
      Array.isArray(snapshot.active) ? snapshot.active.length : 0,
    );
    if (activeCount >= concurrency) return;

    const [queued] = await db.query(
      "SELECT * FROM generations WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
    );
    const job = queued[0];
    if (!job) return;

    const [claim] = await db.execute(
      "UPDATE generations SET status='submitting', updated_at=UTC_TIMESTAMP() WHERE id=? AND status='queued'",
      [job.id],
    );
    if (!claim.affectedRows) return;

    try {
      const result = await this.provider.generateText({
        prompt: job.prompt,
        model: job.model,
        duration: Number(job.duration),
        aspectRatio: job.aspect_ratio,
        quantity: 1,
      });
      const providerJobId = result.job_id || (Array.isArray(result.job_ids) ? result.job_ids[0] : null);
      if (!providerJobId) throw new Error('Provider returned no job ID.');

      await db.execute(
        "UPDATE generations SET status='submitted', provider_job_id=?, submitted_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?",
        [providerJobId, job.id],
      );
      console.log('Submitted generation', job.id, 'to provider job', providerJobId);
    } catch (error) {
      console.error('Provider submission failed for', job.id, error);
      await refundGeneration(job.id, 'submit_error', 'Provider submission error: ' + error.message, null);
    }
  }
}

module.exports = { GenerationWorker, createProvider, providerConfigured };

'use strict';

// Upscaler tab jobs (fal.ai) use the AI Gateway queue's claim, heartbeat,
// restart recovery and refund rules; only the API calls differ.
const { VercelQueue } = require('./vercel_queue.js');
const { FalClient } = require('./provider/fal.js');
const { providerAssetUrl, providerOutputUrl } = require('./provider/assets.js');

function jobOptions(job) {
  try { return JSON.parse(job.generation_options || '{}') || {}; } catch { return {}; }
}

class UpscaleQueue extends VercelQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new FalClient(opts), ...options, provider: 'fal' });
    // A long 4K upscale can take a while; a refunded job that later finishes
    // would still be billed by fal.
    this.videoTimeoutMs = 3 * 60 * 60 * 1000;
  }
  apiKey(s) { return s.falApiKey || ''; }
  sourceEnabled(s) { return Boolean(s.falEnabled); }
  maxInflight(s) { return s.falMaxInflight || 3; }

  queuedSql() {
    return `SELECT g.* FROM generations g
      JOIN users u ON u.id=g.user_id AND u.status='active'
      LEFT JOIN user_provider_access a ON a.user_id=g.user_id AND a.provider='fal'
      WHERE g.provider='fal' AND g.media_type='video' AND g.status='queued' AND COALESCE(a.enabled,1)=1
      ORDER BY g.queue_priority DESC,g.created_at ASC LIMIT 20`;
  }

  // The source is a finished library video, or the clip uploaded with the job.
  async sourceUrl(db, job, options) {
    if (options.sourceGenerationId) return providerOutputUrl(options.sourceGenerationId);
    const [[media]] = await db.execute('SELECT position_index FROM generation_media WHERE generation_id=? ORDER BY position_index LIMIT 1', [job.id]);
    if (!media) throw new Error('The video to upscale is missing.');
    return providerAssetUrl(job.id, media.position_index).replace('/provider-assets/', '/provider-media/');
  }

  async submit(db, job, client) {
    const options = jobOptions(job), plan = options.upscale;
    if (!plan?.path) throw new Error('This upscale has no saved settings.');
    const op = await client.submit(plan.path, { video_url: await this.sourceUrl(db, job, options), ...plan.input });
    // Saved before the first poll, so a restart resumes this job instead of paying again.
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify(op), op.requestId.slice(0, 191), job.id]);
  }

  async pollJob(db, client, job) {
    let op = null;
    try { op = JSON.parse(job.provider_operation || 'null'); } catch {}
    if (!op?.statusUrl) throw new Error('The upscale could not be resumed.');
    const result = await client.check(op);
    if (result.state === 'done') await this.complete(db, job, await client.download(result.url));
    else if (result.state === 'failed') {
      const reason = String(result.error || '').trim().replace(/[.!]?$/, '.');
      await this.refund(job.id, 'failed', 'The video could not be upscaled' + (reason.length > 1 ? ': ' + reason : '.') + ' Credits were refunded.', null);
    } else await this.markProcessing(db, job);
  }
}

module.exports = { UpscaleQueue };

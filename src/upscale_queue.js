'use strict';

// Video Upscaler jobs (WaveSpeed) use the AI Gateway queue's claim, heartbeat,
// restart recovery and refund rules; only the API calls differ.
const { VercelQueue } = require('./vercel_queue.js');
const { WaveSpeedClient } = require('./provider/wavespeed.js');
const { providerAssetUrl, providerOutputUrl } = require('./provider/assets.js');

class UpscaleQueue extends VercelQueue {
  constructor(options = {}) {
    super({ clientFactory: opts => new WaveSpeedClient(opts), ...options, provider: 'wavespeed' });
    // A 10-minute 4K source can take a long time; a refunded job that later
    // finishes would still be billed by WaveSpeed.
    this.videoTimeoutMs = 3 * 60 * 60 * 1000;
  }
  apiKey(s) { return s.waveSpeedApiKey || ''; }
  sourceEnabled(s) { return Boolean(s.waveSpeedEnabled); }
  maxInflight(s) { return s.waveSpeedMaxInflight || 3; }

  queuedSql() {
    return `SELECT g.* FROM generations g
      JOIN users u ON u.id=g.user_id AND u.status='active'
      LEFT JOIN user_provider_access a ON a.user_id=g.user_id AND a.provider='wavespeed'
      WHERE g.provider='wavespeed' AND g.media_type='video' AND g.status='queued' AND COALESCE(a.enabled,1)=1
      ORDER BY g.queue_priority DESC,g.created_at ASC LIMIT 20`;
  }

  // The source is a finished library video, or the clip uploaded with the job.
  async sourceUrl(db, job) {
    let options = {};
    try { options = JSON.parse(job.generation_options || '{}') || {}; } catch {}
    if (options.sourceGenerationId) return providerOutputUrl(options.sourceGenerationId);
    const [[media]] = await db.execute('SELECT position_index FROM generation_media WHERE generation_id=? ORDER BY position_index LIMIT 1', [job.id]);
    if (!media) throw new Error('The video to upscale is missing.');
    return providerAssetUrl(job.id, media.position_index).replace('/provider-assets/', '/provider-media/');
  }

  async submit(db, job, client) {
    const id = await client.submit(await this.sourceUrl(db, job), job.resolution);
    // Saved before the first poll, so a restart resumes this job instead of paying again.
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify({ predictionId: id }), id.slice(0, 191), job.id]);
  }

  async pollJob(db, client, job) {
    const id = job.provider_job_id;
    if (!id) throw new Error('The upscale could not be resumed.');
    const result = await client.result(id);
    const status = String(result?.status || '');
    if (status === 'completed') {
      const url = Array.isArray(result.outputs) ? result.outputs[0] : null;
      if (!url) throw new Error('The upscaler finished without a video.');
      await this.complete(db, job, await client.download(url));
    } else if (['failed', 'cancelled', 'timeout', 'deleted'].includes(status)) {
      const reason = String(result.error || '').trim().slice(0, 200).replace(/[.!]?$/, '.');
      await this.refund(job.id, 'failed', 'The video could not be upscaled' + (reason.length > 1 ? ': ' + reason : '.') + ' Credits were refunded.', null);
    } else if (status === 'created' || status === 'processing') await this.markProcessing(db, job);
    else throw Object.assign(new Error('The upscale status was temporarily unavailable.'), { retryable: true });
  }
}

module.exports = { UpscaleQueue };

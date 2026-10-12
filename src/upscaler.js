'use strict';

// Video Upscaler: ByteDance Video Upscaler on WaveSpeed. A customer upscales a
// finished video from their library, or an uploaded clip, to 1080p, 2K or 4K.
// WaveSpeed bills per second of the source (at most 600 s per job); customers
// pay that USD amount times the Admin credits-per-USD rate.
const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { getPlanProfile } = require('./plans.js');
const { mp4Seconds } = require('./vercel_models.js');

const UPSCALE_MODEL = 'video_upscaler';
const RESOLUTIONS = [
  { id: '1080p', label: '1080p', usdPerSecond: 0.0072 },
  { id: '2k', label: '2K', usdPerSecond: 0.0144 },
  { id: '4k', label: '4K', usdPerSecond: 0.0288 },
];
const MAX_BILLED_SECONDS = 600;
const UPLOAD_TYPES = ['video/mp4', 'video/quicktime'];

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

function upscaleQuote(seconds, resolution, creditsPerUsd) {
  const tier = RESOLUTIONS.find(r => r.id === String(resolution || ''));
  if (!tier) fail('Choose 1080p, 2K or 4K.');
  const length = Number(seconds);
  if (!Number.isFinite(length) || length <= 0) fail('The video length could not be read.');
  const billedSeconds = Math.min(MAX_BILLED_SECONDS, Math.ceil(length - 1e-9));
  const sourceUsd = billedSeconds * tier.usdPerSecond;
  const factor = Number(creditsPerUsd);
  if (!Number.isFinite(factor) || factor <= 0) fail('The upscaler price is not configured.', 503);
  return { resolution: tier.id, billedSeconds, sourceUsd, cost: Math.ceil(sourceUsd * factor - 1e-9) };
}

function publicUpscalerConfig(enabled, creditsPerUsd) {
  return {
    enabled: Boolean(enabled),
    maxBilledSeconds: MAX_BILLED_SECONDS,
    uploadTypes: UPLOAD_TYPES,
    resolutions: RESOLUTIONS.map(r => ({ id: r.id, label: r.label, creditsPerSecond: r.usdPerSecond * Number(creditsPerUsd || 0) })),
  };
}

function isUpscaleJob(row) {
  try { return JSON.parse(row?.generation_options || '{}').studio === 'upscale'; } catch { return false; }
}

// Length of a finished library video: its saved duration, or the MP4 header
// of the stored file when the duration was not recorded.
async function sourceSeconds(conn, row) {
  if (Number(row.duration) > 0) return Number(row.duration);
  if (row.output_url !== 'db:video') return null;
  const [chunks] = await conn.execute('SELECT video_data FROM generation_video_chunks WHERE generation_id=? AND chunk_index<2 ORDER BY chunk_index', [row.id]);
  return mp4Seconds(Buffer.concat(chunks.map(c => c.video_data)));
}

// source: {generationId} for a library video, or {video:{data,mimeType,filename}} for an upload.
async function createUpscaleJob(userId, { resolution, source }, creditsPerUsd) {
  const db = getPool();
  const conn = await db.getConnection();
  const id = crypto.randomUUID();
  try {
    await conn.beginTransaction();
    const [[user]] = await conn.execute('SELECT id,credits,status,plan_code FROM users WHERE id=? FOR UPDATE', [userId]);
    if (!user || user.status !== 'active') fail('User account is unavailable.', 403);
    const plan = getPlanProfile(user.plan_code);
    const [[active]] = await conn.execute("SELECT COUNT(*) AS total FROM generations WHERE user_id=? AND status IN ('queued','submitting','submitted','processing')", [userId]);
    if (Number(active?.total || 0) >= plan.concurrency) {
      fail(plan.code ? plan.name + ' allows up to ' + plan.concurrency + ' simultaneous generations.' : 'Choose a plan to run more than one generation at a time.', 429);
    }

    let seconds, aspectRatio = '16:9', prompt = 'Uploaded video', options = { studio: 'upscale' };
    if (source?.generationId) {
      const [[row]] = await conn.execute(
        "SELECT * FROM generations WHERE id=? AND user_id=? AND media_type='video' AND status='completed' AND output_url IS NOT NULL LIMIT 1",
        [String(source.generationId), userId]);
      if (!row) fail('Choose a finished video from your library.', 404);
      seconds = await sourceSeconds(conn, row);
      if (!seconds) fail('The length of this video could not be read.');
      aspectRatio = row.aspect_ratio || aspectRatio;
      prompt = String(row.prompt || 'Library video');
      options.sourceGenerationId = row.id;
    } else if (source?.video) {
      const video = source.video;
      if (!UPLOAD_TYPES.includes(String(video.mimeType || ''))) fail('Upload an MP4 or MOV video.');
      seconds = mp4Seconds(video.data);
      if (!seconds) fail('The length of this video could not be read. Upload an MP4 or MOV file.');
      prompt = String(video.filename || 'Uploaded video');
    } else fail('Choose a video to upscale.');

    const quote = upscaleQuote(seconds, resolution, creditsPerUsd);
    if (Number(user.credits) < quote.cost) fail('Not enough credits.', 402);
    options = { ...options, targetResolution: quote.resolution, sourceSeconds: Math.round(seconds * 100) / 100 };

    await conn.execute(
      `INSERT INTO generations
       (id, user_id, provider, queue_priority, mode, model, duration, resolution, aspect_ratio, prompt, status, credits_cost, provider_cost, provider_cost_unit, generation_options)
       VALUES (?, ?, 'wavespeed', ?, 'upscale', ?, ?, ?, ?, ?, 'queued', ?, ?, 'usd', ?)`,
      [id, userId, plan.queuePriority, UPSCALE_MODEL, quote.billedSeconds, quote.resolution, aspectRatio, prompt.slice(0, 4000),
        quote.cost, quote.sourceUsd, JSON.stringify(options)]);
    if (source?.video) {
      await conn.execute(
        `INSERT INTO generation_media (generation_id,position_index,media_kind,media_role,filename,mime_type,media_data) VALUES (?,0,'video','video',?,?,?)`,
        [id, String(source.video.filename || 'video.mp4').slice(0, 255), source.video.mimeType, source.video.data]);
    }
    await conn.execute('UPDATE users SET credits = credits - ? WHERE id = ?', [quote.cost, userId]);
    await conn.execute("INSERT INTO credit_transactions (user_id, generation_id, amount, type, note) VALUES (?, ?, ?, 'generation_debit', ?)",
      [userId, id, -quote.cost, 'Reserved for video upscaling']);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  const [rows] = await db.execute('SELECT * FROM generations WHERE id = ?', [id]);
  return rows[0];
}

module.exports = { UPSCALE_MODEL, RESOLUTIONS, MAX_BILLED_SECONDS, UPLOAD_TYPES, upscaleQuote, publicUpscalerConfig, isUpscaleJob, sourceSeconds, createUpscaleJob };

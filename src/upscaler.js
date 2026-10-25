'use strict';

// Upscaler tab: a customer upscales a finished video from their library, or an
// uploaded clip, to 1080p, 2K or 4K with the ByteDance upscaler on fal.ai.
// Customers pay fal's USD price times the fal credits-per-USD rate.
const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { logActivity } = require('./activity_log.js');
const { getPlanProfile } = require('./plans.js');
const { mp4Seconds } = require('./vercel_models.js');
const { planUpscale, upscaleCredits, dimensionsFor, mp4Dimensions } = require('./enhance.js');

const UPSCALE_MODEL = 'video_upscaler';
const RESOLUTIONS = [{ id: '1080p', label: '1080p' }, { id: '2k', label: '2K' }, { id: '4k', label: '4K' }];
const UPLOAD_TYPES = ['video/mp4', 'video/quicktime'];

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// source: {width, height, seconds}. Returns the fal plan and the customer price.
function upscaleQuote(source, resolution, creditsPerUsd) {
  const tier = RESOLUTIONS.find(r => r.id === String(resolution || ''));
  if (!tier) fail('Choose 1080p, 2K or 4K.');
  if (!(Number(source?.seconds) > 0)) fail('The video length could not be read.');
  if (!(Number(creditsPerUsd) > 0)) fail('The upscaler price is not configured.', 503);
  const plan = planUpscale(source, tier.id);
  if (!plan) fail('This video is already ' + tier.label + ' or larger. Choose a higher resolution.');
  return { resolution: tier.id, plan, sourceUsd: plan.usd, cost: upscaleCredits(plan, creditsPerUsd) };
}

function publicUpscalerConfig(enabled) {
  return {
    enabled: Boolean(enabled),
    uploadTypes: UPLOAD_TYPES,
    resolutions: RESOLUTIONS,
  };
}

// Length of a finished library video: its saved duration, or the MP4 header
// of the stored file when the duration was not recorded.
async function sourceSeconds(conn, row) {
  if (Number(row.duration) > 0) return Number(row.duration);
  if (String(row.output_url || '').startsWith('r2:')) {
    const { configuredStorage } = require('./object_storage.js');
    const store = await configuredStorage({ requireEnabled: false });
    if (!store) return null;
    const head = await store.get(String(row.output_url).slice(3), { range: 'bytes=0-2097151' });
    return mp4Seconds(Buffer.from(await head.arrayBuffer()));
  }
  if (row.output_url !== 'db:video') return null;
  const [chunks] = await conn.execute('SELECT video_data FROM generation_video_chunks WHERE generation_id=? AND chunk_index<2 ORDER BY chunk_index', [row.id]);
  return mp4Seconds(Buffer.concat(chunks.map(c => c.video_data)));
}

async function libraryVideo(conn, userId, generationId) {
  const [[row]] = await conn.execute(
    "SELECT * FROM generations WHERE id=? AND user_id=? AND media_type='video' AND status='completed' AND output_url IS NOT NULL LIMIT 1",
    [String(generationId || ''), userId]);
  if (!row) fail('Choose a finished video from your library.', 404);
  const seconds = await sourceSeconds(conn, row);
  if (!seconds) fail('The length of this video could not be read.');
  return { row, source: { ...dimensionsFor(row.resolution, row.aspect_ratio), seconds } };
}

function uploadedVideo(video) {
  if (!UPLOAD_TYPES.includes(String(video?.mimeType || ''))) fail('Upload an MP4 or MOV video.');
  const seconds = mp4Seconds(video.data), size = mp4Dimensions(video.data);
  if (!seconds || !size) fail('The size or length of this video could not be read. Upload an MP4 or MOV file.');
  return { ...size, seconds };
}

// Price shown before submitting: a library video, or an upload's size and length.
async function quoteForCustomer(userId, body, settings) {
  const opts = settings.falCustomerCreditsPerUsd;
  if (body.sourceGenerationId) {
    const { source } = await libraryVideo(getPool(), userId, body.sourceGenerationId);
    return upscaleQuote(source, body.resolution, opts);
  }
  const source = { width: Number(body.width), height: Number(body.height), seconds: Number(body.seconds) };
  if (!(source.width > 0 && source.height > 0)) fail('The video size could not be read.');
  return upscaleQuote(source, body.resolution, opts);
}

// source: {generationId} for a library video, or {video:{data,mimeType,filename}} for an upload.
async function createUpscaleJob(userId, { resolution, source }, settings) {
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

    let video, aspectRatio = '16:9', prompt = 'Uploaded video', options = { studio: 'upscale' };
    if (source?.generationId) {
      const found = await libraryVideo(conn, userId, source.generationId);
      video = found.source;
      aspectRatio = found.row.aspect_ratio || aspectRatio;
      prompt = String(found.row.prompt || 'Library video');
      options.sourceGenerationId = found.row.id;
    } else if (source?.video) {
      video = uploadedVideo(source.video);
      prompt = String(source.video.filename || 'Uploaded video');
    } else fail('Choose a video to upscale.');

    const quote = upscaleQuote(video, resolution, settings.falCustomerCreditsPerUsd);
    if (Number(user.credits) < quote.cost) fail('Not enough credits.', 402);
    options = { ...options, targetResolution: quote.resolution, sourceSeconds: Math.round(video.seconds * 100) / 100, upscale: quote.plan };

    await conn.execute(
      `INSERT INTO generations
       (id, user_id, provider, queue_priority, mode, model, duration, resolution, aspect_ratio, prompt, status, credits_cost, provider_cost, provider_cost_unit, generation_options)
       VALUES (?, ?, 'fal', ?, 'upscale', ?, ?, ?, ?, ?, 'queued', ?, ?, 'usd', ?)`,
      [id, userId, plan.queuePriority, UPSCALE_MODEL, Math.ceil(video.seconds - 1e-9), quote.resolution, aspectRatio, prompt.slice(0, 4000),
        quote.cost, quote.sourceUsd, JSON.stringify(options)]);
    if (source?.video) {
      await conn.execute(
        `INSERT INTO generation_media (generation_id,position_index,media_kind,media_role,filename,mime_type,media_data) VALUES (?,0,'video','video',?,?,?)`,
        [id, String(source.video.filename || 'video.mp4').slice(0, 255), source.video.mimeType,
          await require('./object_storage.js').offloadBlob('media/' + id, source.video.data, source.video.mimeType)]);
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
  const job = rows[0];
  logActivity({ category: 'generation', event: 'upscale.created', userId, generationId: id, provider: 'fal',
    message: 'Upscale to ' + job?.resolution + ' · ' + job?.duration + 's · ' + job?.credits_cost + ' credits', details: { options: job?.generation_options } });
  return job;
}

module.exports = { UPSCALE_MODEL, RESOLUTIONS, UPLOAD_TYPES, upscaleQuote, publicUpscalerConfig, sourceSeconds, quoteForCustomer, createUpscaleJob };

'use strict';

const crypto = require('node:crypto');
const { withAividLock, operation } = require('./aivid_queue.js');
const { saveVideoOutput } = require('./video_outputs.js');
const { hydrateBlobs } = require('./object_storage.js');
const { isCompleteMp4 } = require('./mp4_trim.js');

const TTL_MS = 15 * 60 * 1000;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const PACKET_PREFIX = 'CMMTOOLS_AIVID_V1 ';
const problem = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const signature = (secret, value) => crypto.createHmac('sha256', secret).update('aivid-manual-v1:' + value).digest('base64url');

function signPacket(secret, id, nonce, now = Date.now()) {
  const value = [id, nonce, now + TTL_MS].join('.');
  return value + '.' + signature(secret, value);
}

function verifyPacket(secret, token, now = Date.now()) {
  const parts = /^([0-9a-f-]{36})\.([a-f0-9]{32})\.(\d{13})\.([\w-]{43})$/.exec(token || '');
  if (!secret || !parts || Number(parts[3]) <= now) return null;
  const [, id, nonce, expiry, sig] = parts;
  const expected = signature(secret, [id, nonce, expiry].join('.'));
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? { id, nonce } : null;
}

async function findJob(db, id, lock = false) {
  const [[job]] = await db.execute(
    "SELECT * FROM generations WHERE id=? AND provider='aivid' AND media_type='video'" + (lock ? ' FOR UPDATE' : ''), [id]);
  return job;
}

function activeStage(job) {
  if (job?.status !== 'processing' || job.provider_job_id || job.refunded_at) return null;
  const { stage } = operation(job);
  return ['manual_pending', 'manual_handoff'].includes(stage) ? stage : null;
}

async function copyRequest(db, secret, id) {
  const result = await withAividLock(db, async conn => {
    const job = await findJob(conn, id);
    if (!activeStage(job)) {
      throw problem(409, 'Only active manual video requests can be copied.');
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const [updated] = await conn.execute(
      "UPDATE generations SET provider_operation=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND status='processing' AND refunded_at IS NULL",
      [JSON.stringify({ stage: 'manual_handoff', nonce }), id]);
    if (!updated.affectedRows) throw problem(409, 'This video request has already finished.');
    return { clipboard: PACKET_PREFIX + signPacket(secret, id, nonce), expiresInMinutes: TTL_MS / 60000 };
  });
  if (!result) throw problem(409, 'Another AIVID operation is running. Try Copy request again shortly.');
  return result;
}

async function readPacket(db, secret, authorization, position) {
  const token = /^Bearer (\S+)$/.exec(authorization || '')?.[1];
  const proof = verifyPacket(secret, token);
  const job = proof && await findJob(db, proof.id);
  if (activeStage(job) !== 'manual_handoff' || operation(job).nonce !== proof.nonce) {
    throw problem(403, 'This request has expired or changed. Copy it again in CMMTools Admin.');
  }
  if (position !== undefined) {
    const [[file]] = await db.execute(
      'SELECT mime_type,media_data FROM generation_media WHERE generation_id=? AND position_index=?',
      [job.id, position]);
    if (!file) throw problem(404, 'Reference file was not found.');
    try { await hydrateBlobs(file, 'media_data'); }
    catch { throw problem(502, 'CMMTools could not read the saved reference file.'); }
    return file;
  }
  const [rows] = await db.execute(
    'SELECT position_index,media_kind,mime_type FROM generation_media WHERE generation_id=? ORDER BY position_index',
    [job.id]);
  return {
    id: job.id, model: job.model, prompt: job.prompt, duration: Number(job.duration),
    resolution: job.resolution, aspectRatio: job.aspect_ratio, sourceCredits: Number(job.provider_cost),
    references: rows.map(row => ({ position: Number(row.position_index), kind: row.media_kind, mimeType: row.mime_type })),
  };
}

async function readMp4(req) {
  if (String(req.headers['content-type'] || '').split(';')[0] !== 'video/mp4') {
    throw problem(415, 'Choose the finished MP4 file downloaded from AIVID.');
  }
  if (Number(req.headers['content-length']) > MAX_VIDEO_BYTES) throw problem(413, 'MP4 files must be 100 MB or smaller.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_VIDEO_BYTES) {
      req.resume();
      throw problem(413, 'MP4 files must be 100 MB or smaller.');
    }
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks, size);
  if (!isCompleteMp4(data)) throw problem(400, 'This file is not a complete MP4. Download the finished video and try again.');
  return data;
}

async function deliverVideo(db, id, data, save = saveVideoOutput) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const job = await findJob(conn, id, true);
    if (job?.status === 'completed' && operation(job).stage === 'manual_delivered') {
      await conn.rollback();
      return { completed: true };
    }
    if (activeStage(job) !== 'manual_handoff') throw problem(409, 'Copy this active manual request before delivering its video.');
    const storage = await save(conn, id, { mimeType: 'video/mp4', data });
    await conn.execute(
      "UPDATE generations SET status='completed',output_url=?,provider_operation=?,completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),error_message=NULL WHERE id=?",
      [storage, JSON.stringify({ stage: 'manual_delivered' }), id]);
    await conn.commit();
    return { completed: true };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { copyRequest, readPacket, readMp4, deliverVideo, activeStage, signPacket, verifyPacket };

'use strict';

// Gallery previews: small WebP copies of generated images, created on first
// view and stored beside the original. The full image stays untouched for the
// preview dialog and downloads. sharp is optional: without it, callers fall
// back to serving the original image.

const THUMB_WIDTH = Math.max(320, Math.min(1600, Number(process.env.IMAGE_THUMB_WIDTH || 768)));
const THUMB_QUALITY = Math.max(40, Math.min(95, Number(process.env.IMAGE_THUMB_QUALITY || 76)));
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 20000;
const MAX_CONCURRENT = Math.max(1, Number(process.env.IMAGE_THUMB_CONCURRENCY || 2));

let sharpModule;
function loadSharp() {
  if (sharpModule !== undefined) return sharpModule;
  try {
    sharpModule = require('sharp');
    // Shared hosting: keep libvips to one worker thread and no decoded-image cache.
    sharpModule.concurrency(1);
    sharpModule.cache(false);
  } catch (error) {
    console.warn('[thumbnails] sharp unavailable; galleries will use full-size images:', error?.message || error);
    sharpModule = null;
  }
  return sharpModule;
}

function thumbnailsAvailable() {
  return Boolean(loadSharp());
}

let running = 0;
const waiting = [];
async function withSlot(task) {
  if (running >= MAX_CONCURRENT) await new Promise(resolve => waiting.push(resolve));
  running++;
  try { return await task(); } finally {
    running--;
    waiting.shift()?.();
  }
}

async function renderThumbnail(source) {
  const sharp = loadSharp();
  if (!sharp) return null;
  const { data, info } = await sharp(source, { limitInputPixels: 64e6, failOn: 'error' })
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return { mimeType: 'image/webp', width: info.width, height: info.height, data };
}

async function fetchRemoteImage(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
  if (!response.ok || !response.body) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SOURCE_BYTES) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_SOURCE_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function loadSource(db, row) {
  if (row.output_url === 'db:image') {
    const [[output]] = await db.execute('SELECT image_data FROM generation_image_outputs WHERE generation_id=?', [row.id]);
    if (output) await require('./object_storage.js').hydrateBlobs(output, 'image_data');
    return output?.image_data || null;
  }
  return fetchRemoteImage(row.output_url);
}

const inflight = new Map();

// Returns the stored thumbnail, creating it on first request. Resolves to null
// when thumbnails are unavailable or the source cannot be processed.
async function getImageThumbnail(db, row) {
  const [[stored]] = await db.execute(
    'SELECT mime_type,image_data FROM generation_image_thumbnails WHERE generation_id=? AND width_limit=?',
    [row.id, THUMB_WIDTH]
  );
  if (stored) return { mimeType: stored.mime_type, data: stored.image_data };
  if (!thumbnailsAvailable()) return null;

  if (inflight.has(row.id)) return inflight.get(row.id);
  const work = withSlot(async () => {
    const source = await loadSource(db, row);
    if (!source) return null;
    const thumb = await renderThumbnail(source);
    if (!thumb) return null;
    await db.execute(
      `INSERT INTO generation_image_thumbnails (generation_id,width_limit,mime_type,width,height,image_data)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE mime_type=VALUES(mime_type),width=VALUES(width),height=VALUES(height),image_data=VALUES(image_data)`,
      [row.id, THUMB_WIDTH, thumb.mimeType, thumb.width, thumb.height, thumb.data]
    );
    return { mimeType: thumb.mimeType, data: thumb.data };
  }).catch(error => {
    console.warn('[thumbnails] could not create preview for', row.id, error?.message || error);
    return null;
  }).finally(() => inflight.delete(row.id));
  inflight.set(row.id, work);
  return work;
}

module.exports = { THUMB_WIDTH, thumbnailsAvailable, renderThumbnail, getImageThumbnail };

const test = require('node:test');
const assert = require('node:assert/strict');
const { THUMB_WIDTH, thumbnailsAvailable, renderThumbnail, getImageThumbnail } = require('../src/image_thumbnails.js');

test('gallery previews are small WebP images capped at the preview width', { skip: !thumbnailsAvailable() && 'sharp is not installed' }, async () => {
  const sharp = require('sharp');
  const width = 1536, height = 2048, raw = Buffer.alloc(width * height * 3);
  require('node:crypto').randomFillSync(raw);
  const original = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const thumb = await renderThumbnail(original);
  assert.equal(thumb.mimeType, 'image/webp');
  assert.equal(thumb.width, THUMB_WIDTH);
  assert.equal(thumb.height, Math.round(height * THUMB_WIDTH / width));
  assert.ok(thumb.data.length < original.length / 5);

  const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#06a' } }).png().toBuffer();
  assert.equal((await renderThumbnail(small)).width, 300);
});

test('previews are created once, stored, and reused', { skip: !thumbnailsAvailable() && 'sharp is not installed' }, async () => {
  const sharp = require('sharp');
  const original = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#0a7' } }).png().toBuffer();
  const stored = new Map(); let sourceReads = 0;
  const db = { async execute(sql, args) {
    if (sql.includes('FROM generation_image_thumbnails')) return [[stored.get(args[0])].filter(Boolean)];
    if (sql.includes('FROM generation_image_outputs')) { sourceReads++; return [[{ image_data: original }]]; }
    if (sql.includes('INSERT INTO generation_image_thumbnails')) { stored.set(args[0], { mime_type: args[2], image_data: args[5] }); return [{ affectedRows: 1 }]; }
    throw new Error('Unexpected SQL: ' + sql);
  } };
  const row = { id: 'a1b2c3d4-0000-4000-8000-000000000000', output_url: 'db:image' };
  const [first, concurrent] = await Promise.all([getImageThumbnail(db, row), getImageThumbnail(db, row)]);
  assert.equal(first.mimeType, 'image/webp');
  assert.equal(concurrent, first);
  assert.equal(sourceReads, 1);
  const again = await getImageThumbnail(db, row);
  assert.equal(again.data.length, first.data.length);
  assert.equal(sourceReads, 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteGateway } = require('../src/vercel_models.js');

// An MP4 with an 'mvhd' header saying `seconds` long (enough for mp4Seconds).
function mp4(seconds) {
  const b = Buffer.alloc(64);
  b.write('mvhd', 8); b[12] = 0; b.writeUInt32BE(1000, 24); b.writeUInt32BE(Math.round(seconds * 1000), 28);
  return b;
}
// Seedance 2.5 on ArgoLink bills reference video seconds too, at 0.6x per second.
const model = { mediaType: 'video', adapterSupported: true, durations: [5, 10, 15], resolutions: ['480p'], aspectRatios: ['9:16'],
  defaultAspectRatio: '9:16', defaultDuration: 5, defaultResolution: '480p', inputLimits: { video: { max_duration_seconds: 30 } },
  pricing: { reference_videos_billed: true, reference_video_multiplier: 0.6, video_duration_pricing: [{ resolution: '480p', cost_per_second: 0.1 }] } };
const body = { duration: 15, resolution: '480p', aspectRatio: '9:16' };

test('the price shown before generating includes reference video seconds, like the charge', () => {
  const charged = quoteGateway(model, { ...body, videos: [{ data: mp4(5.2) }, { data: mp4(9.5) }] }, 6720).cost;
  const preview = quoteGateway(model, { ...body, previewVideoSeconds: [5.2, 9.5] }, 6720).cost;
  const withoutVideos = quoteGateway(model, body, 6720).cost;
  assert.equal(preview, charged);
  assert.ok(charged > withoutVideos);
  // A length the page could not read counts as the longest clip, as the charge does for an unreadable file.
  assert.equal(quoteGateway(model, { ...body, previewVideoSeconds: [null] }, 6720).cost,
    quoteGateway(model, { ...body, videos: [{ data: Buffer.from('no header') }] }, 6720).cost);
  // Uploaded files always win over preview lengths.
  assert.equal(quoteGateway(model, { ...body, videos: [{ data: mp4(5.2) }, { data: mp4(9.5) }], previewVideoSeconds: [1] }, 6720).cost, charged);
});

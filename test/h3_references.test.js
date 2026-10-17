const test = require('node:test');
const assert = require('node:assert/strict');

// The test database is installed before the modules that use it are loaded.
let execute = async sql => { throw new Error('Unexpected test SQL: ' + sql); };
const db = { execute: (...a) => execute(...a), query: (...a) => execute(...a),
  async getConnection() { return { execute: db.execute, query: db.query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} }; } };
const dbModule = require('../src/db.js');
Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true });

const { validateH3Media, H3_AUDIO_CAPABILITY, H3_VIDEO_CAPABILITY } = require('../src/h3_references.js');
const { createGenerationForUser } = require('../src/generations.js');
const { VgenvClient } = require('../src/provider/vgenv.js');
const { GenerationWorker } = require('../src/worker_admin_settings.js');

// A silent mono 16-bit WAV of the given length.
function wav(seconds, rate = 8000) {
  const data = Math.round(seconds * rate) * 2, b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}
const clip = (seconds = 5) => ({ filename: 'a.wav', mimeType: 'audio/wav', data: wav(seconds) });
const mp4 = (seconds = 6) => ({ filename: 'm.mp4', mimeType: 'video/mp4', data: Buffer.from('mp4:' + seconds) });
const mp4Seconds = data => Number(String(data).split(':')[1]);
const png = { filename: 'i.png', mimeType: 'image/png', data: Buffer.from('png') };

test('MiniMax H3 takes up to 2 sound clips and one MP4 reference video', () => {
  assert.deepEqual([H3_AUDIO_CAPABILITY.max, H3_VIDEO_CAPABILITY.max, H3_VIDEO_CAPABILITY.formats], [2, 1, ['mp4']]);
  const v = (a, vids, imgs) => validateH3Media(a, vids, imgs, { mp4Seconds });
  v([], [], 0);
  v([clip(2), clip(15)], [], 1);
  v([], [mp4(10)], 0); // a video alone is fine
  v([clip()], [mp4()], 0); // sound with the video and no image
  assert.throws(() => v([clip()], [], 0), /reference image or a reference video/);
  assert.throws(() => v([clip(), clip(), clip()], [], 1), /at most 2 sound/);
  assert.throws(() => v([clip(1)], [], 1), /2 to 15 seconds/);
  assert.throws(() => v([], [mp4(), mp4()], 0), /one reference video/);
  assert.throws(() => v([], [{ ...mp4(), mimeType: 'video/quicktime' }], 0), /MP4 file/);
  assert.throws(() => v([], [mp4(20)], 0), /2 to 15 seconds/);
  assert.throws(() => v([{ ...clip(), mimeType: 'audio/ogg' }], [], 1), /MP3 or WAV/);
});

function generationDb() {
  const sql = [];
  execute = async (text, args = []) => {
    sql.push([text, args]);
    if (text.includes('FROM users WHERE id')) return [[{ id: 1, credits: 1000, status: 'active', plan_code: 'creator' }]];
    if (text.includes('COUNT(*) AS total FROM generations')) return [[{ total: 0 }]];
    if (text.includes('SELECT * FROM generations WHERE id')) return [[{ id: args[0], user_id: 1, model: 'minimax_h3', status: 'queued' }]];
    return [{ affectedRows: 1 }];
  };
  return sql;
}
const h3 = extra => ({ prompt: 'A singer on a stage', model: 'minimax_h3', duration: 10, resolution: '768p', aspectRatio: '9:16', ...extra });
const validateMedia = (a, v, i) => validateH3Media(a, v, i, { mp4Seconds });

test('MiniMax H3 jobs keep their sound clips and video after the images', async () => {
  const sql = generationDb();
  await createGenerationForUser(1, h3({ images: [png, png], audios: [clip()], videos: [mp4()] }), { validateMedia });
  const media = sql.filter(([text]) => text.includes('INSERT INTO generation_media')).map(([, a]) => [a[1], a[2], a[3]]);
  assert.deepEqual(media, [[2, 'audio', 'audio_references'], [3, 'video', 'video_references']]);
  // A video alone is a reference job too.
  const solo = generationDb();
  await createGenerationForUser(1, h3({ videos: [mp4()] }), { validateMedia });
  assert.equal(solo.find(([text]) => text.includes('INSERT INTO generations'))[1][4], 'image-to-video');
});

test('sound and video are refused before credits are taken when the rules are not met', async () => {
  const sql = generationDb();
  await assert.rejects(createGenerationForUser(1, h3({ audios: [clip()] }), { validateMedia }), /reference image or a reference video/);
  // Without the validator (Cartoon Studio, Seedance) sound and video are still refused.
  await assert.rejects(createGenerationForUser(1, h3({ images: [png], audios: [clip()] })), /does not accept sound references/);
  await assert.rejects(createGenerationForUser(1, h3({ videos: [mp4()] })), /does not accept video references/);
  assert.equal(sql.length, 0);
});

test('vgenv gets sound and video as uploaded assets, as its API requires', async () => {
  const calls = [];
  const realFetch = global.fetch;
  let n = 0;
  global.fetch = async (url, options = {}) => {
    calls.push([url, options.method, options.headers, options.body]);
    if (url.endsWith('/v1/assets/uploads')) { n++; return new Response(JSON.stringify({ asset: { id: 'asset_' + n }, upload: { url: 'https://storage.example/put/' + n, method: 'PUT', headers: { 'content-type': JSON.parse(options.body).contentType } } }), { status: 201 }); }
    if (url.startsWith('https://storage.example/')) return new Response('', { status: 200 });
    if (/\/v1\/assets\/asset_\d+\/complete$/.test(url)) return new Response(JSON.stringify({ id: 'asset_' + n, status: 'ready' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'v1', status: 'queued' }), { status: 200 });
  };
  try {
    const client = new VgenvClient({ apiKey: 'k' });
    assert.equal(await client.uploadAsset({ data: Buffer.from('mp3'), mimeType: 'audio/mp3', fileName: 'a.mp3' }), 'asset_1');
    const created = JSON.parse(calls[0][3]);
    assert.deepEqual(created, { fileName: 'a.mp3', contentType: 'audio/mpeg', sizeBytes: 3 });
    assert.equal(calls[1][1], 'PUT');
    assert.equal('Authorization' in (calls[1][2] || {}), false); // no API key to the storage address
    assert.match(calls[2][0], /\/v1\/assets\/asset_1\/complete$/);
    await assert.rejects(client.uploadAsset({ data: Buffer.from('x'), mimeType: 'video/quicktime' }), /does not take video\/quicktime/);

    calls.length = 0;
    await client.generateVideo({ prompt: 'p', duration: 5, aspectRatio: '9:16', referenceImageUrls: ['https://x/i'], referenceAudioAssetIds: ['asset_a', 'asset_b', 'asset_c'], referenceVideoAssetId: 'asset_v' });
    const body = JSON.parse(calls[0][3]);
    assert.deepEqual(body.reference_audios, [{ asset_id: 'asset_a' }, { asset_id: 'asset_b' }]);
    assert.deepEqual(body.reference_video, { asset_id: 'asset_v' });
    assert.equal(body.reference_images.length, 1);
    calls.length = 0;
    await client.generateVideo({ prompt: 'p', duration: 5, aspectRatio: '9:16' });
    const plain = JSON.parse(calls[0][3]);
    assert.equal('reference_audios' in plain || 'reference_video' in plain, false);
  } finally { global.fetch = realFetch; }
});

test('the worker uploads each file once and saves the asset ids before sending the job', async () => {
  process.env.APP_URL = 'https://cmmtools.site'; process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'h3-test';
  const worker = new GenerationWorker();
  let params = null, uploads = 0;
  const saved = [];
  worker.vgenv = { uploadAsset: async ({ mimeType }) => 'asset_' + (++uploads) + '_' + mimeType.split('/')[0], generateVideo: async p => { params = p; return { id: 'vg1', price: 0.03 }; } };
  const media = [{ position_index: 1, media_kind: 'audio', filename: 'a.wav', mime_type: 'audio/wav', media_data: Buffer.from('a') },
    { position_index: 2, media_kind: 'video', filename: 'm.mp4', mime_type: 'video/mp4', media_data: Buffer.from('v') }];
  const fake = { execute: async (text, args) => {
    if (text.includes('FROM generation_images')) return [[{ position_index: 0 }]];
    if (text.includes('FROM generation_media')) return [media];
    if (text.startsWith('UPDATE generations SET provider_operation')) saved.push(JSON.parse(args[0]));
    return [{ affectedRows: 1 }];
  } };
  const job = { id: '11111111-2222-3333-4444-555555555555', user_id: 1, model: 'minimax_h3', duration: 10, aspect_ratio: '9:16', prompt: 'p', mode: 'image-to-video', resolution: '768p', provider_operation: null };
  await worker.submitVgenv(fake, job, 1);
  assert.equal(params.referenceImageUrls.length, 1);
  assert.deepEqual([params.referenceAudioAssetIds, params.referenceVideoAssetId], [['asset_1_audio'], 'asset_2_video']);
  assert.deepEqual(saved.at(-1).vgenvAssets, { 1: 'asset_1_audio', 2: 'asset_2_video' });
  // A resend after a restart reuses the saved ids: nothing is uploaded again.
  await worker.submitVgenv(fake, { ...job, provider_operation: JSON.stringify(saved.at(-1)) }, 1);
  assert.equal(uploads, 2);
  assert.deepEqual([params.referenceAudioAssetIds, params.referenceVideoAssetId], [['asset_1_audio'], 'asset_2_video']);
  // A video with no images is a valid MiniMax reference job.
  await worker.submitVgenv({ ...fake, execute: async (t, a) => (t.includes('FROM generation_images') ? [[]] : fake.execute(t, a)) }, { ...job, provider_operation: JSON.stringify(saved.at(-1)) }, 0);
  assert.deepEqual([params.referenceImageUrls, params.referenceVideoAssetId], [[], 'asset_2_video']);
  worker.stop?.();
});

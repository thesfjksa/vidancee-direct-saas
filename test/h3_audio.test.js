const test = require('node:test');
const assert = require('node:assert/strict');

// The test database is installed before the modules that use it are loaded.
let execute = async sql => { throw new Error('Unexpected test SQL: ' + sql); };
const db = { execute: (...a) => execute(...a), query: (...a) => execute(...a),
  async getConnection() { return { execute: db.execute, query: db.query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} }; } };
const dbModule = require('../src/db.js');
Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true });

const { validateH3Audio, H3_AUDIO_CAPABILITY } = require('../src/h3_audio.js');
const { createGenerationForUser } = require('../src/generations.js');
const { VgenvClient, AUDIO_FIELD } = require('../src/provider/vgenv.js');
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
const png = { filename: 'i.png', mimeType: 'image/png', data: Buffer.from('png') };

test('MiniMax H3 sound references follow MiniMax rules', () => {
  assert.equal(H3_AUDIO_CAPABILITY.max, 3);
  assert.equal(H3_AUDIO_CAPABILITY.needsImage, true);
  validateH3Audio([], 0);
  validateH3Audio([clip(2), clip(15), { filename: 'b.mp3', mimeType: 'audio/mpeg', data: Buffer.from('mp3') }], 1);
  assert.throws(() => validateH3Audio([clip()], 0), /at least one reference image/);
  assert.throws(() => validateH3Audio([clip(), clip(), clip(), clip()], 1), /at most 3/);
  assert.throws(() => validateH3Audio([clip(1)], 1), /2 to 15 seconds/);
  assert.throws(() => validateH3Audio([clip(16)], 1), /2 to 15 seconds/);
  assert.throws(() => validateH3Audio([{ ...clip(), mimeType: 'audio/ogg' }], 1), /MP3 or WAV/);
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

test('MiniMax H3 jobs keep their sound clips after the images', async () => {
  const sql = generationDb();
  await createGenerationForUser(1, h3({ images: [png, png], audios: [clip(), clip()] }), { validateAudio: validateH3Audio });
  const media = sql.filter(([text]) => text.includes('INSERT INTO generation_media')).map(([, a]) => [a[1], a[2], a[3]]);
  assert.deepEqual(media, [[2, 'audio', 'audio_references'], [3, 'audio', 'audio_references']]);
  assert.equal(sql.find(([text]) => text.includes('INSERT INTO generations'))[1][4], 'image-to-video');
});

test('sound is refused before credits are taken when the rules are not met', async () => {
  const sql = generationDb();
  await assert.rejects(createGenerationForUser(1, h3({ audios: [clip()] }), { validateAudio: validateH3Audio }), /at least one reference image/);
  // Without the validator (Cartoon Studio, Seedance) sound is still refused.
  await assert.rejects(createGenerationForUser(1, h3({ images: [png], audios: [clip()] })), /does not accept sound references/);
  assert.equal(sql.length, 0);
});

test('vgenv receives sound references next to the reference images', async () => {
  const sent = [];
  const client = new VgenvClient({ apiKey: 'k' });
  const realFetch = global.fetch;
  global.fetch = async (url, options) => { sent.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: 'v1', status: 'queued' }), { status: 200 }); };
  try {
    await client.generateVideo({ prompt: 'p', duration: 5, aspectRatio: '9:16', referenceImageUrls: ['https://x/i'], referenceAudioUrls: ['https://x/a1', 'https://x/a2'] });
    await client.generateVideo({ prompt: 'p', duration: 5, aspectRatio: '9:16' });
  } finally { global.fetch = realFetch; }
  assert.deepEqual(sent[0][AUDIO_FIELD], [{ type: 'audio_url', audio_url: { url: 'https://x/a1' } }, { type: 'audio_url', audio_url: { url: 'https://x/a2' } }]);
  assert.equal(sent[0].reference_images.length, 1);
  assert.equal(AUDIO_FIELD in sent[1], false);
});

test('the worker hands vgenv signed links to the stored sound clips', async () => {
  process.env.APP_URL = 'https://cmmtools.site'; process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'h3-audio-test';
  const worker = new GenerationWorker();
  let params = null;
  worker.vgenv = { generateVideo: async p => { params = p; return { id: 'vg1', price: 0.03 }; } };
  const fake = { execute: async text => {
    if (text.includes('FROM generation_images')) return [[{ position_index: 0 }]];
    if (text.includes('FROM generation_media')) return [[{ position_index: 1 }, { position_index: 2 }]];
    return [{ affectedRows: 1 }];
  } };
  await worker.submitVgenv(fake, { id: '11111111-2222-3333-4444-555555555555', model: 'minimax_h3', duration: 10, aspect_ratio: '9:16', prompt: 'p', mode: 'image-to-video', resolution: '768p' }, 1);
  assert.equal(params.referenceImageUrls.length, 1);
  assert.match(params.referenceImageUrls[0], /\/provider-assets\/.*\/0\?sig=/);
  assert.deepEqual(params.referenceAudioUrls.map(u => u.match(/\/provider-media\/[^/]+\/(\d+)\?sig=/)[1]), ['1', '2']);
  worker.stop?.();
});

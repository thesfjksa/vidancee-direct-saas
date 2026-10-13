const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const cartoon = require('../src/cartoon.js');
// Modules capture the database helpers when first loaded, so the test database
// is installed before the worker and server are required.
let execute = async sql => { throw new Error('Unexpected test SQL: ' + sql); };
const db = { execute: (...a) => execute(...a), query: (...a) => execute(...a),
  async getConnection() { return { execute: db.execute, query: db.query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} }; } };
const dbModule = require('../src/db.js');
Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
const { GenerationWorker } = require('../src/worker_admin_settings.js');

const job = (extra = {}) => ({ id: 'j1', model: 'seedance_2.5', duration: 10, aspect_ratio: '9:16', mode: 'text-to-video', prompt: 'A fox cub chases fireflies',
  generation_options: JSON.stringify({ studio: 'cartoon', cartoonStyle: 'anime' }), ...extra });

test('cartoon styles shape the provider prompt but not the stored prompt', () => {
  assert.equal(cartoon.isCartoonJob(job()), true);
  assert.equal(cartoon.isCartoonJob({ ...job(), generation_options: null }), false);
  assert.match(cartoon.providerPrompt(job()), /^Japanese anime style: .* Scene: A fox cub chases fireflies$/);
  assert.equal(cartoon.providerPrompt({ prompt: 'plain video', generation_options: '{}' }), 'plain video');
  assert.deepEqual(cartoon.normalizeCartoonRequest({ cartoonStyle: 'clay', model: 'seedance_2.0_fast' }), { studio: 'cartoon', cartoonStyle: 'clay' });
  assert.throws(() => cartoon.normalizeCartoonRequest({ cartoonStyle: 'oil', model: 'seedance_2.5' }), /Choose a cartoon style/);
  assert.deepEqual(cartoon.normalizeCartoonRequest({ cartoonStyle: 'anime', model: 'minimax_h3' }), { studio: 'cartoon', cartoonStyle: 'anime' });
  assert.throws(() => cartoon.normalizeCartoonRequest({ cartoonStyle: 'anime', model: 'argo_wan_3' }), /supports Seedance 2.5, Seedance 2.0 Fast and MiniMax H3/);
  assert.equal(cartoon.vidanceeCreditsNeeded({ duration: 10 }), 6);
  assert.equal(cartoon.vidanceeCreditsNeeded({ duration: 15 }), 9);
  assert.equal(cartoon.looksOutOfCredits(Object.assign(new Error('Vidancee generate failed'), { details: { data: { error: 'Not enough credits' } } })), true);
  assert.equal(cartoon.looksOutOfCredits(new Error('CreatePulse HTTP 402')), true);
  assert.equal(cartoon.looksOutOfCredits(new Error('Network timeout')), false);
  const config = cartoon.publicCartoonConfig(true, [{ id: 'seedance_2.5' }, { id: 'minimax_h3' }]);
  assert.deepEqual(config.pricing.map(m => m.id), ['seedance_2.5', 'minimax_h3']);
  assert.equal(config.styles.length, 5);
  assert.equal(JSON.stringify(config).includes('directive'), false);
});

test('cartoon jobs go to whichever source has credits', () => {
  const w = new GenerationWorker();
  Object.assign(w, { vidanceeEnabled: true, vidancee: {}, createPulseEnabled: true, routing: 'overflow',
    createPulse: { supports: () => true } });
  w.vidanceeBalance = 20;
  assert.equal(w.chooseProvider(job(), 0, 1, 1, 0), 'vidancee');
  w.vidanceeBalance = 5; // 10s needs about 6 Vidancee credits
  assert.equal(w.chooseProvider(job(), 0, 1, 1, 0), 'createpulse');
  assert.equal(w.chooseProvider(job({ generation_options: '{}' }), 0, 1, 1, 0), 'vidancee'); // Video Studio routing unchanged
  w.vidanceeBalance = null; // balance unknown: keep the configured order
  assert.equal(w.chooseProvider(job(), 0, 1, 1, 0), 'vidancee');
  w.markOutOfCredits('vidancee');
  assert.equal(w.chooseProvider(job(), 0, 1, 1, 0), 'createpulse');
  w.markOutOfCredits('createpulse');
  assert.equal(w.chooseProvider(job(), 0, 1, 1, 0), null); // waits instead of failing while both are out
  w.outOfCreditsUntil = { createpulse: Date.now() - 1 };
  w.vidanceeBalance = 0;
  assert.equal(w.chooseProvider(job(), 0, 1, 1, 0), 'createpulse');
  w.stop?.();
});

test('Cartoon Studio jobs are accepted for its models only and keep the style on the job', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'cartoon-admin';
  const user = { id: 1, email: 'c@example.com', credits: 500, status: 'active', plan_code: 'pro', role: 'user' };
  const settings = new Map(Object.entries({ vidancee_email: 'v@example.com', vidancee_password: 'x', vidancee_enabled: 'true', allow_provider_charges: 'true' })
    .map(([k, v]) => [k, { setting_key: k, setting_value: v, is_secret: 0 }]));
  let inserted = null;
  execute = async (sql, args = []) => {
    if (sql.startsWith('CREATE')) return [[], []];
    if (/^(INSERT INTO|DELETE FROM) runtime_boots/.test(sql)) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT setting_key')) return [[...settings.values()]];
    if (sql.startsWith('SELECT provider,enabled')) return [[]];
    if (sql.includes('FROM users WHERE id') ) return [[user]];
    if (sql.includes('COUNT(*) AS total FROM generations')) return [[{ total: 0 }]];
    if (sql.includes('INSERT INTO generations')) { inserted = args; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE users SET credits') || sql.includes('INSERT INTO credit_transactions')) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT * FROM generations WHERE id')) return [[{ id: inserted[0], user_id: 1, mode: inserted[4], model: inserted[5], duration: inserted[6], resolution: inserted[7], aspect_ratio: inserted[8], prompt: inserted[9], status: 'queued', credits_cost: inserted[10], generation_options: inserted[13] }]];
    throw new Error('Unexpected test SQL: ' + sql);
  };
  const auth = require('../src/auth.js'); const originalAuth = { ...auth };
  auth.requireUser = async () => user; auth.userFromRequest = async () => user;
  const server = require('../server.js');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); Object.assign(auth, originalAuth); });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = async body => { const r = await fetch(origin + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };

  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.cartoon.enabled, true);
  assert.deepEqual(config.cartoon.styles.map(s => s.id), ['3d', 'anime', '2d', 'clay', 'comic']);
  assert.deepEqual(config.cartoon.pricing.map(m => m.id), ['seedance_2.5', 'seedance_2.0_fast']);
  // Video Studio lists ArgoLink's models (not configured here) and Seedance on Vidancee/CreatePulse.
  assert.deepEqual(config.pricing.map(m => m.id), ['seedance_2.5', 'seedance_2.0_fast']);

  assert.equal((await post({ prompt: 'A dragon', model: 'seedance_2.5', duration: 10, aspectRatio: '9:16', cartoonStyle: 'watercolor' })).status, 400);
  // MiniMax H3 belongs to Cartoon Studio; it needs vgenv, which is not configured here.
  assert.equal((await post({ prompt: 'A dragon', model: 'minimax_h3', duration: 10, aspectRatio: '9:16', cartoonStyle: 'anime' })).status, 503);
  assert.equal((await post({ prompt: 'A dragon', model: 'minimax_h3', duration: 10, aspectRatio: '9:16' })).status, 503);
  assert.equal(inserted, null);
  const ok = await post({ prompt: 'A dragon learns to fly', model: 'seedance_2.5', duration: 10, aspectRatio: '9:16', cartoonStyle: 'clay' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.generation.prompt, 'A dragon learns to fly');
  assert.deepEqual(ok.data.generation.generation_options, { generationMode: null, generateAudio: false, studio: 'cartoon', cartoon_style: 'clay' });
  assert.deepEqual(JSON.parse(inserted[13]), { studio: 'cartoon', cartoonStyle: 'clay' });
  assert.equal(inserted[2], 'vidancee');

  // The same model from Video Studio: no cartoon style on the job.
  const plain = await post({ prompt: 'A dragon over the sea', model: 'seedance_2.5', duration: 10, aspectRatio: '16:9' });
  assert.equal(plain.status, 201);
  assert.equal(JSON.parse(inserted[13] || '{}').studio, undefined);
  assert.equal(inserted[2], 'vidancee');
});

test('MiniMax H3 is rendered at the resolution the customer paid for', async () => {
  const worker = new GenerationWorker();
  const sent = [];
  worker.vgenv = { generateVideo: async params => { sent.push(params.resolution); return { id: 'vg1', price: 0.015 }; } };
  const db = { execute: async () => [{ affectedRows: 1 }] };
  const job = { id: 'h1', model: 'minimax_h3', duration: 10, aspect_ratio: '9:16', prompt: 'A fox', mode: 'text-to-video' };
  await worker.submitVgenv(db, { ...job, resolution: '480p' }, 0);
  await worker.submitVgenv(db, { ...job, resolution: '768p' }, 0);
  await worker.submitVgenv(db, { ...job, resolution: null }, 0);
  assert.deepEqual(sent, ['480p', '768p', '768p']);
});

test('a Seedance job moves to the other source when the first one fails, Video Studio included', async () => {
  const w = new GenerationWorker();
  Object.assign(w, { vidanceeEnabled: true, createPulseEnabled: true, routing: 'createpulse-first', vidanceeBalance: null });
  const calls = [];
  w.createPulse = { supports: () => true };
  w.submitCreatePulse = async () => { calls.push('createpulse'); throw new Error('CreatePulse HTTP 502'); };
  w.submitVidancee = async () => { calls.push('vidancee'); };
  w.vidancee = {};
  const sql = [];
  const db = { execute: async (text, args) => { sql.push([text, args]); return [{ affectedRows: 1 }]; } };
  const slots = { vid: 1, cp: 1, vgenv: 0 };
  await w.submitVideoJob(db, job({ generation_options: null }), 0, 'createpulse', slots);
  assert.deepEqual(calls, ['createpulse', 'vidancee']);
  assert.deepEqual(slots, { vid: 0, cp: 1, vgenv: 0 });
  assert.ok(sql.some(([text, args]) => text.startsWith('UPDATE generations SET provider=?') && args[0] === 'vidancee'));
  // A server error does not mark the source out of credits.
  assert.equal(Number(w.outOfCreditsUntil?.createpulse || 0), 0);
  w.stop?.();
});

test('MiniMax H3 is priced at vgenv cost + 70%', () => {
  const { getCost } = require('../src/pricing.js');
  // $0.003/s x 10 s x Rs 280 / Rs 3 per credit = 2.8 credits cost -> x1.7
  assert.equal(getCost('minimax_h3', 10, '768p'), 4.76);
  assert.equal(getCost('minimax_h3', 10, '480p'), 2.38);
});

test('finished vgenv videos are copied into CMM Tools storage once', async () => {
  const w = new GenerationWorker();
  const sql = [];
  const conn = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async (text, args) => { sql.push([text, args]); if (text.startsWith('SELECT output_url')) return [[{ output_url: 'https://oss.example/v.mp4' }]]; return [{ affectedRows: 1 }]; } };
  const db = { query: async () => [[{ id: 'h1', user_id: 1, output_url: 'https://oss.example/v.mp4' }, { id: 'h2', user_id: 1, output_url: 'https://oss.example/w.mp4' }]], getConnection: async () => conn };
  const video = Buffer.alloc(1536 * 1024, 7);
  let calls = 0;
  const fetchImpl = async url => { calls++; if (url.endsWith('w.mp4')) return new Response('nope', { status: 403 }); return new Response(video, { status: 200 }); };
  await w.copyVgenvVideos(db, { fetchImpl });
  assert.equal(calls, 2);
  assert.ok(sql.some(([t, a]) => t.startsWith('INSERT INTO generation_video_outputs') && a[0] === 'h1' && a[2] === video.length));
  assert.equal(sql.filter(([t]) => t.startsWith('INSERT INTO generation_video_chunks')).length, 2);
  assert.ok(sql.some(([t, a]) => t.includes("output_url='db:video'") && a[0] === 'h1'));
  // The failed one waits 10 minutes before the next try.
  await w.copyVgenvVideos(db, { fetchImpl });
  assert.equal(calls, 3);
});

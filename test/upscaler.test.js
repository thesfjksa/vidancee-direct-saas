const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
// Modules read the database pool when first loaded, so the test pool goes in first.
let execute = async sql => { throw new Error('Unexpected test SQL: ' + sql); };
const db = { execute: (...a) => execute(...a), query: (...a) => execute(...a),
  async getConnection() { return { execute: db.execute, query: db.query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }; } };
Object.assign(require('../src/db.js'), { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
const { upscaleQuote, publicUpscalerConfig } = require('../src/upscaler.js');
const { planUpscale, mp4Dimensions } = require('../src/enhance.js');
const { FalClient } = require('../src/provider/fal.js');
const { UpscaleQueue } = require('../src/upscale_queue.js');

// A minimal MP4 header: duration in 'mvhd' and frame size in 'tkhd'.
function mp4(seconds, width = 1280, height = 720) {
  const b = Buffer.alloc(200);
  b.write('ftypisom', 4);
  b.write('mvhd', 24); b.writeUInt32BE(1000, 40); b.writeUInt32BE(Math.round(seconds * 1000), 44);
  b.write('tkhd', 100); b.writeUInt32BE(width * 65536, 180); b.writeUInt32BE(height * 65536, 184);
  return b;
}

test('upscales use the ByteDance upscaler on fal, priced per second by output tier', () => {
  const hd = { width: 1280, height: 720, seconds: 10 };
  assert.deepEqual(upscaleQuote(hd, '1080p', 1000), { resolution: '1080p', sourceUsd: 0.072, cost: 72,
    plan: { path: 'fal-ai/bytedance-upscaler/upscale/video', input: { target_resolution: '1080p', enhancement_preset: 'general', fidelity: 'high' }, usd: 0.072, target: '1080p' } });
  assert.equal(upscaleQuote(hd, '2k', 1000).cost, 144);
  assert.equal(upscaleQuote(hd, '4k', 1000).cost, 288);
  assert.equal(upscaleQuote({ ...hd, seconds: 5.2 }, '1080p', 1000).cost, 44); // part seconds round up
  assert.throws(() => upscaleQuote({ width: 1920, height: 1080, seconds: 5 }, '1080p', 1000), /already 1080p or larger/);
  assert.throws(() => upscaleQuote(hd, '8k', 1000), /1080p, 2K or 4K/);
  assert.throws(() => upscaleQuote({ ...hd, seconds: 0 }, '4k', 1000), /length could not be read/);
  // 720p is reached with a scale ratio; the planner keeps 24 fps for ArgoLink renders.
  assert.deepEqual(planUpscale({ width: 1280, height: 720, seconds: 5 }, '1080p', { fps: 24 }).input, { target_resolution: '1080p', enhancement_preset: 'general', fidelity: 'high', target_fps: 24 });
  assert.equal(planUpscale({ width: 1366, height: 768, seconds: 5 }, '720p'), null);
  assert.deepEqual(mp4Dimensions(mp4(3, 960, 540)), { width: 960, height: 540 });
  assert.deepEqual(publicUpscalerConfig(true).resolutions.map(r => r.id), ['1080p', '2k', '4k']);
});

test('the fal client submits to the queue, polls the returned URLs and reports failures', async () => {
  const calls = [];
  const base = 'https://queue.fal.run/fal-ai/bytedance-upscaler/requests/r1';
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    if (url === 'https://queue.fal.run/fal-ai/bytedance-upscaler/upscale/video') return Response.json({ request_id: 'r1', status_url: base + '/status', response_url: base });
    if (url === base + '/status') return Response.json({ status: 'COMPLETED' });
    if (url === base) return Response.json({ video: { url: 'https://v3.fal.media/out.mp4', content_type: 'video/mp4' } });
    if (url === 'https://v3.fal.media/out.mp4') return new Response(mp4(10));
    if (url.endsWith('/bad/status')) return Response.json({ status: 'COMPLETED', error: 'Video too long' });
    return Response.json({ detail: 'invalid key credentials' }, { status: 401 });
  };
  const client = new FalClient({ apiKey: 'fal-key', fetchImpl });
  const op = await client.submit('fal-ai/bytedance-upscaler/upscale/video', { video_url: 'https://cmmtools.site/x', target_resolution: '1080p' });
  assert.deepEqual(op, { requestId: 'r1', statusUrl: base + '/status', responseUrl: base });
  assert.deepEqual([calls[0].method, calls[0].auth, calls[0].body.target_resolution], ['POST', 'Key fal-key', '1080p']);
  const done = await client.check(op);
  assert.deepEqual(done, { state: 'done', url: 'https://v3.fal.media/out.mp4' });
  assert.equal((await client.download(done.url)).mimeType, 'video/mp4');
  assert.deepEqual(await client.check({ statusUrl: 'https://queue.fal.run/x/requests/bad/status', responseUrl: 'https://queue.fal.run/x/requests/bad' }), { state: 'failed', error: 'Video too long' });
  await assert.rejects(client.check({ statusUrl: 'https://evil.example/status' }), /unexpected queue address/);
  await assert.rejects(client.verifyKey(), /rejected the API key/);
  await assert.rejects(new FalClient().submit('x', {}), /Save a fal.ai API key/);
});

test('the upscale queue sends a signed source link, resumes from the saved queue URLs and refunds failures', async () => {
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const writes = [], refunds = [], completed = [], submitted = [];
  const qdb = { async execute(sql, args) { writes.push([sql, args]); if (sql.includes('FROM generation_media')) return [[{ position_index: 0 }]]; return [{ affectedRows: 1 }]; } };
  const op = id => ({ requestId: id, statusUrl: 'https://queue.fal.run/m/requests/' + id + '/status', responseUrl: 'https://queue.fal.run/m/requests/' + id });
  const states = { a: { state: 'pending' }, b: { state: 'done', url: 'https://v3.fal.media/b.mp4' }, c: { state: 'failed', error: 'video too long' } };
  const client = { submit: async (path, input) => { submitted.push([path, input]); return op('r9'); }, check: async o => states[o.requestId],
    download: async url => ({ data: Buffer.from(url), mimeType: 'video/mp4' }) };
  const queue = new UpscaleQueue({ refund: async (...a) => refunds.push(a) });
  queue.complete = async (_db, job, output) => completed.push([job.id, output.data.toString()]);
  const plan = { path: 'fal-ai/bytedance-upscaler/upscale/video', input: { target_resolution: '4k', enhancement_preset: 'general' } };
  await queue.submit(qdb, { id: 'up-1', generation_options: JSON.stringify({ studio: 'upscale', sourceGenerationId: '6f9619ff-8b86-4011-b42d-00c04fc964ff', upscale: plan }) }, client);
  assert.equal(submitted[0][0], plan.path);
  assert.match(submitted[0][1].video_url, /^https:\/\/cmmtools\.site\/provider-outputs\/6f9619ff-8b86-4011-b42d-00c04fc964ff\?sig=[0-9a-f]{64}$/);
  assert.equal(submitted[0][1].target_resolution, '4k');
  assert.deepEqual(writes.at(-1)[1], [JSON.stringify(op('r9')), 'r9', 'up-1']);
  await queue.submit(qdb, { id: 'up-2', generation_options: JSON.stringify({ studio: 'upscale', upscale: plan }) }, client);
  assert.match(submitted[1][1].video_url, /^https:\/\/cmmtools\.site\/provider-media\/up-2\/0\?sig=/);
  await queue.pollJob(qdb, client, { id: 'g-a', provider_operation: JSON.stringify(op('a')) });
  assert.match(writes.at(-1)[0], /SET status='processing'/);
  await queue.pollJob(qdb, client, { id: 'g-b', provider_operation: JSON.stringify(op('b')) });
  assert.deepEqual(completed, [['g-b', 'https://v3.fal.media/b.mp4']]);
  await queue.pollJob(qdb, client, { id: 'g-c', provider_operation: JSON.stringify(op('c')) });
  assert.match(refunds[0][2], /could not be upscaled: video too long\. Credits were refunded\.$/);
  assert.match(queue.queuedSql(), /g\.provider='fal'/);
});

test('customers upscale a finished video or an upload; the source link is signed', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'up-admin';
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const user = { id: 5, email: 'u@example.com', credits: 1000, status: 'active', plan_code: 'pro', role: 'user' };
  const settings = new Map(Object.entries({ fal_api_key: 'fal', fal_customer_credits_per_usd: '1000', allow_provider_charges: 'true' })
    .map(([k, v]) => [k, { setting_key: k, setting_value: v, is_secret: 0 }]));
  const source = { id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', user_id: 5, media_type: 'video', status: 'completed', output_url: 'https://cdn.example/v.mp4', duration: 10, resolution: '720p', aspect_ratio: '9:16', prompt: 'A fox' };
  const jobs = new Map(), media = [], debits = [];
  execute = async (sql, args = []) => {
    if (sql.startsWith('CREATE') || /GET_LOCK|RELEASE_LOCK/.test(sql)) return [[{ acquired: 0 }]];
    if (/^(INSERT INTO|DELETE FROM) runtime_boots/.test(sql)) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT setting_key')) return [[...settings.values()]];
    if (sql.includes('FROM app_settings')) return [[]];
    if (sql.startsWith('SELECT provider,enabled')) return [[]];
    if (sql.includes('FROM users WHERE id')) return [[user]];
    if (sql.includes('COUNT(*) AS total FROM generations')) return [[{ total: 0 }]];
    if (sql.includes("media_type='video' AND status='completed' AND output_url IS NOT NULL")) return [[args[0] === source.id && args[1] === 5 ? source : undefined].filter(Boolean)];
    if (sql.includes('LEFT JOIN generation_video_outputs')) return [[args[0] === source.id ? { ...source, stored: null } : undefined].filter(Boolean)];
    if (sql.includes('INSERT INTO generations')) { jobs.set(args[0], { id: args[0], user_id: args[1], provider: 'fal', mode: 'upscale', model: args[3], duration: args[4], resolution: args[5], aspect_ratio: args[6], prompt: args[7], credits_cost: args[8], provider_cost: args[9], generation_options: args[10], status: 'queued' }); return [{ affectedRows: 1 }]; }
    if (sql.includes('INSERT INTO generation_media')) { media.push(args); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE users SET credits')) { user.credits -= args[0]; debits.push(args[0]); return [{ affectedRows: 1 }]; }
    if (sql.includes('INSERT INTO credit_transactions')) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT * FROM generations WHERE id = ?')) return [[jobs.get(args[0])]];
    throw new Error('Unexpected test SQL: ' + sql);
  };
  const auth = require('../src/auth.js');
  auth.requireUser = async () => user; auth.userFromRequest = async () => user;
  const server = require('../server.js');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const json = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));

  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.upscaler.enabled, true);
  assert.deepEqual(config.upscaler.resolutions.map(r => r.id), ['1080p', '2k', '4k']);
  assert.deepEqual((await json('/api/upscales/quote', { sourceGenerationId: source.id, resolution: '4k' })).data, { ok: true, cost: 81 });
  assert.deepEqual((await json('/api/upscales/quote', { width: 854, height: 480, seconds: 4.5, resolution: '1080p' })).data, { ok: true, cost: 11 });
  assert.equal((await json('/api/upscales/quote', { width: 1920, height: 1080, seconds: 4, resolution: '1080p' })).status, 400);

  const form = new FormData(); form.append('resolution', '4k'); form.append('sourceGenerationId', source.id);
  let r = await fetch(origin + '/api/upscales', { method: 'POST', body: form });
  let d = await r.json();
  assert.equal(r.status, 201);
  assert.deepEqual(d.generation.generation_options, { generationMode: null, generateAudio: false, studio: 'upscale', source_generation_id: source.id, target_resolution: '4k', source_seconds: 10 });
  assert.deepEqual([d.generation.credits_cost, d.generation.resolution, d.generation.aspect_ratio, debits[0]], [81, '4k', '9:16', 81]);
  assert.equal(JSON.parse(jobs.get(d.generation.id).generation_options).upscale.input.target_resolution, '4k');

  const upload = new FormData(); upload.append('resolution', '1080p');
  upload.append('videos', new Blob([mp4(4.5, 854, 480)], { type: 'video/mp4' }), 'clip.mp4');
  r = await fetch(origin + '/api/upscales', { method: 'POST', body: upload });
  d = await r.json();
  assert.equal(r.status, 201);
  assert.deepEqual([d.generation.credits_cost, d.generation.duration], [11, 5]); // 5 billed seconds x $0.0072 x 280, rounded up
  assert.equal(media[0][2], 'video/mp4');

  const bad = new FormData(); bad.append('resolution', '4k'); bad.append('sourceGenerationId', '00000000-0000-4000-8000-000000000000');
  assert.equal((await fetch(origin + '/api/upscales', { method: 'POST', body: bad })).status, 404);

  // The source link works only with its signature.
  const { providerOutputUrl } = require('../src/provider/assets.js');
  const signed = providerOutputUrl(source.id).replace('https://cmmtools.site', origin);
  assert.equal((await fetch(signed.replace(/sig=.*/, 'sig=bad'))).status, 403);
  assert.equal((await fetch(signed.replace(source.id, '00000000-0000-4000-8000-000000000000'))).status, 403);
});

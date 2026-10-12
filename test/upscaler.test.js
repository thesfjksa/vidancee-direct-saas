const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
// Modules read the database pool when first loaded, so the test pool goes in first.
let execute = async sql => { throw new Error('Unexpected test SQL: ' + sql); };
const db = { execute: (...a) => execute(...a), query: (...a) => execute(...a),
  async getConnection() { return { execute: db.execute, query: db.query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }; } };
Object.assign(require('../src/db.js'), { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
const { upscaleQuote, publicUpscalerConfig } = require('../src/upscaler.js');
const { WaveSpeedClient } = require('../src/provider/wavespeed.js');
const { UpscaleQueue } = require('../src/upscale_queue.js');

const mp4 = seconds => { const b = Buffer.alloc(64); b.write('ftypisom', 4); b.write('mvhd', 24); b.writeUInt32BE(1000, 40); b.writeUInt32BE(Math.round(seconds * 1000), 44); return b; };

test('upscales are priced per source second at WaveSpeed rates, capped at 600 s', () => {
  assert.deepEqual(upscaleQuote(10, '1080p', 1000), { resolution: '1080p', billedSeconds: 10, sourceUsd: 0.072, cost: 72 });
  assert.equal(upscaleQuote(10, '4k', 1000).cost, 288);
  assert.equal(upscaleQuote(5.2, '2k', 1000).billedSeconds, 6); // part seconds round up
  assert.equal(upscaleQuote(900, '1080p', 1000).billedSeconds, 600);
  assert.throws(() => upscaleQuote(10, '8k', 1000), /1080p, 2K or 4K/);
  assert.throws(() => upscaleQuote(0, '4k', 1000), /length could not be read/);
  const cfg = publicUpscalerConfig(true, 1000);
  assert.deepEqual(cfg.resolutions.map(r => [r.id, r.label, Math.round(r.creditsPerSecond * 10) / 10]), [['1080p', '1080p', 7.2], ['2k', '2K', 14.4], ['4k', '4K', 28.8]]);
});

test('the WaveSpeed client submits, polls, downloads and reports errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/bytedance/video-upscaler')) return Response.json({ code: 200, message: 'success', data: { id: 'pred-1', status: 'created' } });
    if (url.endsWith('/predictions/pred-1/result')) return Response.json({ code: 200, data: { id: 'pred-1', status: 'completed', outputs: ['https://cdn.wavespeed.ai/out.mp4'] } });
    if (url === 'https://cdn.wavespeed.ai/out.mp4') return new Response(mp4(10));
    if (url.endsWith('/balance')) return Response.json({ code: 200, data: { balance: 3.5 } });
    return Response.json({ code: 402, message: 'Insufficient balance' }, { status: 402 });
  };
  const client = new WaveSpeedClient({ apiKey: 'ws-key', fetchImpl });
  assert.equal(await client.submit('https://cmmtools.site/provider-outputs/x?sig=y', '4k'), 'pred-1');
  assert.deepEqual([calls[0].url, calls[0].method, calls[0].auth, calls[0].body], ['https://api.wavespeed.ai/api/v3/bytedance/video-upscaler', 'POST', 'Bearer ws-key', { video: 'https://cmmtools.site/provider-outputs/x?sig=y', target_resolution: '4k' }]);
  const result = await client.result('pred-1');
  assert.equal(result.status, 'completed');
  assert.equal((await client.download(result.outputs[0])).mimeType, 'video/mp4');
  assert.deepEqual(await client.balance(), { remaining: 3.5, unit: 'USD' });
  await assert.rejects(client.result('missing'), /insufficient balance/);
  await assert.rejects(new WaveSpeedClient().submit('x', '4k'), /Save a WaveSpeed API key/);
});

test('the upscale queue sends a signed source link, resumes by prediction id and refunds failures', async () => {
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const writes = [], refunds = [], completed = [];
  const qdb = { async execute(sql, args) { writes.push([sql, args]); if (sql.includes('FROM generation_media')) return [[{ position_index: 0 }]]; return [{ affectedRows: 1 }]; } };
  const submitted = [];
  const statuses = { a: { status: 'processing' }, b: { status: 'completed', outputs: ['https://cdn.wavespeed.ai/b.mp4'] }, c: { status: 'failed', error: 'video too long' } };
  const client = { submit: async (url, res) => { submitted.push([url, res]); return 'pred-9'; }, result: async id => statuses[id],
    download: async url => ({ data: Buffer.from(url), mimeType: 'video/mp4' }) };
  const queue = new UpscaleQueue({ refund: async (...a) => refunds.push(a) });
  queue.complete = async (_db, job, output) => completed.push([job.id, output.data.toString()]);
  await queue.submit(qdb, { id: 'up-1', resolution: '4k', generation_options: JSON.stringify({ studio: 'upscale', sourceGenerationId: '6f9619ff-8b86-4011-b42d-00c04fc964ff' }) }, client);
  assert.match(submitted[0][0], /^https:\/\/cmmtools\.site\/provider-outputs\/6f9619ff-8b86-4011-b42d-00c04fc964ff\?sig=[0-9a-f]{64}$/);
  assert.equal(submitted[0][1], '4k');
  assert.deepEqual(writes.at(-1)[1], ['{"predictionId":"pred-9"}', 'pred-9', 'up-1']);
  await queue.submit(qdb, { id: 'up-2', resolution: '1080p', generation_options: JSON.stringify({ studio: 'upscale' }) }, client);
  assert.match(submitted[1][0], /^https:\/\/cmmtools\.site\/provider-media\/up-2\/0\?sig=/);
  await queue.pollJob(qdb, client, { id: 'g-a', provider_job_id: 'a' });
  assert.match(writes.at(-1)[0], /SET status='processing'/);
  await queue.pollJob(qdb, client, { id: 'g-b', provider_job_id: 'b' });
  assert.deepEqual(completed, [['g-b', 'https://cdn.wavespeed.ai/b.mp4']]);
  await queue.pollJob(qdb, client, { id: 'g-c', provider_job_id: 'c' });
  assert.match(refunds[0][2], /could not be upscaled: video too long\. Credits were refunded\.$/);
  assert.match(queue.queuedSql(), /g\.provider='wavespeed'/);
  assert.doesNotMatch(queue.queuedSql(), /provider_models/);
});

test('customers upscale a finished video or an upload; the source link is signed', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'up-admin';
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const user = { id: 5, email: 'u@example.com', credits: 1000, status: 'active', plan_code: 'pro', role: 'user' };
  const settings = new Map(Object.entries({ wavespeed_api_key: 'ws', wavespeed_customer_credits_per_usd: '1000', allow_provider_charges: 'true' })
    .map(([k, v]) => [k, { setting_key: k, setting_value: v, is_secret: 0 }]));
  const source = { id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', user_id: 5, media_type: 'video', status: 'completed', output_url: 'https://cdn.example/v.mp4', duration: 10, aspect_ratio: '9:16', prompt: 'A fox' };
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
    if (sql.includes("SELECT id,output_url,poster_url FROM generations")) return [[args[0] === source.id ? source : undefined].filter(Boolean)];
    if (sql.includes('INSERT INTO generations')) { jobs.set(args[0], { id: args[0], user_id: args[1], provider: 'wavespeed', mode: 'upscale', model: args[3], duration: args[4], resolution: args[5], aspect_ratio: args[6], prompt: args[7], credits_cost: args[8], provider_cost: args[9], generation_options: args[10], status: 'queued' }); return [{ affectedRows: 1 }]; }
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

  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.upscaler.enabled, true);
  assert.deepEqual(config.upscaler.resolutions.map(r => r.id), ['1080p', '2k', '4k']);

  const form = new FormData(); form.append('resolution', '4k'); form.append('sourceGenerationId', source.id);
  let r = await fetch(origin + '/api/upscales', { method: 'POST', body: form });
  let d = await r.json();
  assert.equal(r.status, 201);
  assert.deepEqual(d.generation.generation_options, { generationMode: null, generateAudio: false, studio: 'upscale', source_generation_id: source.id, target_resolution: '4k', source_seconds: 10 });
  assert.deepEqual([d.generation.credits_cost, d.generation.resolution, d.generation.aspect_ratio, debits[0]], [288, '4k', '9:16', 288]);

  const upload = new FormData(); upload.append('resolution', '1080p');
  upload.append('videos', new Blob([mp4(4.5)], { type: 'video/mp4' }), 'clip.mp4');
  r = await fetch(origin + '/api/upscales', { method: 'POST', body: upload });
  d = await r.json();
  assert.equal(r.status, 201);
  assert.deepEqual([d.generation.credits_cost, d.generation.duration], [36, 5]); // 5 billed seconds x 7.2
  assert.equal(media[0][2], 'video/mp4');

  const bad = new FormData(); bad.append('resolution', '4k'); bad.append('sourceGenerationId', '00000000-0000-4000-8000-000000000000');
  assert.equal((await fetch(origin + '/api/upscales', { method: 'POST', body: bad })).status, 404);

  // The source link works only with its signature.
  const { providerOutputUrl } = require('../src/provider/assets.js');
  const signed = providerOutputUrl(source.id).replace('https://cmmtools.site', origin);
  assert.equal((await fetch(signed.replace(/sig=.*/, 'sig=bad'))).status, 403);
  assert.equal((await fetch(signed.replace(source.id, '00000000-0000-4000-8000-000000000000'))).status, 403);
});

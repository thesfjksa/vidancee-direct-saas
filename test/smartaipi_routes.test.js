const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { SMART_IMAGE_MODELS, DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD, SMART_IMAGE_PRICING_REVISION } = require('../src/smartaipi_images.js');
const model = SMART_IMAGE_MODELS[0].id;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('real HTTP routes enforce source controls, encrypted settings, billing and private image ownership', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'test-admin-only';
  const users = new Map([1, 2].map(id => [id, { id, email: 'test'+id+'@example.com', credits: 2000, status: 'active', plan_code: 'pro', role: 'user' }]));
  const values = new Map(); const jobs = new Map(); const outputs = new Map(); const access = new Map(); const transactions = [];
  async function execute(sql, args = []) {
    if (sql.startsWith('CREATE')) return [[], []];
    if (sql.includes('INSERT INTO app_settings')) { values.set(args[0], { setting_key: args[0], setting_value: args[1], is_secret: args[2] }); return [{ affectedRows: 1 }]; }
    if (sql.includes('DELETE FROM app_settings')) { values.delete(args[0]); return [{ affectedRows: 1 }]; }
    if (sql.includes('SELECT setting_key')) return [[...values.values()]];
    if (sql.startsWith('SELECT provider,enabled')) return [[...(access.get(args[0]) || [])]];
    if (sql.includes('INSERT INTO user_provider_access')) { access.set(args[0], [{ provider: args[1], enabled: args[2] }]); return [{ affectedRows: 1 }]; }
    if (sql.includes('FROM users WHERE id=')) return [[users.get(Number(args[0]))].filter(Boolean)];
    if (sql.includes('COUNT(*)')) return [[{ total: 0 }]];
    if (sql.includes('INSERT INTO generations')) {
      const [id, user_id, provider, queue_priority, mode, model, aspect_ratio, prompt, credits_cost, provider_cost, provider_cost_unit, image_quality] = args;
      jobs.set(id, { id, user_id, provider, queue_priority, mode, model, aspect_ratio, prompt, credits_cost, provider_cost, provider_cost_unit, image_quality, status: 'queued', media_type: 'image' });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('INSERT INTO credit_transactions')) { transactions.push(args); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE users SET credits=credits-')) { users.get(args[1]).credits -= args[0]; return [{ affectedRows: 1 }]; }
    if (sql.includes('FROM generations WHERE id=')) {
      const row = jobs.get(args[0]); return [[row].filter(row => row && (args.length < 2 || row.user_id === args[1]))];
    }
    if (sql.includes('FROM generation_image_outputs')) return [[outputs.get(args[0])].filter(Boolean)];
    throw new Error('Unexpected test SQL: '+sql);
  }
  const db = { execute, query: execute, async getConnection() { return { execute, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} }; } };
  const dbModule = require('../src/db.js'); const originalDb = { ...dbModule };
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const auth = require('../src/auth.js'); const originalAuth = { ...auth };
  const lookup = req => users.get(Number(req.headers['x-test-user'] || 1));
  auth.requireUser = async req => lookup(req); auth.userFromRequest = async req => lookup(req);
  const wakeModule = require('../src/worker_wakeup.js'), OriginalWakeup = wakeModule.WorkerWakeup;
  const originalWakeUrl = process.env.WORKER_WAKE_URL;
  process.env.WORKER_WAKE_URL = 'https://worker.example.com/live';
  let wakeCalls = 0, finishWake;
  wakeModule.WorkerWakeup = class extends OriginalWakeup {
    constructor(options) { super({ ...options, fetchImpl: async () => {
      wakeCalls++; return new Promise(resolve => { finishWake = resolve; });
    }}); }
  };
  const server = require('../server.js');
  t.after(async () => {
    finishWake?.(Response.json({ ok: true, service: 'mehroz-ai-worker', workerEnabled: true }));
    await new Promise(resolve => server.close(resolve)); Object.assign(dbModule, originalDb); Object.assign(auth, originalAuth);
    wakeModule.WorkerWakeup = OriginalWakeup;
    if(originalWakeUrl===undefined)delete process.env.WORKER_WAKE_URL;else process.env.WORKER_WAKE_URL=originalWakeUrl;
  });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:'+server.address().port;
  async function request(path, { admin = false, method = 'GET', body, user = 1 } = {}) {
    const response = await fetch(origin+path, { method, headers: { 'x-test-user': String(user), ...(admin ? { 'x-admin-token': 'test-admin-only' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await request('/admin/smartaipi/check', { method: 'POST' })).status, 401);
  values.set('smartaipi_credits_per_usd', { setting_key: 'smartaipi_credits_per_usd', setting_value: '100', is_secret: 0 });
  values.set('smartaipi_customer_credits_per_usd', { setting_key: 'smartaipi_customer_credits_per_usd', setting_value: '9400', is_secret: 0 });
  let saved = await request('/admin/provider-settings', { admin: true, method: 'POST', body: { smartAipiApiKey: 'test-secret-only', smartAipiEnabled: true, allowProviderCharges: true } });
  assert.equal(saved.status, 200); assert.equal(saved.data.settings.smartaipi.customerCreditsPerUsd, DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD); assert.equal(saved.data.settings.smartaipi.apiKeyConfigured, true);
  assert.equal(JSON.stringify(saved.data).includes('test-secret-only'), false);
  assert.match(values.get('smartaipi_api_key').setting_value, /^v1:/);
  assert.equal(values.get('smartaipi_api_key').is_secret, 1);
  let config = await request('/api/config'); assert.equal(config.data.imagePricing.filter(m=>m.id.endsWith('_studio')).length, 5);
  assert.equal(JSON.stringify(config.data).includes('test-secret-only'), false);
  assert.equal(config.data.imagePricing.find(m=>m.id===model).costByQuality.medium['1:1'],160);
  const input = { model, prompt: 'A flower', aspectRatio: '3:2' };
  const result = await request('/api/image-generations', { method: 'POST', body: input });
  assert.equal(result.status, 201); assert.equal(result.data.generation.credits_cost, 240);
  assert.equal(result.data.user.credits, 1760); assert.equal(transactions.length, 1);
  const job = jobs.get(result.data.generation.id); assert.equal(job.provider, 'smartaipi'); assert.equal(job.provider_cost_unit, 'usd-estimate');
  assert.equal(job.image_quality, 'medium'); assert.equal(result.data.generation.quality, 'medium');
  assert.equal(job.status, 'queued'); // Queue reservation must not call the paid provider.
  for (const body of [{ ...input, aspectRatio: '4:1' }, { ...input, quality: 'ultra' }, { ...input, prompt: '' }, { ...input, images: [{ data: 'not bytes' }] }]) {
    assert.equal((await request('/api/image-generations', { method: 'POST', body })).status, 400);
  }
  assert.equal(users.get(1).credits, 1760);
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...input, aspectRatio: '9:16', quality: 'high' })) form.append(key, value);
  const highResponse = await fetch(origin+'/api/image-generations', { method: 'POST', body: form });
  assert.equal(highResponse.status, 201); const high = await highResponse.json();
  assert.equal(high.generation.quality, 'high'); assert.equal(high.generation.credits_cost, 807);
  assert.equal(jobs.get(high.generation.id).image_quality, 'high');
  const squareInput = { ...input, model: SMART_IMAGE_MODELS[2].id, aspectRatio: '1:1', quality: 'medium' };
  const square = await request('/api/image-generations', { method: 'POST', body: squareInput, user: 2 });
  assert.equal(square.status, 201); assert.equal(square.data.generation.credits_cost,160);
  // Every saved job triggers wake-up, without delaying HTTP 201 for a cold worker.
  // The pending health request is shared across submissions and cannot bill a model.
  assert.equal(wakeCalls, 1); assert.equal(typeof finishWake, 'function');
  assert.equal(square.data.user.credits,1840);
  users.get(2).credits = 159;
  const counts = [jobs.size, transactions.length];
  assert.equal((await request('/api/image-generations', { method: 'POST', body: squareInput, user: 2 })).status,402);
  assert.equal(users.get(2).credits,159); assert.deepEqual([jobs.size, transactions.length],counts);
  const balance = users.get(1).credits;
  const repriced = await request('/admin/provider-settings', { admin: true, method: 'POST', body: { smartAipiCustomerCreditsPerUsd: 10000 } });
  assert.equal(repriced.status, 200); assert.equal(repriced.data.settings.smartaipi.customerCreditsPerUsd, 10000);
  assert.equal(values.get('smartaipi_customer_credits_per_usd').setting_value, '10000');
  assert.equal(values.get('smartaipi_pricing_revision').setting_value, SMART_IMAGE_PRICING_REVISION);
  assert.equal((await request('/api/config')).data.imagePricing.find(m=>m.id===model).costByQuality.medium['1:1'], 265);
  assert.equal(jobs.get(job.id).credits_cost,240); // Existing reservations retain their price.
  assert.equal((await request('/admin/provider-settings', { admin: true, method: 'POST', body: { smartAipiCustomerCreditsPerUsd: 0 } })).status,400);
  await request('/admin/provider-settings', { admin: true, method: 'POST', body: { smartAipiCustomerCreditsPerUsd: DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD } });

  const disabledQuality = await request('/admin/provider-settings', { admin: true, method: 'POST', body: { smartAipiModels: { [model]: { enabled: true, qualitySourceUsd: { low: 0.003, medium: 0.0265, high: 0 } } } } });
  assert.equal(disabledQuality.status, 200);
  assert.equal(disabledQuality.data.settings.smartaipi.models.find(m=>m.id===model).qualitySourceUsd.high, 0);
  assert.deepEqual((await request('/api/config')).data.imagePricing.find(m=>m.id===model).qualities, ['low', 'medium']);
  assert.equal((await request('/api/image-generations', { method: 'POST', body: { ...input, quality: 'high' } })).status, 400);
  assert.equal(users.get(1).credits, balance);
  job.status = 'completed'; job.output_url = 'db:image'; outputs.set(job.id, { mime_type: 'image/png', image_data: png });
  const mediaPath = '/api/image-generations/'+job.id+'/media';
  const media = await fetch(origin+mediaPath); assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png');
  assert.match(media.headers.get('content-disposition'), /\.png"/); assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  assert.equal((await request(mediaPath, { user: 2 })).status, 404);
  assert.equal((await request('/admin/users/1/providers', { admin: true, method: 'PUT', body: { providers: { smartaipi: false } } })).status, 200);
  assert.equal((await request('/api/config')).data.imagePricing.filter(m=>m.id.endsWith('_studio')).length, 0);
  assert.equal((await request('/api/image-generations', { method: 'POST', body: input })).status, 503);
  access.clear();
  await request('/admin/provider-settings', { admin: true, method: 'POST', body: { smartAipiModels: { [model]: { enabled: false, sourceUsd: 0.0265 } } } });
  assert.equal((await request('/api/image-generations', { method: 'POST', body: input })).status, 400);
  await request('/admin/provider-settings', { admin: true, method: 'POST', body: { smartAipiEnabled: false } });
  assert.equal((await request('/api/image-generations', { method: 'POST', body: input })).status, 503);
  await request('/admin/provider-settings', { admin: true, method: 'POST', body: { smartAipiEnabled: true, allowProviderCharges: false } });
  assert.equal((await request('/api/image-generations', { method: 'POST', body: input })).status, 503);
  await request('/admin/provider-settings', { admin: true, method: 'POST', body: { clearSmartAipiApiKey: true } });
  assert.equal(values.has('smartaipi_api_key'), false); assert.equal(users.get(1).credits, balance);
});

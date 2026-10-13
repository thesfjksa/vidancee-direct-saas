const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { argoMediaModels } = require('../src/argolink_models.js');

test('ArgoLink models are listed for assigned customers, priced with HD enhancement and queued on ArgoLink', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'argo-admin';
  const user = { id: 7, email: 'a@example.com', credits: 5000, status: 'active', plan_code: 'pro', role: 'user' };
  const settings = new Map(Object.entries({ argolink_api_key: 'argo-key', argolink_customer_credits_per_usd: '6000', allow_provider_charges: 'true' })
    .map(([k, v]) => [k, { setting_key: k, setting_value: v, is_secret: 0 }]));
  const rows = argoMediaModels(require('../src/provider/argolink_catalog.json')).map((m, i) => ({
    id: i + 1, provider: 'argolink', provider_model_id: m.providerModelId, public_model_id: m.publicModelId, label: m.label,
    media_type: m.mediaType, tool_name: '', input_schema: '{}', options_json: JSON.stringify(m.options), enabled: 1, available: 1, price_override: null }));
  let access = [];
  const execute = async (sql, args = []) => {
    if (sql.startsWith('CREATE') || /GET_LOCK|RELEASE_LOCK/.test(sql)) return [[{ acquired: 0 }]];
    if (/^(INSERT INTO|DELETE FROM) runtime_boots/.test(sql)) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT setting_key')) return [[...settings.values()]];
    if (sql.startsWith('SELECT provider,enabled')) return [access];
    if (sql.includes('FROM users WHERE id')) return [[user]];
    if (sql.includes('FROM provider_models')) {
      const [provider, publicId, mediaType] = args;
      if (provider !== 'argolink') return [[]];
      return [rows.filter(r => (!publicId || r.public_model_id === publicId) && (!mediaType || r.media_type === mediaType))];
    }
    throw new Error('Unexpected test SQL: ' + sql);
  };
  const db = { execute, query: execute, async getConnection() { return { execute, query: execute, release() {} }; } };
  const dbModule = require('../src/db.js');
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const auth = require('../src/auth.js');
  auth.requireUser = async () => user; auth.userFromRequest = async () => user;
  const created = [];
  const images = require('../src/image_generations.js'), videos = require('../src/generations.js');
  images.createImageGenerationForUser = async (userId, body, options) => { created.push(['image', body, options]); return { id: 'img-1', status: 'queued' }; };
  videos.createGenerationForUser = async (userId, body, options) => { created.push(['video', body, options]); return { id: 'vid-1', status: 'queued' }; };
  const server = require('../server.js');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, body) => { const r = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };

  const config = await (await fetch(origin + '/api/config')).json();
  const nano = config.imagePricing.find(m => m.id === 'argo_nano_banana_pro');
  assert.ok(nano, 'Nano Banana Pro is listed');
  assert.deepEqual(nano.imageSizes, ['1K', '2K', '4K']);
  assert.equal(nano.costTable['16:9||4K'], 202); // $0.03 x 6,720 credits per USD (24 per rupee of cost), rounded up
  const seedance = config.pricing.find(m => m.id === 'argo_seedance_2_5');
  assert.ok(seedance && seedance.supportsAudio);
  assert.ok(config.pricing.some(m => m.id === 'argo_wan_3') && config.pricing.some(m => m.id === 'argo_grok_imagine_video_1_5'));
  assert.equal(config.providerAccess.argolink, true);

  const cost = await post('/api/model-cost', { model: 'argo_seedance_2_0', duration: 10, resolution: '720p', aspectRatio: '16:9' });
  assert.deepEqual(cost.data, { ok: true, cost: 7392, isEstimate: false }); // no fal key: 720p is rendered natively ($1.10 x 6,720)
  // Without fal, 1080p is offered only where ArgoLink renders it.
  assert.deepEqual(config.pricing.find(m => m.id === 'argo_seedance_2_0_fast').resolutions.map(r => r.id), ['720p']);
  assert.deepEqual(seedance.resolutions.map(r => r.id), ['720p', '1080p']);

  // With fal: 720p renders at 480p and 1080p at 720p; both are upscaled to 1080p.
  settings.set('fal_api_key', { setting_key: 'fal_api_key', setting_value: 'fal-key', is_secret: 0 });
  settings.set('fal_customer_credits_per_usd', { setting_key: 'fal_customer_credits_per_usd', setting_value: '6000', is_secret: 0 });
  const hd = await (await fetch(origin + '/api/config')).json();
  assert.ok(hd.pricing.every(m => m.resolutions.every(r => ['720p', '1080p'].includes(r.id))));
  assert.deepEqual(hd.pricing.find(m => m.id === 'argo_seedance_2_0_fast').resolutions.map(r => r.id), ['720p', '1080p']);
  // 10 s at 480p ($0.53) + 10 s upscale ($0.072), each x 6,720 rounded up
  assert.equal((await post('/api/model-cost', { model: 'argo_seedance_2_0', duration: 10, resolution: '720p', aspectRatio: '16:9' })).data.cost, 3562 + 484);
  // 10 s at 720p ($1.10) + 10 s upscale ($0.072), each x 6,720 rounded up
  assert.equal((await post('/api/model-cost', { model: 'argo_seedance_2_0', duration: 10, resolution: '1080p', aspectRatio: '16:9' })).data.cost, 7392 + 484);
  assert.equal((await post('/api/model-cost', { model: 'argo_seedance_2_0', duration: 10, resolution: '480p', aspectRatio: '16:9' })).status, 400);

  const image = await post('/api/image-generations', { model: 'argo_gpt_image_2', prompt: 'A red apple', aspectRatio: '16:9', imageSize: '4K', quality: 'high' });
  assert.equal(image.status, 201);
  const video = await post('/api/generations', { model: 'argo_seedance_2_5', prompt: 'A fox', duration: 5, resolution: '1080p', aspectRatio: '9:16' });
  assert.equal(video.status, 201);
  // 5 s at 720p ($0.98) + 5 s upscale ($0.036), each x 6000
  assert.deepEqual(created.map(([kind, , o]) => [kind, o.provider, o.costOverride, o.providerCostUnit]), [['image', 'argolink', 135, 'usd'], ['video', 'argolink', 6586 + 242, 'usd']]);
  const saved = created[1][2].generationOptions;
  assert.equal(saved.model.providerModelId, 'seedance-2.5');
  assert.deepEqual([saved.resolution, saved.sourceResolution, saved.enhance.credits], ['1080p', '720p', 242]);
  assert.deepEqual(saved.enhance.upscale.input, { target_resolution: '1080p', enhancement_preset: 'general', fidelity: 'high' });
  assert.equal(created[1][1].resolution, '1080p');
  // MiniMax H3 renders 768p for both; both are upscaled to 1080p.
  await post('/api/generations', { model: 'argo_minimax_h3', prompt: 'A fox', duration: 5, resolution: '720p', aspectRatio: '16:9' });
  await post('/api/generations', { model: 'argo_minimax_h3', prompt: 'A fox', duration: 5, resolution: '1080p', aspectRatio: '16:9' });
  assert.deepEqual([created[2][2].generationOptions.sourceResolution, created[2][2].generationOptions.enhance.upscale.input.target_resolution], ['768p', '1080p']);
  assert.deepEqual([created[3][2].generationOptions.sourceResolution, created[3][2].generationOptions.enhance.upscale.input.target_resolution], ['768p', '1080p']);

  // A customer without ArgoLink access sees none of its models and cannot submit.
  access = [{ provider: 'argolink', enabled: 0 }];
  const limited = await (await fetch(origin + '/api/config')).json();
  assert.equal(limited.pricing.some(m => m.id.startsWith('argo_')), false);
  assert.equal((await post('/api/image-generations', { model: 'argo_gpt_image_2', prompt: 'x', aspectRatio: '1:1' })).status, 503);
});

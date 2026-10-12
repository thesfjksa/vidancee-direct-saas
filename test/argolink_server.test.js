const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { argoMediaModels } = require('../src/argolink_models.js');

test('ArgoLink models are listed for assigned customers and their jobs are priced and queued on ArgoLink', async t => {
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
  assert.equal(nano.costTable['16:9||4K'], 180); // $0.03 x 6000 credits per USD
  const seedance = config.pricing.find(m => m.id === 'argo_seedance_2_5');
  assert.ok(seedance && seedance.supportsAudio);
  assert.ok(config.pricing.some(m => m.id === 'argo_wan_3') && config.pricing.some(m => m.id === 'argo_grok_imagine_video_1_5'));
  assert.equal(config.providerAccess.argolink, true);

  const cost = await post('/api/model-cost', { model: 'argo_seedance_2_0', duration: 10, resolution: '720p', aspectRatio: '16:9' });
  assert.deepEqual(cost.data, { ok: true, cost: 6600, isEstimate: false });

  const image = await post('/api/image-generations', { model: 'argo_gpt_image_2', prompt: 'A red apple', aspectRatio: '16:9', imageSize: '4K', quality: 'high' });
  assert.equal(image.status, 201);
  const video = await post('/api/generations', { model: 'argo_seedance_2_5', prompt: 'A fox', duration: 5, resolution: '480p', aspectRatio: '9:16' });
  assert.equal(video.status, 201);
  assert.deepEqual(created.map(([kind, , o]) => [kind, o.provider, o.costOverride, o.providerCostUnit]), [['image', 'argolink', 120, 'usd'], ['video', 'argolink', 2622, 'usd']]);
  assert.equal(created[1][2].generationOptions.model.providerModelId, 'seedance-2.5');

  // A customer without ArgoLink access sees none of its models and cannot submit.
  access = [{ provider: 'argolink', enabled: 0 }];
  const limited = await (await fetch(origin + '/api/config')).json();
  assert.equal(limited.pricing.some(m => m.id.startsWith('argo_')), false);
  assert.equal((await post('/api/image-generations', { model: 'argo_gpt_image_2', prompt: 'x', aspectRatio: '1:1' })).status, 503);
});

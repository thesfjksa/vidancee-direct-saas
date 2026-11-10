'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Api888Client } = require('../src/provider/api888.js');
const { createApi888Performance } = require('../src/api888_performance.js');

test('888API status uses a read-only authenticated request, caches results, and isolates rotated keys', async () => {
  let now = 1000;
  let calls = 0;
  const get = createApi888Performance({
    now: () => now,
    clientForKey: apiKey => new Api888Client({ apiKey, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://888api.xin/v1/model-status');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.authorization, 'Bearer ' + apiKey);
      calls++;
      if (calls === 2) return new Response(null, { status: 429, headers: { 'retry-after': '600' } });
      if (apiKey === 'rotated') return Response.json({ success: true, data: { models: [] } });
      return Response.json({ success: true, data: { updated_at: 1794300000, models: [
        { model_name: 'clip-1', on_sale: true, success_rate: 0, avg_duration_ms: 6000 },
        { model_name: 'image-2', on_sale: true, success_rate: 99.25, avg_duration_ms: null },
        { model_name: 'no-data', on_sale: true, success_rate: null, avg_duration_ms: null },
        { model_name: 'retired', on_sale: false, success_rate: 100, avg_duration_ms: 10 },
      ] } });
    } }),
  });
  const [first, second] = await Promise.all([get('initial'), get('initial')]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.deepEqual(first.models, {
    api888_clip_1: { successRate: 0, averageLatencyMs: 6000 },
    api888_image_2: { successRate: 99.25, averageLatencyMs: null },
  });
  now += 600000;
  assert.deepEqual(await get('initial'), { ...first, stale: true });
  now += 300000;
  assert.equal((await get('initial')).stale, true);
  assert.equal(calls, 2);
  assert.deepEqual((await get('rotated')).models, {});
  assert.equal(calls, 3);
});

test('studio performance requires 888API access and returns only visible catalog models', async t => {
  const { once } = require('node:events');
  Object.assign(process.env, { HOST: '127.0.0.1', PORT: '0', WORKER_ENABLED: 'false' });
  const db = require('../src/db.js');
  const auth = require('../src/auth.js');
  const settings = require('../src/settings.js');
  const catalog = require('../src/provider_models.js');
  const health = require('../src/api888_health.js');
  let signedIn = false;
  let allowed = false;
  let active = false;
  let calls = 0;
  t.mock.method(db, 'dbConfigured', () => true);
  t.mock.method(db, 'initDb', () => new Promise(() => {}));
  t.mock.method(db, 'getPool', () => ({
    execute: async () => [[{ provider: 'api888', enabled: allowed }]],
  }));
  t.mock.method(auth, 'requireUser', async () => {
    if (!signedIn) throw Object.assign(new Error('Sign in required'), { statusCode: 401 });
    return { id: 1 };
  });
  t.mock.method(settings, 'getProviderSettings', async () => ({ api888Enabled: active, api888ApiKey: 'test-key' }));
  t.mock.method(catalog, 'publicProviderCatalog', async provider => {
    assert.equal(provider, 'api888');
    return { video: [{ id: 'api888_clip' }, { id: 'api888_hidden' }], image: [{ id: 'api888_image' }] };
  });
  t.mock.method(health, 'loadApi888Health', async () => ({
    statuses: { clip: 'available', hidden: 'disabled', image: 'available' },
  }));
  t.mock.method(Api888Client.prototype, 'modelStatus', async function () {
    assert.equal(this.apiKey, 'test-key');
    calls++;
    return { models: ['clip', 'hidden', 'image', 'unlisted'].map(model_name => ({
      model_name, on_sale: true, success_rate: 75, avg_duration_ms: 2000,
    })) };
  });
  const server = require('../server.js');
  try {
    if (!server.listening) await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port + '/api/api888-performance';
    assert.equal((await fetch(url)).status, 401);
    signedIn = true;
    assert.equal((await fetch(url)).status, 403);
    allowed = true;
    assert.equal((await fetch(url)).status, 403);
    assert.equal(calls, 0);
    active = true;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json()).models, {
      api888_clip: { successRate: 75, averageLatencyMs: 2000 },
      api888_image: { successRate: 75, averageLatencyMs: 2000 },
    });
    assert.equal(calls, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

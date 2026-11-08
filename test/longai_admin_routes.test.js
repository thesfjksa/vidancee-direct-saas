'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

test('LONG AI import saves the local model using an already verified key during an upstream outage', async t => {
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.ADMIN_TOKEN = 'fixture-admin';
  process.env.WORKER_ENABLED = 'false';

  let savedKey = '';
  const db = require('../src/db.js');
  t.mock.method(db, 'dbConfigured', () => true);
  t.mock.method(db, 'initDb', () => new Promise(() => {}));
  const settings = require('../src/settings.js');
  t.mock.method(settings, 'getProviderSettings', async () => ({ longAiApiKey: savedKey }));
  const imports = [];
  const catalog = require('../src/provider_models.js');
  t.mock.method(catalog, 'syncProviderModels', async (provider, models) => {
    imports.push({ provider, models });
    return models;
  });
  const { LongAiClient } = require('../src/provider/longai.js');
  const verify = t.mock.method(LongAiClient.prototype, 'verifyModel', async () => {
    throw new Error('LONG AI connection timed out from the CMMTools server.');
  });

  const server = require('../server.js');
  t.after(() => new Promise(resolve => server.close(resolve)));
  if (!server.listening) await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/admin/longai/import';
  const submit = (rates, admin = true) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-token': 'fixture-admin' } : {}) },
    body: JSON.stringify({ rates }),
  });

  const rates = { '480p': 0.01, '720p': 0.02 };
  assert.equal((await submit(rates, false)).status, 401);
  const missingKey = await submit(rates);
  assert.equal(missingKey.status, 400);
  assert.match((await missingKey.json()).error, /Save a LONG AI API key first/);
  savedKey = 'fixture-verified-key';
  assert.equal((await submit({ ...rates, '720p': 0 })).status, 400);

  const imported = await submit(rates);
  assert.equal(imported.status, 200);
  const result = await imported.json();
  assert.equal(verify.mock.callCount(), 0);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].provider, 'longai');
  assert.equal(result.models[0].providerModelId, 'seedance-2.0-mini');
  assert.deepEqual(result.models[0].options.pricing.video_duration_pricing, [
    { resolution: '480p', cost_per_second: 0.01 },
    { resolution: '720p', cost_per_second: 0.02 },
  ]);

  const tests = new URL('/admin/longai/video-tests', url);
  const headers = { 'x-admin-token': 'fixture-admin' };
  assert.equal((await fetch(tests)).status, 401);
  const marketplace = t.mock.method(LongAiClient.prototype, 'videoMarketplace', async () => '<html>Temporary error</html>');
  const discovered = await (await fetch(tests, { headers })).json();
  assert.equal(discovered.source, 'snapshot');
  assert.equal(discovered.keyConfigured, true);
  assert.equal(discovered.models.length, 31);
  assert.equal(marketplace.mock.callCount(), 1);

  const model = new URL(tests.pathname + '/model?model=kling-2.5', tests);
  assert.equal((await fetch(model)).status, 401);
  const checked = await (await fetch(model, { headers })).json();
  assert.equal(checked.status, 'error');
  assert.deepEqual(verify.mock.calls[0].arguments, ['kling-2.5', 12000]);
  model.searchParams.set('model', '../videos');
  assert.equal((await fetch(model, { headers })).status, 400);
  assert.equal(verify.mock.callCount(), 1);
});

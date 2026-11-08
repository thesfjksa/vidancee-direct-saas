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
  let paidEnabled = false;
  let visibleModel;
  let renderTableReady = false;
  let queuedRender;
  const db = require('../src/db.js');
  t.mock.method(db, 'dbConfigured', () => true);
  t.mock.method(db, 'initDb', () => new Promise(() => {}));
  const renderDb = {
    async query(sql) {
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }]];
      assert.match(sql, /SELECT RELEASE_LOCK|SELECT 1 FROM longai_render_tests LIMIT 0/);
      return [[]];
    },
    async getConnection() { return renderDb; },
    release() {},
    async execute(sql, args) {
      if (!renderTableReady) {
        assert.match(sql, /FROM longai_render_tests/);
        throw Object.assign(new Error('Optional render table is not created.'), { code: 'ER_NO_SUCH_TABLE' });
      }
      if (sql.startsWith('INSERT INTO longai_render_tests')) {
        queuedRender = { id: args[0], model: args[1], status: 'queued' };
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE longai_render_tests')) return [{ affectedRows: 0 }];
      assert.match(sql, /SELECT.*FROM longai_render_tests/s);
      return [queuedRender ? [queuedRender] : []];
    },
  };
  t.mock.method(db, 'getPool', () => renderDb);
  const settings = require('../src/settings.js');
  t.mock.method(settings, 'getProviderSettings', async () => ({
    longAiApiKey: savedKey, longAiEnabled: paidEnabled, allowProviderCharges: paidEnabled,
  }));
  const imports = [];
  const catalog = require('../src/provider_models.js');
  t.mock.method(catalog, 'syncProviderModels', async (provider, models) => {
    imports.push({ provider, models });
    return models;
  });
  const { LongAiClient } = require('../src/provider/longai.js');
  const verify = t.mock.method(LongAiClient.prototype, 'verifyModel', async id => {
    if (visibleModel && id === visibleModel) return;
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

  const renders = new URL(tests.pathname + '/renders', tests);
  assert.equal((await fetch(renders)).status, 401);
  assert.deepEqual(await (await fetch(renders, { headers })).json(), { ok: true, tests: [], paidEnabled: false });
  const paid = body => fetch(renders, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await paid({})).status, 400);
  assert.equal((await paid({ id: '12345678-1234-4abc-8abc-123456789abc', model: 'kling-2.5', confirmPaid: true })).status, 409);
  paidEnabled = true;
  const blocked = await paid({ id: '12345678-1234-4abc-8abc-123456789abc', model: 'kling-2.5', confirmPaid: true });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /Check the model with the saved key/);
  visibleModel = 'kling-2.5';
  model.searchParams.set('model', visibleModel);
  const visible = await (await fetch(model, { headers })).json();
  assert.equal(visible.status, 'visible');
  assert.ok(visible.renderProof.expiresAt > Date.now());
  assert.match(visible.renderProof.signature, /^[a-z0-9_-]{43}$/i);
  renderTableReady = true;
  const accepted = await paid({
    id: '12345678-1234-4abc-8abc-123456789abc', model: visibleModel, confirmPaid: true, renderProof: visible.renderProof,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual((await accepted.json()).test, queuedRender);
  assert.equal(queuedRender.model, visibleModel);
});

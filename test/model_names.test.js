const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

test('Video Studio lists MiniMax H3 and the admin can rename any model', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'test-admin-only';
  const user = { id: 1, email: 'test1@example.com', credits: 50, status: 'active', plan_code: 'pro', role: 'user' };
  // vgenv is configured; no other source is.
  const settings = new Map([['vgenv_api_key', 'vg-test']]);
  async function execute(sql, args = []) {
    if (sql.includes('SELECT setting_key')) return [[...settings].map(([setting_key, setting_value]) => ({ setting_key, setting_value, is_secret: 0 }))];
    if (sql.startsWith('INSERT INTO app_settings')) { settings.set(args[0], args[1]); return [{ affectedRows: 1 }]; }
    if (/^\s*SELECT/i.test(sql)) return [[]];
    return [{ affectedRows: 0 }];
  }
  const db = { execute, query: execute };
  const dbModule = require('../src/db.js'); const originalDb = { ...dbModule };
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const auth = require('../src/auth.js'); const originalAuth = { ...auth };
  auth.requireUser = async () => user; auth.userFromRequest = async () => user;
  const server = require('../server.js');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    Object.assign(dbModule, originalDb); Object.assign(auth, originalAuth);
  });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const admin = { 'content-type': 'application/json', 'x-admin-token': 'test-admin-only' };

  let config = await (await fetch(origin + '/api/config')).json();
  // Seedance Lite (Vidancee/CreatePulse) was removed.
  assert.equal(config.pricing.some(m => m.id === 'seedance_2.5' || m.id === 'seedance_2.0_fast'), false);
  const h3 = config.pricing.find(m => m.id === 'minimax_h3');
  assert.equal(h3.label, 'MiniMax H3 Base · up to 15 s');
  assert.equal(h3.warning, undefined);
  assert.deepEqual(h3.resolutions.map(r => r.id), ['480p', '768p']);
  assert.equal(h3.defaultResolution, '768p');
  assert.ok(h3.durations.length && h3.aspectRatios.length && h3.capabilities.image.supported);
  assert.deepEqual(config.cartoon.pricing.map(m => m.id), ['minimax_h3', 'minimax_h3_cinematic', 'minimax_h3_origin']);

  const list = await (await fetch(origin + '/admin/model-names', { headers: admin })).json();
  assert.ok(list.models.some(m => m.key === 'video:minimax_h3' && m.vendor === 'vgenv' && m.defaultName === 'MiniMax H3 Base · up to 15 s' && m.name === ''));
  assert.ok(list.models.some(m => m.key === 'cartoon:minimax_h3'));
  assert.equal(list.models.some(m => m.key.endsWith(':seedance_2.5')), false);

  const save = body => fetch(origin + '/admin/model-names', { method: 'POST', headers: admin, body: JSON.stringify(body) });
  assert.equal((await save({ names: { 'video:minimax_h3': 'MiniMax Long' } })).status, 200);
  assert.equal((await save({ names: { 'audio:x': 'Nope' } })).status, 400);
  // HD enhance is set here too, for ArgoLink and Higgsfield video models only.
  assert.equal((await save({ hd: { minimax_h3: false } })).status, 400);
  assert.equal((await save({ hd: { argo_seedance_2_5: false } })).status, 200);
  assert.deepEqual(JSON.parse(settings.get('argolink_hd_off_models')), ['argo_seedance_2_5']);
  await save({ hd: { argo_seedance_2_5: true } });
  assert.deepEqual(JSON.parse(settings.get('argolink_hd_off_models')), []);
  assert.equal((await save({ names: { 'video:minimax_h3': 'x'.repeat(81) } })).status, 400);
  assert.equal((await fetch(origin + '/admin/model-names', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

  config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.pricing.find(m => m.id === 'minimax_h3').label, 'MiniMax Long');
  // Names are per studio: Cartoon Studio keeps its own.
  assert.equal(config.cartoon.pricing.find(m => m.id === 'minimax_h3').label, 'MiniMax H3 Base');

  // An empty name goes back to the source's name.
  await save({ names: { 'video:minimax_h3': '' } });
  config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.pricing.find(m => m.id === 'minimax_h3').label, 'MiniMax H3 Base · up to 15 s');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

test('Video Studio lists Seedance on Vidancee/CreatePulse and the admin can rename any model', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'test-admin-only';
  const user = { id: 1, email: 'test1@example.com', credits: 50, status: 'active', plan_code: 'pro', role: 'user' };
  // Vidancee is configured; no other source is.
  const settings = new Map([['vidancee_email', 'ops@example.com'], ['vidancee_password', 'secret']]);
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
  const seedance = config.pricing.find(m => m.id === 'seedance_2.5');
  assert.ok(seedance, 'Seedance 2.5 is in Video Studio');
  assert.equal(seedance.label, 'Seedance 2.5 · up to 30 s');
  assert.ok(seedance.durations.length && seedance.aspectRatios.length && seedance.capabilities.image.supported);
  assert.ok(config.pricing.some(m => m.id === 'seedance_2.0_fast'));
  assert.equal(config.pricing.some(m => m.id === 'minimax_h3'), false);

  const list = await (await fetch(origin + '/admin/model-names', { headers: admin })).json();
  assert.ok(list.models.some(m => m.key === 'video:seedance_2.5' && m.vendor === 'Vidancee / CreatePulse' && m.defaultName === 'Seedance 2.5 · up to 30 s' && m.name === ''));
  assert.ok(list.models.some(m => m.key === 'cartoon:seedance_2.5'));

  const save = body => fetch(origin + '/admin/model-names', { method: 'POST', headers: admin, body: JSON.stringify(body) });
  assert.equal((await save({ names: { 'video:seedance_2.5': 'Seedance Long' } })).status, 200);
  assert.equal((await save({ names: { 'audio:x': 'Nope' } })).status, 400);
  assert.equal((await save({ names: { 'video:seedance_2.5': 'x'.repeat(81) } })).status, 400);
  assert.equal((await fetch(origin + '/admin/model-names', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

  config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.pricing.find(m => m.id === 'seedance_2.5').label, 'Seedance Long');
  // Names are per studio: Cartoon Studio keeps its own.
  assert.equal(config.cartoon.pricing.find(m => m.id === 'seedance_2.5').label, 'Seedance 2.5');

  // An empty name goes back to the source's name.
  await save({ names: { 'video:seedance_2.5': '' } });
  config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.pricing.find(m => m.id === 'seedance_2.5').label, 'Seedance 2.5 · up to 30 s');
});

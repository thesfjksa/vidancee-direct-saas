'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

test('AIVID diagnostics require admin auth and never expose session credentials', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_TOKEN = 'aivid-test-admin';
  process.env.AIVID_BROWSERLESS_CONNECT_URL = 'wss://production-sfo.browserless.io/session/test?token=do-not-expose';
  process.env.AIVID_ENABLED = 'false';
  const dbModule = require('../src/db.js'), original = { ...dbModule };
  const settings = new Map();
  const execute = async (sql, args = []) => {
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('RELEASE_LOCK')) return [[{}]];
    if (sql.startsWith('SELECT setting_key')) return [[...settings.values()]];
    if (sql.startsWith('INSERT INTO app_settings')) {
      settings.set(args[0], { setting_key: args[0], setting_value: args[1], is_secret: args[2] });
      return [{ affectedRows: 1 }];
    }
    return /^\s*SELECT/i.test(sql) ? [[]] : [{ affectedRows: 0 }];
  };
  const db = { query: execute, execute, getConnection: async () => ({ query: execute, release() {} }) };
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db,
    initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const server = require('../server.js');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    Object.assign(dbModule, original); delete process.env.AIVID_BROWSERLESS_CONNECT_URL;
  });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin + '/admin/aivid/status')).status, 401);
  for (const route of ['/admin/aivid/settings', '/admin/aivid/rdp/pairing', '/admin/aivid/login', '/admin/aivid/login/12345678-1234-1234-1234-123456789012/finish', '/admin/aivid/login/12345678-1234-1234-1234-123456789012/cancel'])
    assert.equal((await fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const headers = { 'x-admin-token': 'aivid-test-admin', 'content-type': 'application/json' };
  const response = await fetch(origin + '/admin/aivid/status', { headers });
  assert.equal(response.status, 200);
  const text = await response.text(); assert.equal(text.includes('do-not-expose'), false);
  const body = JSON.parse(text);
  assert.equal(body.configured, true); assert.equal(body.enabled, false); assert.equal(body.customerModelEnabled, false);
  delete process.env.AIVID_BROWSERLESS_CONNECT_URL;
  const check = await fetch(origin + '/admin/aivid/check', { method: 'POST', headers, body: '{}' });
  assert.equal(check.status, 503); // No browser, Generate click or wallet debit.
  const save = await fetch(origin + '/admin/aivid/settings', { method: 'POST', headers,
    body: JSON.stringify({ apiKey: 'private-browserless-test-key', endpoint: 'https://production-sfo.browserless.io', ttlDays: 1 }) });
  assert.equal(save.status, 200);
  const saved = await save.text();
  assert.equal(saved.includes('private-browserless-test-key'), false);
  const encrypted = settings.get('aivid_browserless_config');
  assert.equal(encrypted.is_secret, 1); assert.match(encrypted.setting_value, /^v1:/);
  assert.equal(encrypted.setting_value.includes('private-browserless-test-key'), false);
  const preserved = await fetch(origin + '/admin/aivid/settings', { method: 'POST', headers, body: JSON.stringify({ apiKey: '', ttlDays: 7 }) });
  assert.equal(preserved.status, 200);
  const raw = await require('../src/settings.js').getSettingValue('aivid_browserless_config');
  assert.equal(JSON.parse(raw).apiKey, 'private-browserless-test-key');
  assert.equal(JSON.parse(raw).ttlDays, 7);
  const script = await fetch(origin + '/aivid-admin.js?v=1');
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
});

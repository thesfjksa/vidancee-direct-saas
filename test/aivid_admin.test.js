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
  const execute = async sql => /^\s*SELECT/i.test(sql) ? [[]] : [{ affectedRows: 0 }];
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => ({ query: execute, execute }),
    initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const server = require('../server.js');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    Object.assign(dbModule, original); delete process.env.AIVID_BROWSERLESS_CONNECT_URL;
  });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin + '/admin/aivid/status')).status, 401);
  const headers = { 'x-admin-token': 'aivid-test-admin', 'content-type': 'application/json' };
  const response = await fetch(origin + '/admin/aivid/status', { headers });
  assert.equal(response.status, 200);
  const text = await response.text(); assert.equal(text.includes('do-not-expose'), false);
  const body = JSON.parse(text);
  assert.equal(body.configured, true); assert.equal(body.enabled, false); assert.equal(body.customerModelEnabled, false);
  delete process.env.AIVID_BROWSERLESS_CONNECT_URL;
  const check = await fetch(origin + '/admin/aivid/check', { method: 'POST', headers, body: '{}' });
  assert.equal(check.status, 503); // No browser, Generate click or wallet debit.
});

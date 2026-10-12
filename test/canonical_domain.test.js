const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

test('CANONICAL_URL moves visitors of the old domain to the new one without breaking provider links', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false';
  process.env.CANONICAL_URL = 'https://cmmtools.site';
  const dbModule = require('../src/db.js');
  Object.assign(dbModule, { dbConfigured: () => false });
  const server = require('../server.js');
  t.after(async () => { delete process.env.CANONICAL_URL; server.closeAllConnections(); await new Promise(r => server.close(r)); });
  if (!server.listening) await once(server, 'listening');
  const get = (path, host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path, headers: { host } }, res => { res.resume(); resolve(res); }).on('error', reject);
  });
  let r = await get('/?ref=ad', 'ai.mehroz.online');
  assert.equal(r.statusCode, 301); assert.equal(r.headers.location, 'https://cmmtools.site/?ref=ad');
  r = await get('/admin-console', 'ai.mehroz.online');
  assert.equal(r.headers.location, 'https://cmmtools.site/admin-console');
  assert.equal((await get('/', 'cmmtools.site')).statusCode, 200);
  assert.equal((await get('/live', 'ai.mehroz.online')).statusCode, 200);
  assert.notEqual((await get('/provider-assets/0f8fad5b-d9cb-469f-a165-70867728950e/0?sig=x', 'ai.mehroz.online')).statusCode, 301);
  assert.notEqual((await get('/api/config', 'ai.mehroz.online')).statusCode, 301);
  assert.notEqual((await get('/brand.css', 'ai.mehroz.online')).statusCode, 301);
});

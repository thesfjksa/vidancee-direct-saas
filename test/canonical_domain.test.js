const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

test('visitors of the old domain move to cmmtools.site without any setting, without breaking provider links', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false';
  delete process.env.CANONICAL_URL;
  const dbModule = require('../src/db.js');
  Object.assign(dbModule, { dbConfigured: () => false });
  const server = require('../server.js');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
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
  // Other hosts (a staging copy, a preview) are left alone unless CANONICAL_URL is set.
  assert.equal((await get('/', 'staging.example.com')).statusCode, 200);
  process.env.CANONICAL_URL = 'https://cmmtools.site';
  assert.equal((await get('/', 'staging.example.com')).headers.location, 'https://cmmtools.site/');
  delete process.env.CANONICAL_URL;
});

test('links handed to providers use cmmtools.site even if APP_URL still holds the old domain', () => {
  const { currentOrigin, currentUrl, appUrl } = require('../src/app_url.js');
  assert.equal(currentOrigin('https://ai.mehroz.online/'), 'https://cmmtools.site');
  assert.equal(currentOrigin('https://cmmtools.site'), 'https://cmmtools.site');
  assert.equal(currentOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(currentUrl('https://ai.mehroz.online/admin/higgsfield/oauth/callback'), 'https://cmmtools.site/admin/higgsfield/oauth/callback');
  const before = process.env.APP_URL;
  process.env.APP_URL = 'https://ai.mehroz.online'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const { providerAssetUrl } = require('../src/provider/assets.js');
  assert.match(providerAssetUrl('abc', 0), /^https:\/\/cmmtools\.site\/provider-assets\/abc\/0\?sig=[0-9a-f]{64}$/);
  assert.equal(appUrl(), 'https://cmmtools.site');
  if (before === undefined) delete process.env.APP_URL; else process.env.APP_URL = before;
});

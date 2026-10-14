const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

test('signed-out visitors get the landing page at /, the studio stays at /app', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false';
  delete process.env.CANONICAL_URL;
  const dbModule = require('../src/db.js');
  Object.assign(dbModule, { dbConfigured: () => false });
  const server = require('../server.js');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  if (!server.listening) await once(server, 'listening');
  const page = (path, cookie) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path, headers: { host: 'cmmtools.site', ...(cookie ? { cookie } : {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  const landing = await page('/');
  assert.equal(landing.status, 200);
  assert.match(landing.body, /href="\/app\?signup=1"/);
  assert.doesNotMatch(landing.body, /id="registerTab"/);
  const studio = await page('/app?signup=1');
  assert.equal(studio.status, 200);
  assert.match(studio.body, /id="registerTab"/);
  // A signed-in customer opening / goes straight to the studio.
  assert.match((await page('/', 'theme=light; cmm_session=abc')).body, /id="registerTab"/);
  // The public Pricing page, linked from the home menu.
  const pricing = await page('/pricing');
  assert.equal(pricing.status, 200);
  assert.match(pricing.body, /Creator[\s\S]*Studio[\s\S]*Enterprise/);
  assert.match(landing.body, /href="\/pricing"/);
  // Every studio, Voice included, is on unless the admin turns a source off.
  const config = JSON.parse((await page('/api/config')).body);
  assert.ok(Object.values(config.providerAccess).every(Boolean));
  assert.equal(config.providerAccess.vibi, true);
});

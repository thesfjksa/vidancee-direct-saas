const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

// Some provider downloaders check a reference file with HEAD before fetching it.
test('reference files for providers answer HEAD with their headers and no body', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false';
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'head-test-secret';
  const file = Buffer.from('reference-bytes');
  const db = { execute: async sql => {
    if (sql.includes('FROM generation_media')) return [[{ mime_type: 'image/png', media_data: file }]];
    if (sql.includes('FROM generation_images')) return [[{ filename: 'a.png', mime_type: 'image/png', image_data: file }]];
    if (sql.includes('SELECT setting_key')) return [[]];
    return [[]];
  } };
  db.query = db.execute;
  const dbModule = require('../src/db.js');
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const { providerAssetUrl } = require('../src/provider/assets.js');
  const server = require('../server.js');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  if (!server.listening) await once(server, 'listening');

  const call = (method, url) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: u.pathname + u.search, headers: { host: 'cmmtools.site' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (const url of [providerAssetUrl(id, 0), providerAssetUrl(id, 0).replace('/provider-assets/', '/provider-media/')]) {
    const head = await call('HEAD', url), get = await call('GET', url);
    assert.deepEqual([head.status, head.headers['content-type'], head.headers['content-length'], head.body.length], [200, 'image/png', String(file.length), 0]);
    assert.deepEqual([get.status, get.body.toString()], [200, 'reference-bytes']);
    assert.equal((await call('HEAD', url.replace(/sig=\w+/, 'sig=bad'))).status, 403);
  }
});

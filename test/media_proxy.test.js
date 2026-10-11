const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const RESET_ID = '11111111-1111-4111-8111-111111111111';
const SLOW_ID = '22222222-2222-4222-8222-222222222222';

test('provider media proxy survives upstream resets and releases aborted downloads', { timeout: 20000 }, async t => {
  let upstreamClosedByProxy = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/reset') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 500000 });
      res.write(Buffer.alloc(20000));
      setTimeout(() => req.socket.destroy(), 50);
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 50000000 });
    const timer = setInterval(() => res.write(Buffer.alloc(16384)), 20);
    res.on('close', () => { clearInterval(timer); upstreamClosedByProxy++; });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamOrigin = 'http://127.0.0.1:' + upstream.address().port;

  const rows = new Map([
    [RESET_ID, { id: RESET_ID, user_id: 1, media_type: 'video', status: 'completed', output_url: upstreamOrigin + '/reset' }],
    [SLOW_ID, { id: SLOW_ID, user_id: 1, media_type: 'video', status: 'completed', output_url: upstreamOrigin + '/slow' }],
  ]);
  async function execute(sql, args = []) {
    if (sql.includes('FROM generations WHERE id')) return [[rows.get(args[0])].filter(Boolean)];
    throw new Error('Unexpected test SQL: ' + sql);
  }
  const db = { execute, query: execute };

  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.WORKER_WAKE_URL = '';
  const dbModule = require('../src/db.js'); const originalDb = { ...dbModule };
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const auth = require('../src/auth.js'); const originalAuth = { ...auth };
  auth.requireUser = async () => ({ id: 1, email: 'test@example.com', status: 'active' });
  const server = require('../server.js');
  t.after(async () => {
    server.closeAllConnections(); upstream.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    Object.assign(dbModule, originalDb); Object.assign(auth, originalAuth);
  });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  // A provider connection reset mid-stream previously escaped as an unhandled
  // stream 'error' event and terminated the whole web process.
  for (let i = 0; i < 3; i++) {
    const response = await fetch(origin + '/api/generations/' + RESET_ID + '/media');
    assert.equal(response.status, 200);
    await response.arrayBuffer().catch(() => {});
  }
  const live = await fetch(origin + '/live');
  assert.equal(live.status, 200);

  // A viewer cancelling playback must also cancel the provider download.
  const controller = new AbortController();
  const response = await fetch(origin + '/api/generations/' + SLOW_ID + '/media', { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  const deadline = Date.now() + 3000;
  while (upstreamClosedByProxy === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(upstreamClosedByProxy, 1);
  assert.equal((await fetch(origin + '/live')).status, 200);
});

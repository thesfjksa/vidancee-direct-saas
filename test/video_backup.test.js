const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { inflateRawSync } = require('node:zlib');
const { CHUNK_SIZE } = require('../src/video_outputs.js');

function readZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return files;
}

test('Library backup downloads the complete owned video history through the signed-in route', { timeout: 15000 }, async t => {
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.WORKER_ENABLED = 'false';
  process.env.WORKER_WAKE_URL = '';

  let stopSlowVideo;
  const slowVideoClosed = new Promise(resolve => { stopSlowVideo = resolve; });
  let startSlowVideo;
  const slowVideoStarted = new Promise(resolve => { startSlowVideo = resolve; });
  const upstream = http.createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>Expired provider link</html>');
    }
    if (req.url === '/interrupted') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 200000 });
      res.write(Buffer.alloc(40000));
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      const timer = setInterval(() => res.write(Buffer.alloc(65536)), 20);
      res.once('close', () => { clearInterval(timer); stopSlowVideo(); });
      startSlowVideo();
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end('legacy video');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const legacyUrl = 'http://127.0.0.1:' + upstream.address().port;

  const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const row = (n, overrides = {}) => ({
    id: id(n), user_id: 1, status: 'completed', media_type: 'video',
    output_url: 'db:video', prompt: 'پرامپٹ ' + n + '\nSecond line',
    created_at: new Date('2026-11-07T00:00:00Z'), ...overrides,
  });
  const owned = Array.from({ length: 105 }, (_, i) => row(i + 1));
  Object.assign(owned[0], { output_url: 'r2:private.mp4' });
  Object.assign(owned[1], { output_url: 'gdrive:drive_file_1' });
  Object.assign(owned[2], { output_url: legacyUrl + '/video' });
  Object.assign(owned[3], { output_url: legacyUrl + '/missing' });
  Object.assign(owned[4], { output_url: null });
  const rows = [...owned, row(106, { user_id: 2 }), row(107, { status: 'failed' }),
    row(108, { media_type: 'image' }), row(109, { user_id: 4, output_url: legacyUrl + '/interrupted' }),
    row(110, { user_id: 5, output_url: legacyUrl + '/slow' })];
  const big = Buffer.alloc(CHUNK_SIZE + 9, 42);
  const stored = new Map(owned.slice(5).map(r => [r.id, r.id === id(105) ? big : Buffer.from('saved video')]));
  let firstUserQueries = 0;
  const db = {
    async execute(sql, args) {
      if (sql.includes('FROM generations WHERE')) {
        assert.match(sql, /user_id = \? AND media_type = 'video' AND status = 'completed'/);
        const [userId, before, , beforeId] = args;
        if (userId === 1) firstUserQueries++;
        return [rows.filter(r => r.user_id === userId && r.media_type === 'video' && r.status === 'completed' &&
          (!before || r.created_at < before || (+r.created_at === +before && r.id < beforeId)))
          .sort((a, b) => b.id.localeCompare(a.id)).slice(0, 100)];
      }
      if (sql.includes('FROM generation_video_outputs')) return [[{ byte_length: stored.get(args[0]).length }]];
      if (sql.includes('FROM generation_video_chunks')) {
        return [[{ video_data: stored.get(args[0]).subarray(args[1] * CHUNK_SIZE, (args[1] + 1) * CHUNK_SIZE) }]];
      }
      throw new Error('Unexpected test SQL: ' + sql);
    },
  };
  const dbModule = require('../src/db.js');
  Object.assign(dbModule, { getPool: () => db, dbConfigured: () => true, initDb: async () => true });
  const auth = require('../src/auth.js');
  auth.requireUser = async req => {
    const session = /^test-user=([1345])$/.exec(req.headers.cookie || '');
    if (!session) throw Object.assign(new Error('Sign in required.'), { statusCode: 401 });
    return { id: Number(session[1]) };
  };
  const videoResponse = text => new Response(text, { headers: { 'content-type': 'video/mp4' } });
  require('../src/object_storage.js').configuredStorage = async ({ requireEnabled }) => {
    assert.equal(requireEnabled, false);
    return { get: async key => { assert.equal(key, 'private.mp4'); return videoResponse('cloud video'); } };
  };
  require('../src/google_drive.js').configuredDrive = async ({ requireEnabled }) => {
    assert.equal(requireEnabled, false);
    return { getVideo: async key => { assert.equal(key, 'drive_file_1'); return videoResponse('Drive video'); } };
  };

  const server = require('../server.js');
  if (!server.listening) await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const path = origin + '/api/generations/backup';
  const studio = await (await fetch(origin + '/app')).text();
  assert.match(studio, /href="\/api\/generations\/backup" download[^>]*>Download backup<\/a>/);
  assert.equal((await fetch(path)).status, 401);
  const response = await fetch(path + '?userId=2', { headers: { cookie: 'test-user=1' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /^attachment;.*\.zip"/);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  const files = readZip(Buffer.from(await response.arrayBuffer()));
  assert.equal(firstUserQueries, 2);
  assert.equal(files.size, 209);
  assert.equal(files.get('prompts/' + id(1) + '.txt').toString(), owned[0].prompt);
  assert.equal(files.get('videos/' + id(1) + '.mp4').toString(), 'cloud video');
  assert.equal(files.get('videos/' + id(2) + '.mp4').toString(), 'Drive video');
  assert.equal(files.get('videos/' + id(3) + '.mp4').toString(), 'legacy video');
  assert.deepEqual(files.get('videos/' + id(105) + '.mp4'), big);
  for (const n of [4, 5]) {
    assert.ok(files.has('prompts/' + id(n) + '.txt'));
    assert.ok(files.get('unavailable-videos.txt').toString().includes(id(n)));
    assert.ok(!files.has('videos/' + id(n) + '.mp4'));
  }
  for (const n of [106, 107, 108]) assert.ok(!files.has('prompts/' + id(n) + '.txt'));

  const empty = await fetch(path, { headers: { cookie: 'test-user=3' } });
  const emptyFiles = readZip(Buffer.from(await empty.arrayBuffer()));
  assert.deepEqual([...emptyFiles.keys()], ['README.txt']);

  const interrupted = await fetch(path, { headers: { cookie: 'test-user=4' } });
  await assert.rejects(interrupted.arrayBuffer());

  const controller = new AbortController();
  const slow = await fetch(path, { headers: { cookie: 'test-user=5' }, signal: controller.signal });
  await slowVideoStarted;
  await slow.body.cancel();
  controller.abort();
  await slowVideoClosed;
  assert.equal((await fetch(origin + '/live')).status, 200);
});

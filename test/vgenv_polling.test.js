const test = require('node:test');
const assert = require('node:assert/strict');
const { VgenvClient } = require('../src/provider/vgenv.js');
const { GenerationWorker } = require('../src/worker_admin_settings.js');

for (const stage of ['headers', 'body']) {
  test('vgenv status deadline aborts a stalled ' + stage + ' read', async t => {
    // AbortSignal.timeout is unref'ed; model an open network handle.
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
      calls++;
      const stalled = () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      if (stage === 'headers') return stalled();
      return { ok: true, status: 200, text: stalled };
    });
    const client = new VgenvClient({ apiKey: 'test-only' });
    await assert.rejects(client.getVideo('existing-job', { v3: true, timeoutMs: 20 }), { name: 'TimeoutError' });
    assert.equal(calls, 1, 'a timeout must not trigger an endpoint retry');
  });
}

test('version fallbacks share one status deadline and preserve paid submission behavior', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes('/v3/') || url.includes('/v1/videos/existing')) return Response.json({}, { status: 404 });
    return Response.json({ id: 'existing', status: 'succeeded', output: { url: 'https://media.example/video.mp4' } });
  });
  const client = new VgenvClient({ apiKey: 'test-only' });
  const video = await client.getVideo('existing', { v3: true });
  assert.equal(video.outputUrl, 'https://media.example/video.mp4');
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.signal, calls[0].signal);
  await client.generateVideo({ prompt: 'test', duration: 4, aspectRatio: '9:16', idempotencyKey: 'stable-key' });
  assert.equal(calls[3].method, 'POST');
  assert.equal(calls[3].signal, undefined);
  assert.equal(calls[3].headers['Idempotency-Key'], 'stable-key');
});

test('a stalled status read does not block other jobs; read failures preserve existing jobs', async t => {
  const worker = new GenerationWorker();
  t.after(() => worker.stop());
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: 'local-' + i, user_id: 1, provider_job_id: 'remote-' + i, model: 'minimax_h3_origin' }));
  const writes = [], seen = [];
  let active = 0, maximum = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  worker.vgenv = { getVideo: async id => {
    seen.push(id); active++; maximum = Math.max(maximum, active);
    try {
      if (id === 'remote-0') { await blocked; throw Object.assign(new Error('stalled read'), { name: 'TimeoutError' }); }
      await new Promise(resolve => setImmediate(resolve));
      return { status: 'succeeded', outputUrl: 'https://media.example/' + id + '.mp4', price: 0.01 };
    } finally { active--; }
  } };
  const db = { query: async () => [rows], execute: async (sql, params) => { writes.push({ sql, params }); return [{ affectedRows: 1 }]; } };
  const sync = worker.syncVgenv(db);
  try {
    for (let i = 0; i < 20 && writes.length < 8; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 8, 'other finished jobs are saved while the first read is stalled');
  } finally { release(); await sync; }
  assert.equal(maximum, 4);
  assert.equal(seen.length, 9);
  assert.equal(new Set(seen).size, 9);
  assert.ok(writes.every(write => write.sql.includes("status='completed'")));
  assert.ok(writes.every(write => write.params[2] !== 'local-0'), 'timeout does not fail, refund or resubmit the existing job');
});

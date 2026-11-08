'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LongAiClient } = require('../src/provider/longai.js');
const { parseVideoMarketplace, loadVideoMarketplace, checkVideoModel,
  signVideoKeyCheck, verifyVideoKeyCheck } = require('../src/longai_video_tests.js');

const marketplace = `
  <h2>图像生成1 个模型</h2>
  <table><tr><th>模型</th><th>平台</th><th>供货卖家</th></tr>
    <tr><td>seedream-4.5</td><td>OpenAI</td><td>1</td></tr>
  </table>
  <h2 id="video"><a href="#video">视频生成</a>4 个模型</h2>
  <table><tr><th>模型</th><th>平台</th><th>供货卖家</th><th>当前最深折扣</th></tr>
    <tr><td><code>seedance-2.0-mini</code></td><td>OpenAI</td><td>1</td><td>0.5 折</td></tr>
    <tr><td>kling-video-o-1</td><td>OpenAI</td><td><strong>2</strong></td><td>0.5 折</td></tr>
    <tr><td>kling-video-o-1</td><td>Other</td><td>&mdash;</td><td>—</td></tr>
    <tr><td>zero-video</td><td>OpenAI</td><td>0</td><td>—</td></tr>
  </table>`;

test('LONG AI video tests use the marketplace video section and deduplicate protocol rows', async () => {
  const result = await loadVideoMarketplace({ videoMarketplace: async () => marketplace });
  assert.equal(result.source, 'marketplace');
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.deepEqual(result.models, [
    { id: 'seedance-2.0-mini', sellers: 1 },
    { id: 'kling-video-o-1', sellers: 2 },
    { id: 'zero-video', sellers: 0 },
  ]);
  assert.throws(() => parseVideoMarketplace(marketplace.replace('<strong>2</strong>', '?')), /unexpected format/);
  const snapshot = await loadVideoMarketplace({ videoMarketplace: async () => '<html>Provider unavailable</html>' });
  assert.equal(snapshot.source, 'snapshot');
  assert.equal(snapshot.snapshotDate, '2026-11-08');
  assert.equal(snapshot.models.length, 31);
});

test('LONG AI video tests use GET, keep the key off the public marketplace request, and classify access', async () => {
  const calls = [];
  const client = new LongAiClient({ apiKey: 'fixture-key', fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method, authorization: options.headers.authorization });
    if (path === '/model-plaza') return new Response(marketplace);
    if (path.endsWith('/seedance-2.0-mini')) return Response.json({ id: 'seedance-2.0-mini' });
    if (path.endsWith('/zero-video')) return new Response(null, { status: 404 });
    if (path.endsWith('/kling-video-o-1')) return new Response(null, { status: 503 });
    return new Response(null, { status: 401 });
  } });
  assert.equal((await loadVideoMarketplace(client)).source, 'marketplace');
  for (const [id, status, providerStatus] of [
    ['seedance-2.0-mini', 'visible', undefined],
    ['zero-video', 'not_visible', 404],
    ['kling-video-o-1', 'error', 503],
    ['other-video', 'key_rejected', 401],
  ]) {
    const result = await checkVideoModel(client, id);
    assert.equal(result.status, status);
    assert.equal(result.providerStatus, providerStatus);
  }
  await assert.rejects(checkVideoModel(client, '../videos'), { statusCode: 400 });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0], { path: '/model-plaza', method: 'GET', authorization: undefined });
  assert.ok(calls.slice(1).every(call => call.method === 'GET' && call.path.startsWith('/v1/models/') &&
    call.authorization === 'Bearer fixture-key'));
});

test('LONG AI retries a timed-out key lookup once and binds the successful check to the key and model', async () => {
  const attempts = [];
  const model = 'seedance-2.0-mini';
  const apiKey = 'fixture-key';
  const secret = 'fixture-admin';
  const now = 1_800_000_000_000;
  const result = await checkVideoModel({ async verifyModel(id, deadline) {
    assert.equal(id, model);
    attempts.push(deadline);
    if (attempts.length === 1) throw Object.assign(new Error('Timeout'), { networkCode: 'ABORT_ERR' });
  } }, model);
  assert.equal(result.status, 'visible');
  assert.deepEqual(attempts, [12000, 8000]);

  const proof = signVideoKeyCheck(secret, apiKey, model, now);
  assert.equal(verifyVideoKeyCheck(secret, apiKey, model, proof, now), true);
  assert.equal(verifyVideoKeyCheck(secret, apiKey, model, proof, proof.expiresAt), false);
  assert.equal(verifyVideoKeyCheck(secret, 'changed-key', model, proof, now), false);
  assert.equal(verifyVideoKeyCheck(secret, apiKey, 'wan-3.0', proof, now), false);
  assert.equal(verifyVideoKeyCheck(secret, apiKey, model, { ...proof, expiresAt: proof.expiresAt - 1 }, now), false);
});

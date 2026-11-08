'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LongAiClient } = require('../src/provider/longai.js');
const { LongAiQueue } = require('../src/longai_queue.js');
const { longAiMediaModel, PUBLIC_ID, MODEL_ID, isLongAiModel } = require('../src/longai_models.js');
const { quoteGateway, validateReferences } = require('../src/vercel_models.js');
const { fetchPublicMedia } = require('../src/remote_image.js');

const key = 'fixture-key';
const options = { prompt: 'A seedling in the rain.', duration: 15, aspectRatio: '9:16', resolution: '720p' };
const json = (value, opts) => new Response(JSON.stringify(value), opts);

test('LONG AI only exposes Seedance 2.0 Mini, with resolution-specific prices and no references', () => {
  const row = longAiMediaModel({ '480p': '0.01', '720p': 0.02 });
  const model = { ...row, ...row.options };
  assert.equal(row.providerModelId, MODEL_ID);
  assert.equal(isLongAiModel(PUBLIC_ID), true);
  assert.equal(isLongAiModel('longai_seedance_2_0'), false);
  assert.equal(quoteGateway(model, options, 1000).cost, 300);
  assert.equal(quoteGateway(model, { ...options, resolution: '480p' }, 1000).cost, 150);
  assert.throws(() => quoteGateway(model, { ...options, duration: 16 }), /Unsupported duration/);
  assert.throws(() => quoteGateway(model, { ...options, resolution: '1080p' }), /Unsupported resolution/);
  assert.throws(() => validateReferences(model, { images: [{}] }), /Unsupported image/);
  assert.throws(() => longAiMediaModel({ '480p': 0.01 }), /720p/);
});

test('LONG AI checks the exact model with the saved key without starting a generation', async () => {
  const calls = [];
  const client = new LongAiClient({ apiKey: key, fetchImpl: async (url, opts) => {
    calls.push([url, opts.method, opts.headers.authorization]);
    return json({ data: [{ id: 'seedance-2.0' }] });
  } });
  await assert.rejects(client.verifyModel(), /does not list seedance-2.0-mini/);
  assert.deepEqual(calls, [['https://ai.dijinlong.com/v1/models', 'GET', 'Bearer ' + key]]);
  client.fetch = async () => json({ data: [{ id: MODEL_ID }, { id: 'other-model' }] });
  await client.verifyModel();
});

test('LONG AI saves one task and polls the URL returned by its API', async () => {
  const calls = [];
  const replies = [
    json({ data: { task_id: 'task_123' } }, { status: 202, headers: { location: '/v1/videos/jobs/task_123' } }),
    json({ data: { status: 'processing' } }),
    json({ data: { status: 'completed', video_url: 'https://media.example.test/clip.mp4' } }),
  ];
  const client = new LongAiClient({ apiKey: key, fetchImpl: async (url, opts) => {
    calls.push({ url, method: opts.method, redirect: opts.redirect, body: opts.body && JSON.parse(opts.body) });
    return replies.shift();
  } });
  const op = await client.startVideo(options);
  assert.deepEqual(op, { requestId: 'task_123', path: '/v1/videos/jobs/task_123' });
  assert.deepEqual(await client.videoStatus(op), { status: 'pending' });
  assert.deepEqual(await client.videoStatus(op), { status: 'done', url: 'https://media.example.test/clip.mp4' });
  assert.deepEqual(calls[0], {
    url: 'https://ai.dijinlong.com/v1/videos', method: 'POST', redirect: 'error',
    body: { model: MODEL_ID, prompt: options.prompt, duration: 15, aspect_ratio: '9:16', resolution: '720p' },
  });
  assert.ok(calls.slice(1).every(call => call.url.endsWith(op.path) && call.method === 'GET'));
});

test('LONG AI keeps the API key on its own origin and rejects private download targets', async () => {
  const client = new LongAiClient({ apiKey: key, fetchImpl: async () =>
    json({ id: 'task_123', status_url: 'https://example.test/steal' }) });
  await assert.rejects(client.startVideo(options), /invalid video status URL/);
  await assert.rejects(client.videoStatus({ requestId: 'task_123', path: '//example.test/steal' }), /invalid video status URL/);
  await assert.rejects(fetchPublicMedia('https://127.0.0.1/video.mp4', { timeoutMs: 1000, maxBytes: 100, accept: 'video/mp4' }), /private address/);
});

test('LONG AI queue collects the persisted task after restart without starting another video', async () => {
  const queue = new LongAiQueue();
  const job = { id: 8, media_type: 'video', prompt: options.prompt,
    generation_options: JSON.stringify({ ...options, model: { providerModelId: MODEL_ID } }) };
  const op = { requestId: 'task_123', path: '/v1/videos/task_123' };
  queue.log = () => {};
  await queue.submit({ execute: async (sql, args) => {
    assert.match(sql, /status='submitted'/);
    assert.deepEqual(args, [JSON.stringify(op), op.requestId, job.id]);
  } }, job, { startVideo: async input => { assert.equal(input.prompt, options.prompt); return op; } });
  const restarted = new LongAiQueue();
  const output = { data: Buffer.from('video'), mimeType: 'video/mp4' };
  restarted.complete = async (db, row, media) => { assert.equal(row.id, job.id); assert.equal(media, output); };
  await restarted.pollJob({}, {
    videoStatus: async persisted => {
      assert.deepEqual(persisted, op);
      return { status: 'done', url: 'https://media.example.test/video.mp4' };
    },
    download: async () => output,
  }, { ...job, provider_operation: JSON.stringify(op) });
});

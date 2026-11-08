'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { LongAiClient } = require('../src/provider/longai.js');
const { LongAiQueue } = require('../src/longai_queue.js');
const { longAiMediaModel, PUBLIC_ID, MODEL_ID, LONG_AI_CUSTOMER_CREDITS_PER_USD, isLongAiModel } = require('../src/longai_models.js');
const { quoteGateway, validateReferences } = require('../src/vercel_models.js');
const { PKR_PER_USD, applyPriceRate, priceRate } = require('../src/billing.js');
const { PLANS } = require('../src/plans.js');
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

test('LONG AI standard credit charges target 55% gross margin across plans and resolutions', () => {
  const row = longAiMediaModel({ '480p': '0.01', '720p': 0.02 });
  const model = { ...row, ...row.options };
  for (const [resolution, rate] of [['480p', 0.01], ['720p', 0.02]]) {
    for (const duration of model.durations) {
      const quote = quoteGateway(model, { ...options, duration, resolution }, LONG_AI_CUSTOMER_CREDITS_PER_USD);
      assert.equal(quote.sourceUsd, rate * duration);
      const charge = applyPriceRate(quote.cost, priceRate(null));
      for (const plan of Object.values(PLANS)) {
        const revenuePkr = charge * plan.pricePkr / plan.credits;
        const target = (quote.sourceUsd * PKR_PER_USD) / 0.45;
        assert.ok(revenuePkr >= target - 1e-10);
        assert.ok(revenuePkr - target <= 1.05 * plan.pricePkr / plan.credits + 1e-10);
      }
    }
  }
});

test('LONG AI checks the exact model with the saved key without starting a generation', async () => {
  const calls = [];
  const client = new LongAiClient({ apiKey: key, fetchImpl: async (url, opts) => {
    calls.push([url, opts.method, opts.headers.authorization]);
    return json({ id: 'seedance-2.0' });
  } });
  await assert.rejects(client.verifyModel(), /does not confirm access to seedance-2.0-mini/);
  assert.deepEqual(calls, [['https://ai.dijinlong.com/v1/models/seedance-2.0-mini', 'GET', 'Bearer ' + key]]);
  client.fetch = async () => json({ id: MODEL_ID });
  await client.verifyModel();
});

test('LONG AI uses HTTPS with a longer explicit deadline for connection checks and key validation', async t => {
  for (const name of ['HTTPS_PROXY', 'https_proxy']) {
    const value = process.env[name];
    delete process.env[name];
    t.after(() => { if (value !== undefined) process.env[name] = value; });
  }
  const calls = [];
  const reply = t.mock.method(https, 'request', (url, opts, callback) => {
    calls.push({ url, opts });
    const request = new EventEmitter();
    request.end = () => {
      const authenticated = Boolean(opts.headers.authorization);
      const response = Readable.from([Buffer.from(JSON.stringify({ id: MODEL_ID }))]);
      response.statusCode = authenticated ? 200 : 401;
      response.headers = { 'content-type': 'application/json' };
      setImmediate(() => callback(response));
    };
    return request;
  });
  const probe = await new LongAiClient().checkReachability();
  assert.equal(probe.providerStatus, 401);
  await new LongAiClient({ apiKey: key }).verifyModel();
  assert.equal(reply.mock.callCount(), 2);
  assert.deepEqual(calls.map(call => [call.url, call.opts.method, call.opts.headers.authorization]), [
    ['https://ai.dijinlong.com/v1/models', 'GET', undefined],
    ['https://ai.dijinlong.com/v1/models/seedance-2.0-mini', 'GET', 'Bearer ' + key],
  ]);
  assert.ok(calls.every(call => call.opts.signal instanceof AbortSignal));
});

test('LONG AI exposes safe timeout codes and sends a paid POST only once', async () => {
  let calls = 0;
  const client = new LongAiClient({ apiKey: key, fetchImpl: async () => {
    calls++;
    throw Object.assign(new Error('private transport detail'), { code: 'ABORT_ERR' });
  } });
  await assert.rejects(client.startVideo(options), error => {
    assert.match(error.message, /connection timed out from the CMMTools server/);
    assert.doesNotMatch(error.message, /private transport detail/);
    assert.equal(error.networkCode, 'ABORT_ERR');
    assert.equal(error.requestMethod, 'POST');
    assert.equal(error.timeoutMs, 60000);
    return true;
  });
  assert.equal(calls, 1);
});

test('LONG AI reports DOM timeout errors during connection and response reads', async () => {
  const timeout = () => new DOMException('operation timed out', 'TimeoutError');
  const connect = new LongAiClient({ apiKey: key, fetchImpl: async () => { throw timeout(); } });
  const read = new LongAiClient({ apiKey: key, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.error(timeout()); },
  })) });
  for (const client of [connect, read]) {
    await assert.rejects(client.verifyModel(), { networkCode: 'TimeoutError', requestMethod: 'GET', timeoutMs: 28000 });
  }
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

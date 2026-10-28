'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPulseMediaModels, isCreatePulseModel } = require('../src/createpulse_models.js');
const { quoteGateway, modelReady } = require('../src/vercel_models.js');
const { CreatePulseClient } = require('../src/provider/createpulse.js');
const { CreatePulseQueue } = require('../src/createpulse_queue.js');
const { failureMessage } = require('../src/provider_errors.js');

const [row] = createPulseMediaModels();
const model = { ...row, ...row.options, provider: 'createpulse' };
const res = (status, obj) => new Response(JSON.stringify(obj), { status });

test('Omni Flash is offered as cp_omni_flash with 4/6/8/10 s, 9:16 and 16:9', () => {
  assert.ok(isCreatePulseModel('cp_omni_flash'));
  assert.equal(row.providerModelId, 'veo-omni-flash');
  assert.deepEqual(model.durations, [4, 6, 8, 10]);
  assert.deepEqual(model.aspectRatios, ['16:9', '9:16']);
  assert.equal(model.referenceCapabilities.image.max, 4);
  assert.doesNotMatch(row.label, /createpulse|create pulse|veo/i);
  assert.ok(modelReady(model));
});

test('price is the flat API price per clip length, at cost', () => {
  const cost = d => quoteGateway(model, { duration: d, aspectRatio: '9:16' }, 6720).cost;
  assert.equal(cost(4), Math.ceil(0.05 * 6720));
  assert.equal(cost(10), Math.ceil(0.1072 * 6720));
  assert.equal(quoteGateway(model, { duration: 8, previewHasReferences: true }, 6720).cost, Math.ceil(0.086 * 6720));
  assert.throws(() => quoteGateway(model, { duration: 5 }, 6720), /duration/i);
  assert.throws(() => quoteGateway(model, { duration: 4, aspectRatio: '1:1' }, 6720), /aspect/i);
});

test('request body maps start frame, end frame and references', () => {
  const c = new CreatePulseClient({ apiKey: 'cp_x' });
  const body = c.videoRequest(model, { prompt: 'a drone shot', duration: 6, aspectRatio: '16:9' }, [
    { role: 'image_references', mimeType: 'image/png', url: 'https://cmmtools.site/r1' },
    { role: 'start_image', mimeType: 'image/jpeg', url: 'https://cmmtools.site/s' },
    { role: 'end_image', mimeType: 'image/jpeg', url: 'https://cmmtools.site/e' },
  ]);
  assert.deepEqual(body, { kind: 'video', model: 'veo-omni-flash', prompt: 'a drone shot', aspect: '16:9', duration: 6,
    init_image_url: 'https://cmmtools.site/s', end_frame_url: 'https://cmmtools.site/e', image_reference_urls: ['https://cmmtools.site/r1'] });
  assert.throws(() => c.videoRequest(model, { prompt: 'x', duration: 4, aspectRatio: '9:16' }, [{ role: 'end_image', mimeType: 'image/png', url: 'https://x/e' }]), /start frame/);
});

test('client submits with X-API-Key and reads the batch status', async () => {
  const calls = [];
  const replies = [res(200, { ok: true, batchId: 'a1b2c3d4', cost: 0.1072, status: 'processing' }), res(200, { ok: true, status: 'processing' }),
    res(200, { ok: true, status: 'done', url: 'https://createpulse.online/backend/api/video/king_a1.mp4' }),
    res(200, { ok: true, status: 'failed', error: 'Video not generated', refunded: true })];
  const c = new CreatePulseClient({ apiKey: 'cp_k', fetchImpl: async (url, init) => { calls.push({ url, init }); return replies.shift(); } });
  assert.deepEqual(await c.startVideo(model, { prompt: 'p', duration: 10, aspectRatio: '9:16' }), { requestId: 'a1b2c3d4', cost: 0.1072 });
  assert.equal(calls[0].url, 'https://createpulse.online/api/generate');
  assert.equal(calls[0].init.headers['x-api-key'], 'cp_k');
  assert.equal(JSON.parse(calls[0].init.body).model, 'veo-omni-flash');
  assert.deepEqual(await c.videoStatus({ requestId: 'a1b2c3d4' }), { status: 'pending' });
  assert.equal(calls[1].url, 'https://createpulse.online/api/status?batchId=a1b2c3d4');
  assert.equal((await c.videoStatus({ requestId: 'a1b2c3d4' })).status, 'done');
  assert.equal((await c.videoStatus({ requestId: 'a1b2c3d4' })).status, 'failed');
});

test('client errors: bad key, under $10, and the key check', async () => {
  const c401 = new CreatePulseClient({ apiKey: 'k', fetchImpl: async () => res(401, { ok: false, error: 'Invalid API key' }) });
  await assert.rejects(c401.verifyKey(), /rejected the API key/);
  const c403 = new CreatePulseClient({ apiKey: 'k', fetchImpl: async () => res(403, { ok: false, error: 'API requires a minimum $10 balance' }) });
  await assert.rejects(c403.startVideo(model, { prompt: 'p', duration: 4, aspectRatio: '9:16' }), /minimum \$10/);
  const ok = new CreatePulseClient({ apiKey: 'k', fetchImpl: async () => res(404, { ok: false, error: 'Batch not found' }) });
  assert.equal(await ok.verifyKey(), true);
  await assert.rejects(new CreatePulseClient({}).verifyKey(), /Save a CreatePulse API key/);
});

test('download sends the key only to CreatePulse and checks the MP4', async () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
  const seen = [];
  const c = new CreatePulseClient({ apiKey: 'cp_k', fetchImpl: async (url, init) => { seen.push({ url, key: init.headers['x-api-key'] }); return new Response(mp4, { status: 200 }); } });
  assert.equal((await c.download('https://createpulse.online/backend/api/video/a.mp4')).mimeType, 'video/mp4');
  await c.download('https://cdn.example.com/a.mp4');
  assert.deepEqual(seen.map(s => s.key), ['cp_k', undefined]);
  await assert.rejects(c.download('http://createpulse.online/a.mp4'), /invalid media URL/);
});

test('queue: a submit saves the batch id; a failure refunds with a customer-safe message', async () => {
  const executed = [], refunds = [];
  const q = new CreatePulseQueue({ getModel: async () => ({ ...model, ready: true }), refund: async (...a) => { refunds.push(a); } });
  q.log = () => {};
  q.references = async () => [];
  const job = { id: 7, user_id: 1, media_type: 'video', model: 'cp_omni_flash', prompt: 'p',
    generation_options: JSON.stringify({ model: { providerModelId: 'veo-omni-flash' }, duration: 8, aspectRatio: '9:16' }) };
  const client = { videoRequest: () => ({ model: 'veo-omni-flash', prompt: 'p' }), startVideo: async () => ({ requestId: 'b1b2c3d4', cost: 0.086 }),
    videoStatus: async () => ({ status: 'failed', error: 'Video not generated' }) };
  const db = { execute: async (sql, params) => { executed.push([sql, params]); return [{ affectedRows: 1 }]; } };
  await q.submit(db, job, client);
  assert.match(executed[0][0], /status='submitted'/);
  assert.equal(executed[0][1][1], 'b1b2c3d4');
  await q.pollJob(db, client, { ...job, provider_operation: executed[0][1][0] });
  assert.equal(refunds[0][2], 'Model under maintenance. Please choose another model. Credits were refunded.');
  assert.equal(q.submitFailureMessage(new Error('CreatePulse refused the request: API requires a minimum $10 balance')), failureMessage('video', 'x'));
  q.stop();
});

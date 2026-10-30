const test = require('node:test');
const assert = require('node:assert/strict');
const { getCost, publicPricing, H3_MODEL_IDS, h3VgenvModel, h3VgenvTier } = require('../src/pricing.js');
const { usdToCredits } = require('../src/billing.js');
const { VgenvClient } = require('../src/provider/vgenv.js');

test('MiniMax H3 existing Fast prices are preserved alongside Origin Quality', () => {
  assert.deepEqual(H3_MODEL_IDS, ['minimax_h3', 'minimax_h3_cinematic', 'minimax_h3_origin', 'minimax_h3_origin_quality']);
  assert.deepEqual(publicPricing().map(m => m.label), ['MiniMax H3 Base', 'MiniMax H3 Cinematic', 'MiniMax H3 Origin', 'MiniMax H3 Origin Quality']);
  const credits = (usd, seconds) => Math.ceil(usdToCredits(usd) * seconds - 1e-9);
  for (const id of ['minimax_h3', 'minimax_h3_cinematic']) {
    assert.equal(getCost(id, 10, '480p'), credits(0.0015, 10));
    assert.equal(getCost(id, 10, '768p'), credits(0.003, 10));
  }
  assert.equal(getCost('minimax_h3_origin', 14, '480p'), credits(0.0023, 14));
  assert.equal(getCost('minimax_h3_origin', 7, '768p'), credits(0.0046, 7));
  assert.deepEqual(H3_MODEL_IDS.map(h3VgenvModel), ['base', 'cinematic', 'origin', 'origin']);
});

test('vgenv gets Base on /v1 as before and Cinematic or Origin on /v3', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ id: 'job_1', status: 'queued', price: { currency: 'USD', amount_micros: 32200 } }), { status: 202 });
  });
  const client = new VgenvClient({ apiKey: 'k' });
  const args = { prompt: 'A cat dancing', duration: 14, resolution: '480p', aspectRatio: '9:16' };

  await client.generateVideo(args);
  assert.equal(calls[0].url, 'https://api.vgenv.com/v1/videos');
  assert.equal(calls[0].body.model, 'minimax/h3');
  assert.equal(calls[0].body.prompt_optimization, undefined);

  const origin = await client.generateVideo({ ...args, model: 'origin' });
  assert.equal(calls[1].url, 'https://api.vgenv.com/v3/videos');
  assert.equal(calls[1].body.model, 'origin');
  assert.equal(calls[1].body.tier, 'fast');
  assert.deepEqual(calls[1].body.prompt_optimization, { mode: 'raw' });
  assert.equal(origin.price, 0.0322);
  assert.equal(origin.currency, 'USD');

  await client.getVideo('job_1', { v3: true });
  assert.equal(calls[2].url, 'https://api.vgenv.com/v3/videos/job_1');
});

test('the worker sends every H3 model to vgenv', () => {
  const { GenerationWorker } = require('../src/worker_admin_settings.js');
  const w = new GenerationWorker();
  Object.assign(w, { vgenvEnabled: true, vgenv: {} });
  for (const model of H3_MODEL_IDS) assert.equal(w.chooseProvider({ model }, 1), 'vgenv');
  w.stop?.();
});

test('Origin Quality prices cover every offered duration and resolution', () => {
  const id = 'minimax_h3_origin_quality';
  assert.equal(h3VgenvTier(id), 'quality');
  for (const legacy of H3_MODEL_IDS.filter(m => m !== id)) assert.equal(h3VgenvTier(legacy), 'fast');
  const model = publicPricing().find(m => m.id === id);
  for (const [resolution, rate] of Object.entries({ '480p': 0.0077, '768p': 0.015 })) {
    for (let seconds = 4; seconds <= 15; seconds++) {
      const expected = Math.ceil(usdToCredits(rate) * seconds - 1e-9);
      assert.equal(getCost(id, seconds, resolution), expected);
      assert.equal(model.resolutions.find(r => r.id === resolution).durations.find(d => d.seconds === seconds).cost, expected);
    }
  }
  assert.throws(() => getCost(id, 30, '768p'));
  assert.throws(() => getCost(id, 10, '1080p'));
});

test('saved Origin Quality job reaches v3 with Quality, references and stable retry key', async t => {
  const { GenerationWorker } = require('../src/worker_admin_settings.js');
  const calls = [], updates = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: 'quality_job', status: 'queued', price: { currency: 'USD', amount_micros: 150000 } }), { status: 202 });
  });
  const w = new GenerationWorker();
  t.after(() => w.stop?.());
  w.vgenv = new VgenvClient({ apiKey: 'test-key' });
  w.vgenvAssets = async () => ({ referenceAudioAssetIds: ['asset_audio'], referenceVideoAssetId: 'asset_video' });
  const db = { execute: async (sql, values) => { updates.push({ sql, values }); return [{ affectedRows: 1 }]; } };
  const job = { id: 'local-quality', model: 'minimax_h3_origin_quality', mode: 'image-to-video', duration: 10, resolution: '768p', aspect_ratio: '16:9', prompt: 'Follow the reference movement' };
  await w.submitVgenv(db, job, 0);
  await w.submitVgenv(db, job, 0);
  assert.equal(calls[0].url, 'https://api.vgenv.com/v3/videos');
  assert.equal(calls[0].body.model, 'origin');
  assert.equal(calls[0].body.tier, 'quality');
  assert.deepEqual(calls[0].body.reference_video, { asset_id: 'asset_video' });
  assert.deepEqual(calls[0].body.reference_audios, [{ asset_id: 'asset_audio' }]);
  assert.deepEqual(calls[0].body.prompt_optimization, { mode: 'raw' });
  assert.equal(calls[0].headers['Idempotency-Key'], 'mehroz-local-quality');
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(updates[0].values, ['quality_job', 0.15, 'usd', 'local-quality']);
});

test('unsupported tiers fail before a provider request', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('must not submit'); });
  await assert.rejects(new VgenvClient({ apiKey: 'test-key' }).generateVideo({ model: 'origin', tier: 'typo' }), /Unsupported.*tier/);
});


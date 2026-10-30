const test = require('node:test');
const assert = require('node:assert/strict');
const { getCost, publicPricing, H3_MODEL_IDS, h3VgenvModel, h3VgenvTier } = require('../src/pricing.js');
const { usdToCredits } = require('../src/billing.js');
const { VgenvClient } = require('../src/provider/vgenv.js');

test('Existing H3 models keep Fast pricing; Beast gets separate Origin Quality pricing', () => {
  assert.deepEqual(H3_MODEL_IDS, ['minimax_h3', 'minimax_h3_cinematic', 'minimax_h3_origin', 'minimax_beast']);
  assert.deepEqual(publicPricing().map(m => m.label), ['MiniMax H3 Base', 'MiniMax H3 Cinematic', 'MiniMax H3 Origin', 'Minimax Beast']);
  const credits = (usd, seconds) => Math.ceil(usdToCredits(usd) * seconds - 1e-9);
  for (const id of ['minimax_h3', 'minimax_h3_cinematic']) {
    assert.equal(getCost(id, 10, '480p'), credits(0.0015, 10));
    assert.equal(getCost(id, 10, '768p'), credits(0.003, 10));
  }
  assert.equal(getCost('minimax_h3_origin', 14, '480p'), credits(0.0023, 14));
  assert.equal(getCost('minimax_h3_origin', 7, '768p'), credits(0.0046, 7));
  assert.equal(getCost('minimax_beast', 10, '480p'), credits(0.0077, 10));
  assert.equal(getCost('minimax_beast', 10, '768p'), credits(0.015, 10));
  assert.deepEqual(H3_MODEL_IDS.map(h3VgenvModel), ['base', 'cinematic', 'origin', 'origin']);
  assert.deepEqual(H3_MODEL_IDS.map(h3VgenvTier), ['fast', 'fast', 'fast', 'quality']);
  assert.throws(() => getCost('minimax_beast', 16, '768p'), /not enabled/i);
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

  await client.generateVideo({ ...args, model: 'origin', tier: 'quality' });
  assert.equal(calls[2].url, 'https://api.vgenv.com/v3/videos');
  assert.equal(calls[2].body.model, 'origin');
  assert.equal(calls[2].body.tier, 'quality');
  await client.getVideo('job_1', { v3: true });
  assert.equal(calls[3].url, 'https://api.vgenv.com/v3/videos/job_1');
});

test('the worker sends every H3 model to vgenv', () => {
  const { GenerationWorker } = require('../src/worker_admin_settings.js');
  const w = new GenerationWorker();
  Object.assign(w, { vgenvEnabled: true, vgenv: {} });
  for (const model of H3_MODEL_IDS) assert.equal(w.chooseProvider({ model }, 1), 'vgenv');
  w.stop?.();
});

// The worker owns the paid request: verify saved model ID drives the tier.
test('Beast submits Origin Quality while legacy Origin still submits Fast', async t => {
  const { GenerationWorker } = require('../src/worker_admin_settings.js');
  const worker = new GenerationWorker(); t.after(() => worker.stop());
  const submitted = [];
  worker.vgenv = { generateVideo: async params => {
    submitted.push(params);
    return { id: 'job_' + submitted.length, price: 0.15, currency: 'USD' };
  } };
  const updates = [];
  const db = { execute: async (sql, params) => {
    updates.push([sql, params]);
    return [{ affectedRows: 1 }];
  } };
  const base = { id: 'beast-test', mode: 'text-to-video', prompt: 'a cinematic sunrise',
    duration: 10, resolution: '768p', aspect_ratio: '9:16' };
  await worker.submitVgenv(db, { ...base, model: 'minimax_beast' }, 0);
  assert.deepEqual([submitted[0].model, submitted[0].tier], ['origin', 'quality']);
  assert.equal(submitted[0].idempotencyKey, 'mehroz-beast-test');
  assert.match(updates[0][0], /status='submitted'/);
  await worker.submitVgenv(db, { ...base, model: 'minimax_h3_origin' }, 0);
  assert.deepEqual([submitted[1].model, submitted[1].tier], ['origin', 'fast']);
});

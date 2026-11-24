const test = require('node:test');
const assert = require('node:assert/strict');
const { getCost, publicPricing, H3_MODEL_IDS, h3VgenvModel, h3VgenvTier } = require('../src/pricing.js');
const { usdToCredits } = require('../src/billing.js');
const { VgenvClient } = require('../src/provider/vgenv.js');

test('Existing H3 models keep Fast pricing; Beast gets separate Origin Quality pricing', () => {
  assert.deepEqual(H3_MODEL_IDS, ['minimax_h3', 'minimax_h3_cinematic', 'minimax_h3_origin', 'cmmtools_origin_2_0', 'seedance_2_0_mini', 'minimax_h3_origin_standard', 'minimax_beast']);
  assert.deepEqual(publicPricing().map(m => m.label), ['MiniMax H3 Base', 'MiniMax H3 Cinematic', 'MiniMax H3 Origin', 'CMMTools Origin 2.0', 'CMM Mini', 'Origin Standard', 'Minimax Beast']);
  const credits = (usd, seconds) => Math.ceil(usdToCredits(usd) * seconds - 1e-9);
  for (const id of ['minimax_h3', 'minimax_h3_cinematic']) {
    assert.equal(getCost(id, 10, '480p'), credits(0.0015, 10));
    assert.equal(getCost(id, 10, '768p'), credits(0.003, 10));
  }
  assert.equal(getCost('minimax_h3_origin', 14, '480p'), credits(0.0023, 14));
  assert.equal(getCost('minimax_h3_origin', 7, '768p'), credits(0.0046, 7));
  for (const resolution of ['480p', '768p'])
    assert.equal(getCost('seedance_2_0_mini', 10, resolution), getCost('minimax_h3_origin', 10, resolution));
  const mini = publicPricing().find(m => m.id === 'seedance_2_0_mini');
  assert.equal(mini.label, 'CMM Mini');
  assert.equal(mini.warning, undefined);
  assert.deepEqual(mini.resolutions.map(r => r.id), ['480p', '768p']);
  assert.deepEqual(mini.durations.map(d => d.seconds), Array.from({length:12},(_,i)=>i+4));
  assert.equal(getCost('minimax_beast', 10, '480p'), credits(0.0077, 10));
  assert.equal(getCost('minimax_beast', 10, '768p'), credits(0.015, 10));
  assert.deepEqual(H3_MODEL_IDS.map(h3VgenvModel), ['base', 'cinematic', 'origin', 'origin', 'origin', 'origin', 'origin']);
  assert.deepEqual(H3_MODEL_IDS.map(h3VgenvTier), ['fast', 'fast', 'fast', 'fast', 'fast', 'standard', 'quality']);
  const original = publicPricing().find(m => m.id === 'minimax_h3_origin');
  const duplicate = publicPricing().find(m => m.id === 'cmmtools_origin_2_0');
  assert.deepEqual(duplicate, { ...original, id: 'cmmtools_origin_2_0', label: 'CMMTools Origin 2.0' });
  for (const resolution of ['480p', '768p']) for (let duration = 4; duration <= 30; duration++) {
    assert.equal(getCost('cmmtools_origin_2_0', duration, resolution), getCost('minimax_h3_origin', duration, resolution));
  }
  const standard = publicPricing().find(m => m.id === 'minimax_h3_origin_standard');
  assert.equal(standard.warning, undefined);
  assert.deepEqual(standard.resolutions.map(r => r.id), ['480p', '768p']);
  assert.deepEqual(standard.durations.map(d => d.seconds), Array.from({length:12},(_,i)=>i+4));
  assert.equal(getCost('minimax_h3_origin_standard', 10, '480p'), credits(0.0038, 10));
  assert.equal(getCost('minimax_h3_origin_standard', 10, '768p'), credits(0.0077, 10));
  assert.throws(() => getCost('minimax_h3_origin_standard', 16, '768p'), /not enabled/i);
  for (const model of publicPricing().filter(m => m.longVideoMinDuration)) {
    assert.equal(model.longVideoMinDuration, 16);
    for (const resolution of model.resolutions) {
      assert.deepEqual(resolution.durations.map(d => d.seconds), Array.from({length:27}, (_, i) => i + 4));
      assert.ok(getCost(model.id, 30, resolution.id) > getCost(model.id, 15, resolution.id));
    }
    assert.throws(() => getCost(model.id, 31, '768p'), /not enabled/i);
    assert.throws(() => getCost(model.id, 29.5, '768p'), /not enabled/i);
  }
  assert.throws(() => getCost('seedance_2_0_mini', 16, '768p'), /not enabled/i);
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
  await client.generateVideo({ ...args, model: 'origin', tier: 'standard' });
  assert.equal(calls[4].url, 'https://api.vgenv.com/v3/videos');
  assert.equal(calls[4].body.model, 'origin');
  assert.equal(calls[4].body.tier, 'standard');
});

test('the worker sends every H3 model to vgenv', () => {
  const { GenerationWorker } = require('../src/worker_admin_settings.js');
  const w = new GenerationWorker();
  Object.assign(w, { vgenvEnabled: true, vgenv: {} });
  for (const model of H3_MODEL_IDS) assert.equal(w.chooseProvider({ model }, 1), 'vgenv');
  w.stop?.();
});

// The worker owns the paid request: verify saved model ID drives the tier.
test('Beast submits Quality while Origin and the Mini alias submit Origin Fast', async t => {
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
  await worker.submitVgenv(db, { ...base, model: 'seedance_2_0_mini' }, 0);
  assert.deepEqual([submitted[2].model, submitted[2].tier], ['origin', 'fast']);
  assert.equal(submitted[2].resolution, '768p');
  await worker.submitVgenv(db, { ...base, id: 'standard-test', model: 'minimax_h3_origin_standard' }, 0);
  assert.deepEqual([submitted[3].model, submitted[3].tier], ['origin', 'standard']);
  assert.equal(submitted[3].resolution, '768p');
  assert.equal(submitted[3].idempotencyKey, 'mehroz-standard-test');
  await worker.submitVgenv(db, { ...base, id: 'cmm-origin-test', model: 'cmmtools_origin_2_0' }, 0);
  assert.deepEqual([submitted[4].model, submitted[4].tier], ['origin', 'fast']);
  assert.equal(submitted[4].resolution, '768p');
  assert.equal(submitted[4].idempotencyKey, 'mehroz-cmm-origin-test');
});

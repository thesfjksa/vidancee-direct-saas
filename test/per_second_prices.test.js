const test = require('node:test');
const assert = require('node:assert/strict');
const { perSecondPrices } = require('../src/per_second_prices.js');

const durations = [5, 10, 30].map(seconds => ({ seconds, cost: null }));
const model = { id: 'api888_seedance_2_5_g5_v2', label: 'Seedance 2.5 Realism', dynamicCost: true, defaultAspectRatio: '16:9',
  resolutions: [{ id: '720p', durations }], durations };

test('a fixed-price Seedance 2.5 clip is cheaper per second when longer', async () => {
  const rows = await perSecondPrices(model, async () => ({ cost: 6720 }));
  assert.deepEqual(rows, [{ name: 'Seedance 2.5 Realism', resolution: '720p', minSeconds: 5, maxSeconds: 30, minCredits: 6720, maxCredits: 6720,
    fixedPrice: true, perSecondFrom: 224, perSecondTo: 1344 }]);
});

test('per-second models keep one rate, broken down by resolution', async () => {
  const m = { ...model, resolutions: [{ id: '720p', durations }, { id: '1080p', durations }] };
  const rate = { '720p': 90, '1080p': 125 };
  const rows = await perSecondPrices(m, async b => ({ cost: rate[b.resolution] * b.duration }));
  assert.deepEqual(rows.map(r => [r.resolution, r.perSecondFrom, r.perSecondTo, r.fixedPrice]), [['720p', 90, 90, false], ['1080p', 125, 125, false]]);
});

test('a resolution that cannot be quoted is left out', async () => {
  assert.deepEqual(await perSecondPrices(model, async () => { throw new Error('no price'); }), []);
});

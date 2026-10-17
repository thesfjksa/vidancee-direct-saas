const test = require('node:test');
const assert = require('node:assert/strict');
const { comparePrices, COMPARISONS, PLATFORMS } = require('../src/compare_prices.js');

test('the compare page shows only clips where CMM Tools is cheaper', async () => {
  assert.ok(COMPARISONS.every(c => c.offers.every(o => PLATFORMS[o.platform])));
  // Wan 3.0 5 s 720p at 709 credits = Rs 59.08; Pika 33 credits of $10/900 = Rs 102.67.
  const data = await comparePrices(async c => (c.model === 'hf_wan_3_0' && c.seconds === 5 ? 709 : c.model === 'minimax_h3' ? 99999 : null));
  assert.equal(data.rows.length, 1);
  assert.deepEqual(data.rows[0].offers.map(o => [o.platform, o.rs, o.saving]), [['Pika', 102.67, 42], ['Higgsfield', 183.75, 68]]);
  assert.equal(data.rows[0].rs, 59.08);
  assert.deepEqual(data.plans.map(p => p.name), ['Pika', 'Higgsfield']);
});

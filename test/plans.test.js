const test = require('node:test');
const assert = require('node:assert/strict');
const plans = require('../src/plans.js');

test('plans follow Rs 3 per credit, Enterprise is contact-only, old plans still apply', () => {
  const list = plans.publicPlans();
  assert.deepEqual(list.map(p => [p.code, p.pricePkr, p.credits]), [['creator', 5000, 1667], ['studio', 10000, 3333], ['enterprise', null, null]]);
  const enterprise = list.find(p => p.code === 'enterprise');
  assert.equal(enterprise.contact, true);
  assert.match(enterprise.contactUrl, /^https:\/\/wa\.me\/923000499907\?text=/);
  assert.equal(plans.getPlan('enterprise'), null);
  // Customers already on Basic/Pro/Premium keep their limits.
  assert.equal(plans.getPlanProfile('pro').concurrency, 3);
  assert.equal(plans.getPlanProfile('basic').concurrency, 2);
  assert.equal(plans.SUPPORT_WHATSAPP, '+923000499907');
});

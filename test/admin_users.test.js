'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setUserPlan, changeUserCredits, adminMediaUrl, verifyAdminMedia, adminMediaLinks, adminPlanOptions } = require('../src/admin_users.js');

// A tiny in-memory stand-in for the users and credit_transactions tables.
function fakeDb(user) {
  const ledger = [];
  const conn = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, params) {
      if (/^SELECT .* FROM users WHERE id=\? FOR UPDATE/.test(sql)) return [params[0] === user.id ? [{ ...user }] : []];
      if (/^UPDATE users SET plan_code=\?,credits=credits\+\?/.test(sql)) { user.plan_code = params[0]; user.credits += params[1]; return [{}]; }
      if (/^UPDATE users SET credits=credits\+\?/.test(sql)) { user.credits += params[0]; return [{}]; }
      if (/INSERT INTO credit_transactions/.test(sql)) { ledger.push(params); return [{}]; }
      throw new Error('Unexpected SQL ' + sql);
    },
  };
  return { ledger, user, async getConnection() { return conn; }, async execute(sql, params) { return [[{ ...user }]]; } };
}

test('plan options list current plans first, then older ones', () => {
  const plans = adminPlanOptions();
  assert.ok(plans.length >= 2);
  assert.equal(plans[0].legacy, false);
  assert.ok(plans.some(p => p.legacy));
});

test('setting a plan can add its credits with a ledger row', async () => {
  const db = fakeDb({ id: 7, credits: 10, plan_code: null });
  const plan = adminPlanOptions()[0];
  const r = await setUserPlan(db, 7, plan.code, { grantCredits: true });
  assert.equal(db.user.plan_code, plan.code);
  assert.equal(db.user.credits, 10 + plan.credits);
  assert.equal(r.creditsGranted, plan.credits);
  assert.equal(db.ledger.length, 1);
  await setUserPlan(db, 7, '');
  assert.equal(db.user.plan_code, null);
  assert.equal(db.ledger.length, 1, 'removing a plan adds no ledger row');
  await assert.rejects(setUserPlan(db, 7, 'nope'), /valid plan/);
  await assert.rejects(setUserPlan(db, 8, plan.code), /not found/);
});

test('credits can be added, removed or set exactly, never below zero', async () => {
  const db = fakeDb({ id: 3, credits: 100 });
  assert.equal((await changeUserCredits(db, 3, { amount: 50 })).delta, 50);
  assert.equal(db.user.credits, 150);
  assert.equal((await changeUserCredits(db, 3, { amount: -20 })).delta, -20);
  assert.equal((await changeUserCredits(db, 3, { amount: 1000, mode: 'set' })).delta, 870);
  assert.equal(db.user.credits, 1000);
  assert.equal((await changeUserCredits(db, 3, { amount: 1000, mode: 'set' })).delta, 0);
  assert.equal(db.ledger.length, 3, 'no ledger row when nothing changes');
  await assert.rejects(changeUserCredits(db, 3, { amount: -5000 }), /negative/);
  await assert.rejects(changeUserCredits(db, 3, { amount: -1, mode: 'set' }), /negative/);
  await assert.rejects(changeUserCredits(db, 3, { amount: 0 }), /non-zero/);
});

test('admin media links are signed and expire', () => {
  const id = '11111111-2222-3333-4444-555555555555', now = Date.now();
  const link = new URL(adminMediaUrl('secret', id, 'video', now), 'http://x');
  const [exp, sig] = [link.searchParams.get('exp'), link.searchParams.get('sig')];
  assert.equal(verifyAdminMedia('secret', id, 'video', exp, sig, now), true);
  assert.equal(verifyAdminMedia('secret', id, 'poster', exp, sig, now), false);
  assert.equal(verifyAdminMedia('other', id, 'video', exp, sig, now), false);
  assert.equal(verifyAdminMedia('secret', id, 'video', exp, sig, now + 7 * 3600 * 1000), false);
  assert.deepEqual(Object.keys(adminMediaLinks('secret', { id, media_type: 'image', output_url: 'db:image' })), ['image_url', 'thumb_url']);
  assert.deepEqual(adminMediaLinks('secret', { id, media_type: 'video', output_url: null }), {});
});

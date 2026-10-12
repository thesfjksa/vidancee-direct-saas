const test = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../src/provider_usage.js');

function fakeDb(statusJson) {
  const writes = [];
  return {
    writes,
    async query(sql, args) {
      if (sql.includes('FROM app_settings')) return [[statusJson == null ? undefined : { setting_value: statusJson }].filter(Boolean)];
      if (sql.includes('GROUP BY provider, provider_cost_unit')) return [[
        { provider: 'vercel', unit: 'usd-estimate', total: 0.42 }, { provider: 'createpulse', unit: 'usd', total: 1.5 }]];
      if (sql.includes('GROUP BY provider')) return [[
        { provider: 'vercel', jobs24h: 3, jobs30d: 10, completed30d: 8, failed30d: 2, active: 1, customerCredits30d: 2536 },
        { provider: 'createpulse', jobs24h: 0, jobs30d: 4, completed30d: 4, failed30d: 0, active: 0, customerCredits30d: 60 }]];
      throw new Error('Unexpected SQL ' + sql);
    },
    async execute(sql, args) { writes.push([sql, args]); return [{ affectedRows: 1 }]; },
  };
}

test('usage combines provider balances with 30-day consumption from job records', async () => {
  const db = fakeDb(JSON.stringify({ vidancee: { credits: 327, reserved: 9, concurrency: 1, processing: 1, at: '2026-10-12T07:00:00.000Z' },
    outOfCredits: { createpulse: Date.now() + 60000, vgenv: Date.now() - 1 } }));
  const fetchImpl = async url => {
    if (url.includes('ai-gateway') || url.includes('/v1/credits')) return Response.json({ balance: '95.50', total_used: '4.50' });
    if (url.endsWith('/dashboard/billing/subscription')) return Response.json({ hard_limit_usd: 50 });
    if (url.includes('/dashboard/billing/usage')) return Response.json({ total_usage: 1250 });
    return new Response('nope', { status: 404 });
  };
  const settings = { vercelApiKey: 'v-key', smartAipiApiKey: 's-key', smartAipiBaseUrl: 'https://smart.example/v1' };
  const admin = { vidancee: { active: true, configured: true }, vercel: { active: true, configured: true }, createpulse: { active: true, configured: true } };
  const rows = await usage.providerUsage(db, settings, admin, { fetchImpl });
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.equal(rows.length, 8);
  assert.equal(by.vidancee.balance.remaining, 318);
  assert.equal(by.vidancee.balance.reserved, 9);
  assert.deepEqual([by.vercel.balance.remaining, by.vercel.balance.used, by.vercel.balance.unit], [95.5, 4.5, 'USD']);
  assert.deepEqual([by.smartaipi.balance.remaining, by.smartaipi.balance.limit, by.smartaipi.balance.used], [37.5, 50, 12.5]);
  assert.ok(by.createpulse.balance.outOfCreditsUntil);
  assert.equal(by.vgenv.balance.outOfCreditsUntil, undefined);
  assert.match(by.atlascloud.balance.note, /does not report/);
  assert.equal(by.vercel.usage.completed30d, 8);
  assert.deepEqual(by.vercel.usage.sourceCost30d, [{ unit: 'usd-estimate', total: 0.42 }]);
  assert.equal(by.higgsfield.usage.jobs30d, 0);
  assert.equal(by.vercel.active, true);
  assert.equal(by.smartaipi.active, false);
});

test('a provider without a billing route reports "not reported" instead of failing', async () => {
  const rows = await usage.providerUsage(fakeDb(null), { smartAipiApiKey: 's' }, {}, { fetchImpl: async () => new Response('x', { status: 404 }) });
  const smart = rows.find(r => r.key === 'smartaipi');
  assert.match(smart.balance.note, /does not report a balance/);
  assert.match(rows.find(r => r.key === 'vidancee').balance.note, /not active/);
});

test('the worker merges status updates instead of overwriting them', async () => {
  const db = fakeDb(JSON.stringify({ vidancee: { credits: 5 } }));
  await usage.recordProviderStatus(db, { outOfCredits: { createpulse: 1 } });
  const saved = JSON.parse(db.writes[0][1][1]);
  assert.deepEqual(saved, { vidancee: { credits: 5 }, outOfCredits: { createpulse: 1 } });
  assert.equal(db.writes[0][1][0], usage.STATUS_KEY);
});

const test = require('node:test');
const assert = require('node:assert/strict');
// The worker reads the database helpers when it is loaded, so the test
// database is installed first.
const refunds = [];
const conn = {
  async execute(sql, args) {
    if (sql.includes('FOR UPDATE')) return [[{ id: args[0], user_id: 1, credits_cost: 50, refunded_at: null, provider: 'x', model: 'm', media_type: 'video' }]];
    if (sql.includes('SET status = ?, error_message = ?')) refunds.push(args[1]);
    return [{ affectedRows: 1 }];
  },
  beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
};
const db = { execute: conn.execute, async query() { return [[{ id: 'g1', user_id: 1, provider_job_id: '41' }]]; }, getConnection: async () => conn };
Object.assign(require('../src/db.js'), { dbConfigured: () => true, getPool: () => db });
const { GenerationWorker } = require('../src/worker_admin_settings.js');
const { serializeGeneration } = require('../src/generations.js');

test('a job a source fails after accepting it is refunded with the source\'s reason', async () => {
  const w = new GenerationWorker();
  w.vgenv = { getVideo: async () => ({ status: 'failed', error: 'vgenv: prompt rejected by moderation', price: null }) };
  await w.syncVgenv(db);
  w.vgenv = { getVideo: async () => ({ status: 'failed', error: 'Reference image could not be read', price: null }) };
  await w.syncVgenv(db);
  w.vgenv = { getVideo: async () => ({ status: 'cancelled', error: null, price: null }) };
  await w.syncVgenv(db);
  assert.deepEqual(refunds, [
    // Saved without the vendor's name, so every page that shows it is safe.
    'Generation failed: the generation service: prompt rejected by moderation. Credits were refunded.',
    'Generation failed: Reference image could not be read. Credits were refunded.',
    'Generation failed during processing. Credits were refunded.',
  ]);
  // Customers see the reason without the vendor's name.
  assert.equal(serializeGeneration({ error_message: refunds[0] }).error_message,
    'Generation failed: the generation service: prompt rejected by moderation. Credits were refunded.');
  w.stop();
});

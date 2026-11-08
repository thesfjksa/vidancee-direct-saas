'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { LongAiClient } = require('../src/provider/longai.js');
const { validateRenderRequest, queueRenderTest, runRenderTest, listRenderTests } = require('../src/longai_render_tests.js');

const id = '12345678-1234-4abc-8abc-123456789abc';
const model = 'seedance-2.0-mini';
const key = 'fixture-longai-key';
const digest = createHash('sha256').update(key).digest('hex');
const active = ['queued', 'submitting', 'accepted'];

function fakeDb(initial = null) {
  let row = initial;
  const db = {
    get row() { return row; },
    customerRunning: false,
    async getConnection() { return db; },
    release() {},
    async query(sql) {
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK') || sql.includes('LIMIT 0')) return [[]];
      assert.fail(sql);
    },
    async execute(sql, args) {
      if (sql.startsWith('SELECT *,')) return [row && active.includes(row.status) ? [row] : []];
      if (sql.startsWith('SELECT id FROM generations')) return [db.customerRunning ? [{ id: 'customer' }] : []];
      if (sql.startsWith('SELECT id FROM longai_render_tests')) return [row && active.includes(row.status) ? [row] : []];
      if (sql.startsWith('SELECT status FROM longai_render_tests')) return [row?.model === args[0] ? [row] : []];
      if (sql.startsWith('SELECT id, model, status')) {
        if (args && row?.id !== args[0]) return [[]];
        return [row ? [{ id: row.id, model: row.model, status: row.status, taskId: row.task_id }] : []];
      }
      if (sql.startsWith("UPDATE longai_render_tests SET status='expired'")) return [{ affectedRows: 0 }];
      if (sql.startsWith('INSERT INTO longai_render_tests')) {
        row = { id: args[0], model: args[1], key_fingerprint: args[2], status: 'queued', age: 0 };
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("UPDATE longai_render_tests SET status='submitting'")) {
        if (row.status !== 'queued') return [{ affectedRows: 0 }];
        row.status = 'submitting';
        row.submissionAge = 0;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE longai_render_tests SET status=?')) {
        assert.equal(row.status, args[7]);
        const [status, diagnostic, providerStatus, providerRequestId, op, taskId] = args;
        Object.assign(row, { status, diagnostic, providerStatus, providerRequestId });
        if (op) row.provider_operation = op;
        if (taskId) row.task_id = taskId;
        return [{ affectedRows: 1 }];
      }
      assert.fail(sql);
    },
  };
  return db;
}

test('LONG AI render tests require explicit approval and queue one idempotent test', async () => {
  const db = fakeDb();
  assert.throws(() => validateRenderRequest({ id, model }), /Confirm the paid/);
  assert.throws(() => validateRenderRequest({ id, model: '../models', confirmPaid: true }), /Invalid/);
  validateRenderRequest({ id, model, confirmPaid: true });
  const first = await queueRenderTest(db, { id, model }, key);
  assert.equal(first.status, 'queued');
  assert.equal(db.row.key_fingerprint, digest);
  assert.deepEqual(await queueRenderTest(db, { id, model }, key), first);
  await assert.rejects(queueRenderTest(db, { id, model: 'another-model' }, key), /belongs to another model/);
  await assert.rejects(queueRenderTest(db, { id: '99999999-1234-4abc-8abc-123456789abc', model }, key), /already in progress/);
  assert.deepEqual(await listRenderTests(db), [first]);
});

test('LONG AI checks the actual selected model, saves its task, and verifies output without resubmitting', async () => {
  const db = fakeDb({ id, model: 'veo-3.1-lite', status: 'queued', key_fingerprint: digest, age: 0 });
  const calls = [];
  const client = new LongAiClient({
    apiKey: key,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      if (options.method === 'POST') return Response.json({ id: 'task_123', status_url: '/v1/videos/task_123' });
      return Response.json({ status: 'completed', video_url: 'https://media.example.test/clip.mp4' });
    },
  });
  let verified = false;
  client.download = async url => { assert.equal(url, 'https://media.example.test/clip.mp4'); verified = true; };
  db.customerRunning = true;
  await runRenderTest(db, client, true);
  assert.equal(calls.length, 0);
  db.customerRunning = false;
  await runRenderTest(db, client, true);
  assert.equal(db.row.status, 'accepted');
  assert.equal(db.row.task_id, 'task_123');
  assert.deepEqual(Object.keys(calls[0].body), ['model', 'prompt']);
  assert.equal(calls[0].body.model, 'veo-3.1-lite');
  await runRenderTest(db, client, false);
  assert.equal(db.row.status, 'verified');
  assert.equal(verified, true);
  await runRenderTest(db, client, true);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
});

test('LONG AI distinguishes upstream 503, interrupted submission, and unverified output', async () => {
  const row = () => ({ id, model, status: 'queued', key_fingerprint: digest, age: 0 });
  const rejected = fakeDb(row());
  let posts = 0;
  const unavailable = { apiKey: key, async startVideo() {
    posts++;
    throw Object.assign(new Error('private raw message'), { providerStatus: 503, providerRequestId: 'req_safe' });
  } };
  await runRenderTest(rejected, unavailable, true);
  assert.equal(rejected.row.status, 'submit_failed');
  assert.equal(rejected.row.providerStatus, 503);
  assert.equal(rejected.row.providerRequestId, 'req_safe');
  assert.doesNotMatch(rejected.row.diagnostic, /private/);
  await runRenderTest(rejected, unavailable, true);
  assert.equal(posts, 1);

  const interrupted = fakeDb({ ...row(), status: 'submitting', submissionAge: 120 });
  await runRenderTest(interrupted, unavailable, true);
  assert.equal(interrupted.row.status, 'submission_unknown');
  assert.equal(posts, 1);
  const retry = { id: '99999999-1234-4abc-8abc-123456789abc', model };
  await assert.rejects(queueRenderTest(interrupted, retry, key), /Check the uncertain attempt/);
  assert.equal((await queueRenderTest(interrupted, { ...retry, confirmReconciled: true }, key)).status, 'queued');

  const output = fakeDb({ ...row(), status: 'accepted', task_id: 'task_123', provider_operation: '{"requestId":"task_123"}' });
  await runRenderTest(output, { apiKey: key, async videoStatus() { return { status: 'missing_output' }; } }, true);
  assert.equal(output.row.status, 'output_unverified');
  assert.equal(output.row.task_id, 'task_123');
});

test('LONG AI records the submission timeout through the pool after releasing the claim connection', async () => {
  const db = fakeDb({ id, model, status: 'queued', key_fingerprint: digest, age: 0 });
  let claimReleased = false;
  let connectionExpired = false;
  db.getConnection = async () => ({
    query: db.query,
    async execute(...args) {
      if (connectionExpired) throw new Error('Connection is in a closed state');
      return db.execute(...args);
    },
    release() { claimReleased = true; },
  });
  let posts = 0;
  let begin, finish;
  const started = new Promise(resolve => { begin = resolve; });
  const wait = new Promise(resolve => { finish = resolve; });
  const client = new LongAiClient({ apiKey: key, fetchImpl: async (url, request) => {
    assert.equal(request.method, 'POST');
    posts++;
    begin();
    await wait;
    connectionExpired = true;
    throw Object.assign(new Error('timeout'), { code: 'ABORT_ERR' });
  } });
  const submit = runRenderTest(db, client, true);
  await started;
  assert.equal(claimReleased, true);
  assert.equal(db.row.status, 'submitting');
  await runRenderTest(db, client, true);
  assert.equal(db.row.status, 'submitting');
  finish();
  await submit;
  assert.equal(db.row.status, 'submission_unknown');
  assert.match(db.row.diagnostic, /CMMTools received no LONG AI response/);
  await runRenderTest(db, client, true);
  assert.equal(posts, 1);
});

test('LONG AI records an HTTP response separately from a confirmed task ID', async () => {
  const db = fakeDb({ id, model, status: 'queued', key_fingerprint: digest, age: 0 });
  const client = new LongAiClient({ apiKey: key, fetchImpl: async () =>
    Response.json({ status: 'submitted' }, { status: 202, headers: { 'x-request-id': 'req_fixture_202' } }) });
  await runRenderTest(db, client, true);
  assert.equal(db.row.status, 'submission_unknown');
  assert.equal(db.row.providerStatus, 202);
  assert.equal(db.row.providerRequestId, 'req_fixture_202');
  assert.match(db.row.diagnostic, /LONG AI returned a response without a confirmed task ID/);
});

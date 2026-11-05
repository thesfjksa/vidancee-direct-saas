'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { browserlessUrl, createSession, connectSession } = require('../src/provider/browserless.js');
const { configFrom, publicConfig } = require('../src/aivid_settings.js');
const { validateJob, validateSubmission, creditState, providerId, AividBrowserlessClient, installRequestGuard } = require('../src/provider/aivid.js');
const { AividQueue, reconcileAivid } = require('../src/aivid_queue.js');

const connectUrl = 'wss://production-sfo.browserless.io/session/test?token=secret-test-token';
const providerJobId = '6aec589f09c74e1c2ef12900';
const input = { prompt: 'A quiet river at dawn', duration: 4, aspectRatio: '16:9', resolution: '480p' };
const payload = { ...input, model: 'seedance-2.0-mini', isPublic: false, references: [] };

test('pilot defaults off and never exposes a connection credential in status', () => {
  const config = configFrom({ AIVID_BROWSERLESS_CONNECT_URL: connectUrl });
  assert.equal(config.enabled, false); assert.equal(config.maxSourceCredits, 0);
  assert.equal(JSON.stringify(publicConfig(config)).includes('secret-test-token'), false);
  assert.equal(publicConfig(config).customerModelEnabled, false);
  for (const url of ['ws://production-sfo.browserless.io', 'wss://browserless.io.evil.test', 'wss://evil.test', 'wss://u:p@production-sfo.browserless.io'])
    assert.throws(() => browserlessUrl(url));
});

test('session creation uses an explicit persistent Chrome session without recordings', async () => {
  let seen;
  const session = await createSession({ token: 'test-token', fetchImpl: async (url, options) => {
    seen = { url: String(url), options };
    return Response.json({ id: 'test', connect: connectUrl, stop: 'https://production-sfo.browserless.io/session/test?token=test-token' });
  } });
  assert.equal(session.connect, connectUrl);
  const body = JSON.parse(seen.options.body);
  assert.equal(body.browser, 'chrome'); assert.equal(body.replay, false); assert.equal(body.ttl, 86400000);
  assert.equal(seen.options.redirect, 'error');
  await assert.rejects(createSession({ token: 'test-token', fetchImpl: async () => { throw new Error(connectUrl); } }), error => !error.message.includes('secret-test-token'));
});

test('remote connection keeps the persistent context and closes stale job pages', async () => {
  let closed = 0, newContexts = 0, remoteClosed = 0, gotUrl;
  const old = { close: async () => { closed++; } }, page = { setDefaultTimeout() {} };
  const context = { newPage: async () => page, pages: () => [old, page] };
  const remote = await connectSession(connectUrl, { chromium: { connectOverCDP: async url => {
    gotUrl = url; return { contexts: () => [context], newContext() { newContexts++; }, close: async () => { remoteClosed++; } };
  } } });
  assert.equal(remote.context, context); assert.equal(closed, 1); assert.equal(newContexts, 0);
  assert.match(gotUrl, /timeout=90000/);
  await remote.close(); assert.equal(remoteClosed, 1);
});

test('reference validation preserves all kinds and rejects over-limit files', () => {
  const refs = [{ kind: 'image', mimeType: 'image/png', data: Buffer.from('png') },
    { kind: 'video', mimeType: 'video/mp4', data: Buffer.from('mp4') }];
  assert.deepEqual(validateJob(input, refs).counts, { image: 1, video: 1, audio: 0 });
  assert.throws(() => validateJob(input, Array(10).fill(refs[0])), /count/);
  assert.throws(() => validateJob(input, [{ ...refs[0], mimeType: 'image/svg+xml' }]), /unsupported/);
  assert.throws(() => validateJob({ ...input, duration: 30 }), /4–15/);
});

test('credit price cannot be mistaken for the account balance', () => {
  assert.deepEqual(creditState('Account 0 credits\n2 Credits / Video'), { price: 2, balance: 0 });
  assert.throws(() => creditState('2 Credits / Video'), /balance/);
  assert.throws(() => creditState('40 credits 20 credits 2 Credits / Video'), /balance/);
});

test('paid request guard requires exact settings, private visibility and every reference', () => {
  const job = validateJob(input);
  assert.doesNotThrow(() => validateSubmission(payload, job));
  for (const change of [{ isPublic: true }, { duration: 15 }, { prompt: 'other' }, { resolution: '720p' }, { references: [{}] }])
    assert.throws(() => validateSubmission({ ...payload, ...change }, job));
  const absentPrivacy = { ...payload }; delete absentPrivacy.isPublic;
  assert.throws(() => validateSubmission(absentPrivacy, job), /private/);
  const refs = [{ kind: 'video', mimeType: 'video/mp4', data: Buffer.from('mp4') }];
  const withVideo = validateJob(input, refs);
  assert.throws(() => validateSubmission(payload, withVideo), /incomplete/);
  assert.doesNotThrow(() => validateSubmission({ ...payload, references: [{ type: 'video', id: 'uploaded-video' }] }, withVideo));
  assert.equal(providerId({ data: { id: providerJobId } }), providerJobId);
  assert.equal(providerId({ id: 'not-a-job' }), null);
});

test('interception blocks duplicate POSTs and public or incomplete requests before forwarding', async () => {
  const cdp = new EventEmitter(), calls = [];
  cdp.send = async (method, args) => { calls.push({ method, args }); };
  cdp.detach = async () => {};
  const guard = await installRequestGuard({ context: () => ({ newCDPSession: async () => cdp }) }, validateJob(input));
  const handler = cdp.listeners('Fetch.requestPaused')[0];
  const url = 'https://api.aivid.dev/v2/generations';
  await handler({ requestId: 'public', request: { url, method: 'POST', postData: JSON.stringify({ ...payload, isPublic: true }) } });
  assert.equal(calls.at(-1).method, 'Fetch.failRequest');
  await handler({ requestId: 'moved-endpoint', request: { url: 'https://api.aivid.dev/v3/generations', method: 'POST', postData: JSON.stringify(payload) } });
  assert.equal(calls.at(-1).method, 'Fetch.failRequest');
  await handler({ requestId: 'first', request: { url, method: 'POST', postData: JSON.stringify(payload) } });
  await handler({ requestId: 'duplicate', request: { url, method: 'POST', postData: JSON.stringify(payload) } });
  assert.equal(calls.filter(c => c.method === 'Fetch.continueRequest').length, 1);
  assert.equal(calls.at(-1).method, 'Fetch.failRequest');
  await guard.close();
});

test('paid submission cannot run without a reservation and explicit source credit limit', async () => {
  let connections = 0;
  const client = new AividBrowserlessClient({ connectUrl, connect: async () => { connections++; } });
  await assert.rejects(client.startVideo(input), /reservation/);
  await assert.rejects(client.startVideo(input, [], { beforeClick: async () => {} }), /credit limit/);
  assert.equal(connections, 0);
});

function fixture({ startVideo, status = 'queued', op = {}, output = { state: 'pending' }, enabled = true, charges = true } = {}) {
  const job = { id: '12345678-1234-1234-1234-123456789012', user_id: 1, media_type: 'video',
    model: 'aivid_pilot_mini', provider: 'aivid', status, generation_options: '{}',
    prompt: input.prompt, duration: input.duration, aspect_ratio: input.aspectRatio, resolution: input.resolution,
    provider_operation: JSON.stringify(op), provider_job_id: op.providerJobId || null };
  let submissions = 0, polls = 0, refunds = 0, complete = 0;
  const queries = [];
  const execute = async (sql, args) => {
    queries.push(sql);
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('RELEASE_LOCK')) return [[{}]];
    if (sql.startsWith('SELECT media_kind')) return [[]];
    if (sql.startsWith('SELECT * FROM generations WHERE id=')) return [[{ ...job }]];
    if (sql.startsWith('SELECT * FROM generations') && sql.includes("status='submitting'")) return [[...(!job.refunded_at && job.status === 'submitting' ? [{ ...job }] : [])]];
    if (sql.startsWith('SELECT * FROM generations') && sql.includes("status IN ('submitted','processing')"))
      return [[...(!job.refunded_at && ['submitted', 'processing'].includes(job.status) ? [{ ...job }] : [])]];
    if (sql.startsWith('SELECT g.*')) return [[...(job.status === 'queued' ? [{ ...job }] : [])]];
    if (sql.startsWith('UPDATE generations')) {
      if (sql.includes("status='submitting'")) {
        if (sql.includes("SET status='submitting'")) { job.status = 'submitting'; job.provider_operation = args[0]; }
        else if (sql.includes('SET provider_operation=')) job.provider_operation = args[0];
      }
      if (sql.includes("SET status='submitted'")) {
        job.status = 'submitted';
        if (sql.includes('provider_job_id=?')) { job.provider_job_id = args[0]; job.provider_operation = args[1]; }
        else job.provider_operation = args[0];
      }
      if (sql.includes("SET status='processing'")) job.status = 'processing';
      return [{ affectedRows: 1 }];
    }
    throw new Error('Unexpected SQL: ' + sql);
  };
  const db = { query: execute, execute, getConnection: async () => ({ query: execute, release() {} }) };
  const q = new AividQueue({ getConfig: async () => ({ connectUrl, maxSourceCredits: 5, enabled }),
    getSettings: async () => ({ allowProviderCharges: charges }),
    refund: async () => { refunds++; job.refunded_at = new Date(); job.status = 'failed'; },
    clientFactory: () => ({ startVideo: async (...args) => {
      submissions++;
      if (startVideo) return startVideo(...args);
      await args[2].beforeClick({ price: 2 });
      return { state: 'accepted', providerJobId };
    }, collectVideo: async () => { polls++; return output; } }) });
  q.complete = async () => { complete++; job.status = 'completed'; };
  q.stopped = false;
  return { q, db, job, queries, stats: () => ({ submissions, polls, refunds, complete }) };
}

test('queue persists an accepted ID and restart polls it without another charge', async () => {
  const f = fixture();
  await f.q.runOnce(f.db); assert.equal(f.job.provider_job_id, providerJobId);
  assert.equal(f.job.status, 'submitted');
  await f.q.runOnce(f.db);
  assert.deepEqual(f.stats(), { submissions: 1, polls: 1, refunds: 0, complete: 0 });
  assert.ok(f.queries.some(q => q.includes("provider_cost_unit='aivid_credits'")));
});

test('pre-click failures refund once; uncertain post-click failures hold across restarts', async () => {
  const safe = fixture({ startVideo: async () => { throw new Error('signed out'); } });
  await safe.q.runOnce(safe.db); await safe.q.runOnce(safe.db);
  assert.equal(safe.stats().refunds, 1); assert.equal(safe.stats().submissions, 1);
  const uncertain = fixture({ startVideo: async (_job, _refs, { beforeClick }) => {
    await beforeClick({ price: 2 }); throw new Error('connection lost');
  } });
  await uncertain.q.runOnce(uncertain.db); await uncertain.q.runOnce(uncertain.db);
  assert.equal(JSON.parse(uncertain.job.provider_operation).stage, 'review_required');
  assert.deepEqual(uncertain.stats(), { submissions: 1, polls: 0, refunds: 0, complete: 0 });
});

test('crash recovery holds reserved clicks and safely refunds interrupted preparation', async () => {
  const uncertain = fixture({ status: 'submitting', op: { stage: 'click_reserved', price: 2 } });
  await uncertain.q.runOnce(uncertain.db);
  assert.equal(JSON.parse(uncertain.job.provider_operation).stage, 'review_required');
  assert.equal(uncertain.stats().submissions, 0); assert.equal(uncertain.stats().refunds, 0);
  const safe = fixture({ status: 'submitting', op: { stage: 'preparing' } });
  await safe.q.runOnce(safe.db); assert.equal(safe.stats().refunds, 1);
});

test('paused new jobs still collect accepted jobs; download failures retain the ID', async () => {
  const paused = fixture({ enabled: false, charges: false });
  await paused.q.runOnce(paused.db); assert.equal(paused.stats().submissions, 0);
  const done = fixture({ enabled: false, charges: false, status: 'submitted', op: { stage: 'accepted', providerJobId }, output: { state: 'completed', output: { data: Buffer.from('video'), mimeType: 'video/mp4' } } });
  await done.q.runOnce(done.db); assert.equal(done.stats().complete, 1);
  done.job.status = 'submitted'; done.q.complete = async () => { throw new Error('storage offline'); };
  await done.q.runOnce(done.db);
  assert.equal(done.job.provider_job_id, providerJobId); assert.equal(done.stats().refunds, 0);
});

test('reconciliation only accepts held jobs and explicit account-history confirmation', async () => {
  const held = fixture({ status: 'submitted', op: { stage: 'review_required' } });
  await assert.rejects(reconcileAivid(held.db, held.job.id, { action: 'refund' }), /confirm/);
  let refunds = 0;
  await reconcileAivid(held.db, held.job.id, { action: 'attach', providerJobId }, async () => { refunds++; });
  assert.equal(held.job.provider_job_id, providerJobId); assert.equal(refunds, 0);
  await assert.rejects(reconcileAivid(held.db, held.job.id, { action: 'attach', providerJobId }), /Only a held/);
});

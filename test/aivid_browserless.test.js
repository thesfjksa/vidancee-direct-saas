'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { browserlessUrl, createSession, connectSession, createLoginView } = require('../src/provider/browserless.js');
const { configFrom, publicConfig } = require('../src/aivid_settings.js');
const { validateJob, validateSubmission, creditState, providerId, submissionResult, AividBrowserlessClient, installRequestGuard } = require('../src/provider/aivid.js');
const { AividQueue, reconcileAivid } = require('../src/aivid_queue.js');

const connectUrl = 'wss://production-sfo.browserless.io/session/test?token=secret-test-token';
const providerJobId = '6aec589f09c74e1c2ef12900';
const input = { prompt: 'A quiet river at dawn', duration: 4, aspectRatio: '16:9', resolution: '480p' };
const payload = { ...input, model: 'seedance-2.0-mini', isPublic: true, references: [] };

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

test('Browserless creation failures report actionable HTTP errors without upstream secrets', async () => {
  const cases = [
    [401, 'Invalid API key', /rejected authentication/],
    [403, 'Forbidden', /denied access/],
    [400, 'ttl exceeds maximum allowed', /Select 1 day/],
    [401, 'Your account is out of units', /no available units/],
    [403, 'Requires a paid plan', /denied this feature/],
    [429, 'Too many requests', /active-session or request limit/],
    [503, 'Upstream unavailable', /unavailable/],
  ];
  for (const [status, reason, expected] of cases) {
    await assert.rejects(createSession({ token: 'private-key', fetchImpl: async () =>
      new Response(reason + ' ' + connectUrl, { status }) }), error => {
      assert.equal(error.aividSafe, true); assert.equal(error.statusCode, 502);
      assert.match(error.message, new RegExp('HTTP ' + status)); assert.match(error.message, expected);
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /secret-test-token|private-key|wss:/);
      return true;
    });
  }
  // Neither arbitrary upstream text nor credential-bearing invalid URLs are surfaced.
  for (const response of [new Response('sensitive account information ' + connectUrl, { status: 400 }),
    Response.json({ connect: 'wss://evil.test/?token=private-key', stop: connectUrl }),
    Response.json({}), new Response('not JSON')]) {
    await assert.rejects(createSession({ token: 'private-key', fetchImpl: async () => response }), error => {
      assert.equal(error.aividSafe, true);
      assert.doesNotMatch(error.stack, /private-key|secret-test-token|sensitive account|evil.test/); return true;
    });
  }
});

test('creation error bodies are bounded and WebSocket status is reported without the dial URL', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(20000)); },
    cancel() { cancelled = true; } });
  await assert.rejects(createSession({ token: 'private-key', fetchImpl: async () => new Response(stream, { status: 403 }) }), /HTTP 403/);
  assert.equal(cancelled, true);
  await assert.rejects(connectSession(connectUrl, { chromium: { connectOverCDP: async () => {
    throw new Error('WebSocket error: ' + connectUrl + ' Unexpected server response: 429');
  } } }), error => {
    assert.match(error.message, /HTTP 429/); assert.doesNotMatch(error.stack, /secret-test-token|wss:/); return true;
  });
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

test('login view fixes the viewport and enables input before handing off; read-only results are refused', async () => {
  const calls = [];
  let response = { liveURL: 'https://production-sfo.browserless.io/live/index.html?i=private-viewer', liveURLId: 'test-view', timeout: 80000 };
  const cdp = { send: async (method, params) => { calls.push({ method, params }); return method === 'Browserless.liveURL' ? response : {}; } };
  const remote = { page: { setViewportSize: async size => calls.push({ viewport: size }), bringToFront: async () => calls.push({ foreground: true }) },
    context: { newCDPSession: async () => cdp } };
  const live = await createLoginView(remote, { timeoutMs: 85000 });
  assert.equal(live.cdp, cdp); assert.equal(live.timeout, 80000);
  assert.deepEqual(calls.slice(0, 3), [{ viewport: { width: 1024, height: 720 } }, { foreground: true },
    { method: 'Input.setIgnoreInputEvents', params: { ignore: false } }]);
  assert.deepEqual(calls[3], { method: 'Browserless.liveURL', params: { interactable: true, timeout: 85000,
    resizable: false, showBrowserInterface: false, mode: 'follow', showTimer: true, type: 'jpeg', quality: 30 } });
  for (const rejected of [{ ...response, interactable: false }, { ...response, error: connectUrl }]) {
    response = rejected;
    await assert.rejects(createLoginView(remote), error => {
      assert.equal(error.aividSafe, true); assert.doesNotMatch(error.stack, /secret-test-token|private-viewer|wss:/); return true;
    });
    assert.deepEqual(calls.at(-1), { method: 'Browserless.closeLiveURL', params: { liveURLId: 'test-view' } });
  }
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

test('paid request guard requires exact settings, public visibility and every reference', () => {
  const job = validateJob(input);
  assert.doesNotThrow(() => validateSubmission(payload, job));
  for (const change of [{ isPublic: false }, { duration: 15 }, { prompt: 'other' }, { resolution: '720p' }, { references: [{}] }])
    assert.throws(() => validateSubmission({ ...payload, ...change }, job));
  const absentPrivacy = { ...payload }; delete absentPrivacy.isPublic;
  assert.throws(() => validateSubmission(absentPrivacy, job), /public/);
  for (const visibility of [{ public: true },{ isPrivate: false },{ private: false },{ visibility: 'public' }])
    assert.doesNotThrow(() => validateSubmission({ ...absentPrivacy, ...visibility }, job));
  for (const conflict of [{ isPrivate: true },{ private: true },{ public: false },{ visibility: 'private' }])
    assert.throws(() => validateSubmission({ ...payload, ...conflict }, job), /public/);
  const refs = [{ kind: 'video', mimeType: 'video/mp4', data: Buffer.from('mp4') }];
  const withVideo = validateJob(input, refs);
  assert.throws(() => validateSubmission(payload, withVideo), /verified/);
  assert.throws(() => validateSubmission({ ...payload, references: [{ type: 'video', id: 'uploaded-video' }] }, withVideo),/verified/);
  assert.doesNotThrow(() => validateSubmission({ ...payload, videoIds:['uploaded-video-0001'] }, withVideo,[{kind:'video',id:'uploaded-video-0001'}]));
  assert.equal(providerId({ data: { id: providerJobId } }), providerJobId);
  assert.equal(providerId({ id: 'not-a-job' }), null);
});

test('interception blocks duplicate POSTs and private or incomplete requests before forwarding', async () => {
  const cdp = new EventEmitter(), calls = [], blocked = [];
  cdp.send = async (method, args) => { calls.push({ method, args }); };
  cdp.detach = async () => {};
  const guard = await installRequestGuard({ context: () => ({ newCDPSession: async () => cdp }) }, validateJob(input),
    { onBlockedRequest: request => blocked.push(request) });
  const handler = cdp.listeners('Fetch.requestPaused')[0];
  const url = 'https://api.aivid.dev/v2/generations';
  await handler({ requestId: 'too-early', request: { url, method: 'POST', postData: JSON.stringify(payload) } });
  assert.equal(calls.at(-1).method, 'Fetch.failRequest'); assert.equal(guard.allowed, false);
  guard.arm();
  await handler({ requestId: 'card-likes', request: {
    url: 'https://api.aivid.dev/v2/interactions/likes/bulk', method: 'POST', postData: '{}' } });
  assert.equal(calls.at(-1).method, 'Fetch.continueRequest');
  assert.equal(guard.allowed, false);
  assert.equal(blocked.length, 0);
  for (const endpoint of [
    'https://api.aivid.dev/v2/interactions/likes/bulk?extra=1',
    'https://api.aivid.dev/v2/interactions/likes',
    'https://other.example/v2/interactions/likes/bulk'
  ]) {
    await handler({ requestId: 'unknown-interaction', request: {url:endpoint, method:'POST'} });
    assert.equal(calls.at(-1).method, 'Fetch.failRequest');
  }
  assert.deepEqual(blocked, [{method:'POST', hostname:'api.aivid.dev', path:'/v2/interactions/likes/bulk'}]);
  await handler({ requestId: 'private', request: { url, method: 'POST', postData: JSON.stringify({ ...payload, isPublic: false }) } });
  assert.equal(calls.at(-1).method, 'Fetch.failRequest');
  await handler({ requestId: 'moved-endpoint', request: {
    url: 'https://user:secret@api.aivid.dev/v3/generations/abcdef0123456789?token=secret',
    method: 'POST', postData: JSON.stringify(payload)
  } });
  assert.equal(calls.at(-1).method, 'Fetch.failRequest');
  await handler({ requestId: 'first', request: { url, method: 'POST', postData: JSON.stringify(payload) } });
  await handler({ requestId: 'duplicate', request: { url, method: 'POST', postData: JSON.stringify(payload) } });
  assert.equal(calls.filter(c => c.method === 'Fetch.continueRequest').length, 2);
  assert.equal(calls.at(-1).method, 'Fetch.failRequest');
  await guard.close();
});

test('request-paused listener is installed before Fetch.enable can pause in-flight requests', async () => {
  const cdp = new EventEmitter(), calls = [];
  cdp.send = async (method,args) => {
    calls.push({method,args});
    if(method==='Fetch.enable'){
      assert.equal(cdp.listenerCount('Fetch.requestPaused'),1,
        'the handler must exist before Fetch.enable emits its first event');
      cdp.emit('Fetch.requestPaused',{requestId:'already-in-flight',request:{
        method:'GET',url:'https://aivid.dev/api/session'}}); 
      await new Promise(resolve=>setImmediate(resolve));
    }
  };
  cdp.detach = async () => {};
  const guard=await installRequestGuard(
    {context:()=>({newCDPSession:async()=>cdp})},
    validateJob(input));
  assert.ok(calls.some(call=>call.method==='Fetch.continueRequest'&&
    call.args.requestId==='already-in-flight'),
    'the first in-flight request must be resumed instead of stranded');
  await guard.close();
});

test('background likes refresh does not reject or reserve a video submission', async () => {
  const cdp = new EventEmitter(), calls = [];
  let reservations = 0;
  cdp.send = async (method, args) => { calls.push({method, args}); };
  cdp.detach = async () => {};
  const guard = await installRequestGuard({context: () => ({newCDPSession: async () => cdp})},
    validateJob(input), {beforeGenerate: async () => { reservations++; }});
  const handler = cdp.listeners('Fetch.requestPaused')[0];
  guard.arm();
  await handler({requestId:'likes', request:{method:'POST', url:'https://api.aivid.dev/v2/interactions/likes/bulk'}});
  assert.equal(guard.error, null);
  assert.equal(guard.allowed, false);
  assert.equal(reservations, 0);
  await handler({requestId:'video', request:{method:'POST', url:'https://api.aivid.dev/v2/generations',
    postData:JSON.stringify(payload)}});
  assert.equal(guard.error, null);
  assert.equal(guard.allowed, true);
  assert.equal(reservations, 1);
  assert.deepEqual(calls.filter(call => call.method === 'Fetch.continueRequest').map(call => call.args.requestId), ['likes','video']);
  await guard.close();
});

test('background mutations before and after the authorized POST cannot prematurely clear a paid AIVID tab', async () => {
  const cdp = new EventEmitter(), calls = [], blocked = [];
  let reservations = 0, failedEarly = false;
  cdp.send = async (method,args) => { calls.push({method,args}); };
  cdp.detach = async () => {};
  const guard = await installRequestGuard({context: () => ({newCDPSession: async () => cdp})},
    validateJob(input), {
      beforeGenerate: async () => {reservations++;},
      onBlockedRequest: request => blocked.push(request)
    });
  guard.failure.catch(() => { failedEarly = true; });
  const handler = cdp.listeners('Fetch.requestPaused')[0];
  guard.arm();
  // AIVID performs unrelated POSTs while preparing the generation page. Keep
  // unknown mutations blocked, but do not mistake them for generation failure.
  await handler({requestId:'ambient-before',request:{
    method:'POST',url:'https://api.aivid.dev/v2/interactions/other',postData:'{}'}});
  assert.equal(calls.at(-1).method,'Fetch.failRequest');
  assert.equal(guard.error,null);
  assert.equal(guard.allowed,false);
  assert.equal(reservations,0);

  await handler({requestId:'paid-video',request:{
    method:'POST',url:'https://api.aivid.dev/v2/generations',postData:JSON.stringify(payload)}});
  assert.equal(calls.at(-1).method,'Fetch.continueRequest');
  assert.equal(guard.allowed,true);
  assert.equal(guard.claimed,true);
  assert.equal(reservations,1);

  // This race used to reject guard.failure and immediately navigate the page
  // to about:blank before the /v2/generations response could arrive.
  await handler({requestId:'ambient-after',request:{
    method:'POST',url:'https://api.aivid.dev/v2/interactions/other',postData:'{}'}});
  assert.equal(calls.at(-1).method,'Fetch.failRequest');
  await handler({requestId:'duplicate-video',request:{
    method:'POST',url:'https://api.aivid.dev/v2/generations',postData:JSON.stringify(payload)}});
  assert.equal(calls.at(-1).method,'Fetch.failRequest');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failedEarly,false,'a late blocked request must not end response wait for an authorized job');
  assert.equal(reservations,1,'unrelated or duplicate requests cannot reserve a second charge');
  assert.equal(calls.filter(x=>x.method==='Fetch.continueRequest').length,1);
  assert.deepEqual(blocked,[{method:'POST',hostname:'api.aivid.dev',path:'/v2/interactions/other'}]);
  await guard.close();
});

test('paid submission cannot run without a reservation and explicit source credit limit', async () => {
  let connections = 0;
  const client = new AividBrowserlessClient({ connectUrl, connect: async () => { connections++; } });
  await assert.rejects(client.startVideo(input), /reservation/);
  await assert.rejects(client.startVideo(input, [], { beforeClick: async () => {} }), /credit limit/);
  assert.equal(connections, 0);
});

test('timeouts, conflicts, throttles and successful responses without IDs remain uncertain', () => {
  for (const status of [200, 202, 408, 409, 425, 429, 500, 502, 504])
    assert.equal(submissionResult(status, {}).state, 'submission_uncertain');
  assert.equal(submissionResult(402, {}).state, 'rejected');
  assert.equal(submissionResult(200, { id: providerJobId }).state, 'accepted');
  assert.equal(submissionResult(409, { id: providerJobId }).state, 'submission_uncertain');
});

function fixture({ startVideo, status = 'queued', op = {}, output = { state: 'pending' }, enabled = true, charges = true, configOverrides = {}, liveRdpCommand = () => false } = {}) {
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
    if (sql.startsWith('SELECT id FROM aivid_rdp_commands')) {
      assert.deepEqual(args, [job.id]);
      return [liveRdpCommand() ? [{id:'active-command'}] : []];
    }
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
  const q = new AividQueue({ getConfig: async () => ({ connectUrl, maxSourceCredits: 5, enabled, ...configOverrides }),
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

test('unclassified RDP dispatch error reports a safe stage and never leaks raw errors',async()=>{
  const secret='https://private.example/?token=do-not-log-this';
  const f=fixture({startVideo:async()=>{throw new Error(secret)}});
  const original=f.q.refund;
  let message='';
  f.q.refund=async(...args)=>{message=args[2];return original(...args)};
  await f.q.runOnce(f.db);
  assert.match(message,/\[rdp_dispatch\]/);
  assert.doesNotMatch(message,/private\\.example|do-not-log-this/);
  assert.equal(f.stats().refunds,1);
  assert.equal(f.job.status,'failed');
});

test('reference retrieval and pre-reservation errors show distinct codes without a new paid click',async()=>{
  const refs=fixture();
  refs.q.filesFor=async()=>{throw Object.assign(new Error('cloud storage credentials'),{
    aividCode:'reference_storage',storageStatus:500})};
  let refMessage='';
  const originalRefund=refs.q.refund;
  refs.q.refund=async(...args)=>{refMessage=args[2];return originalRefund(...args)};
  await refs.q.runOnce(refs.db);
  assert.match(refMessage,/\[reference_storage\]/);
  assert.doesNotMatch(refMessage,/credentials|HTTP 500/);
  assert.equal(refs.stats().submissions,0);
  assert.equal(refs.stats().refunds,1);

  const reservation=fixture();
  const getSettings=reservation.q.getSettings;
  let checks=0,reservationMessage='';
  reservation.q.getSettings=async()=>++checks>1?Promise.reject(new Error('internal MySQL error')):getSettings();
  const refund=reservation.q.refund;
  reservation.q.refund=async(...args)=>{reservationMessage=args[2];return refund(...args)};
  await reservation.q.runOnce(reservation.db);
  assert.match(reservationMessage,/\[reservation_precheck\]/);
  assert.doesNotMatch(reservationMessage,/MySQL error/);
  assert.equal(reservation.stats().refunds,1);
  assert.equal(reservation.stats().submissions,1);
  assert.equal(reservation.job.provider_job_id,null);
});

test('unavailable reference DB reports a safe code before dispatch',async()=>{
  const f=fixture();
  await assert.rejects(f.q.filesFor({execute:async()=>{throw Error('raw database error')}},f.job),
    error=>error.aividCode==='reference_database'&&!error.message.includes('raw database error'));
});

test('crash recovery holds reserved clicks and safely refunds interrupted preparation', async () => {
  const uncertain = fixture({ status: 'submitting', op: { stage: 'click_reserved', price: 2 } });
  await uncertain.q.runOnce(uncertain.db);
  assert.equal(JSON.parse(uncertain.job.provider_operation).stage, 'review_required');
  assert.equal(uncertain.stats().submissions, 0); assert.equal(uncertain.stats().refunds, 0);
  const safe = fixture({ status: 'submitting', op: { stage: 'preparing' } });
  await safe.q.runOnce(safe.db); assert.equal(safe.stats().refunds, 1);
});

test('recovery leaves an active RDP submission alone after another worker loses its lock', async () => {
  let live = true;
  const f = fixture({status:'submitting',op:{stage:'preparing'},liveRdpCommand:()=>live,
    configOverrides:{mode:'rdp',rdpDevice:{tokenHash:'paired'}}});
  await f.q.runOnce(f.db);
  assert.equal(f.job.status,'submitting');
  assert.deepEqual(f.stats(),{submissions:0,polls:0,refunds:0,complete:0});
  live = false;
  await f.q.runOnce(f.db);
  assert.equal(f.stats().refunds,1);
});

test('paused new jobs still collect accepted jobs; download failures retain the ID', async () => {
  const paused = fixture({ enabled: false, charges: false });
  await paused.q.runOnce(paused.db); assert.equal(paused.stats().submissions, 0);
  const done = fixture({ enabled: false, charges: false, status: 'submitted', op: { stage: 'accepted', providerJobId }, output: { state: 'completed', output: { data: Buffer.from('video'), mimeType: 'video/mp4' } } });
  await done.q.runOnce(done.db); assert.equal(done.stats().complete, 1);
  done.job.status = 'submitted'; done.q.complete = async () => { throw new Error('storage offline'); };
  await assert.rejects(done.q.pollJob(done.db,done.q.clientFactory(),done.job),{aividCode:'collection_storage'});
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

test('standard Seedance 2.0 rejects Fast, Mini and other parenthesized variants',()=>{
  const {selectedModelMatches}=require('../src/provider/aivid.js');
  for(const text of ['Seedance 2.0','Seedance 2.0\nMultimodal references.','Seedance 2.0 High quality'])assert.equal(selectedModelMatches(text,'aivid_seedance_2_0'),true);
  for(const text of ['Seedance 2.0 (Fast)','Seedance 2.0 (Fast)\nFaster generation with slightly reduced quality.','Seedance 2.0 (Mini)','Seedance 2.0 (Pro)','Seedance 2.0   (Fast)','Seedance 2.01','Seedance 2.5'])assert.equal(selectedModelMatches(text,'aivid_seedance_2_0'),false,text);
  assert.equal(selectedModelMatches('Seedance 2.0 (Mini) Most cost-effective, quicker results.','aivid_seedance_2_0_mini'),true);
});

test('an unready RDP collector releases the browser lock for connection recovery without changing the paid job',async()=>{
  const {withAividLock}=require('../src/aivid_queue.js');
  for(const [status,seenAt]of [['needs_login',new Date().toISOString()],['starting',new Date().toISOString()],['busy',new Date().toISOString()],['ready',new Date(Date.now()-60000).toISOString()]]){
    const f=fixture({status:'submitted',op:{stage:'accepted',providerJobId},configOverrides:{mode:'rdp',rdpDevice:{deviceId:'fixture-device',tokenHash:'paired',status,seenAt}}});
    await f.q.runOnce(f.db);
    assert.deepEqual(f.stats(),{submissions:0,polls:0,refunds:0,complete:0});
    assert.equal(f.job.provider_job_id,providerJobId);assert.equal(f.job.status,'submitted');
    assert.equal(f.q.health().collectionWaitingForAgent,true);
    assert.ok(f.queries.at(-1).includes('RELEASE_LOCK'));
    assert.deepEqual(await withAividLock(f.db,async()=>({ready:true})),{ready:true});
  }
  const f=fixture({status:'submitted',enabled:false,charges:false,output:{state:'completed',output:{}},op:{stage:'accepted',providerJobId},configOverrides:{mode:'rdp',maxSourceCredits:0,rdpDevice:{deviceId:'fixture-device',tokenHash:'paired',status:'ready',seenAt:new Date().toISOString()}}});
  await f.q.runOnce(f.db);
  assert.deepEqual(f.stats(),{submissions:0,polls:1,refunds:0,complete:1});
  assert.equal(f.q.health().collectionWaitingForAgent,false);
});
test('a held older video cannot starve collection of another accepted customer video',async()=>{
 const f=fixture({status:'submitted',op:{stage:'accepted',providerJobId}}),original=f.db.query;
 f.db.query=async(sql,args)=>sql.startsWith('SELECT * FROM generations')&&sql.includes("status IN ('submitted','processing')")
  ? [[{...f.job,id:'old-held',provider_operation:'{"stage":"review_required"}',provider_job_id:null},f.job]]:original(sql,args);
 await f.q.runOnce(f.db);assert.equal(f.stats().polls,1);assert.equal(f.stats().submissions,0);assert.equal(f.stats().refunds,0);
});
test('pending and held videos do not block new queued work; source capacity remains bounded',async()=>{
 for(const count of [0,1,3]){
  const f=fixture(),originalQuery=f.db.query,originalExecute=f.db.execute;
  const rows=Array.from({length:count},(_,i)=>({...f.job,id:'active-'+i,status:'submitted',provider_job_id:providerJobId,provider_operation:'{"stage":"accepted"}'}));
  rows.unshift({...f.job,id:'held',status:'submitted',provider_job_id:null,provider_operation:'{"stage":"review_required"}'});
  f.db.query=async(sql,args)=>sql.startsWith('SELECT * FROM generations')&&sql.includes("status IN ('submitted','processing')")?[[...rows]]:originalQuery(sql,args);
  f.db.execute=async(sql,args)=>sql.includes("SET status='processing'")&&args[0]!==f.job.id?[{affectedRows:1}]:originalExecute(sql,args);
  await f.q.runOnce(f.db);
  assert.equal(f.stats().polls,count?1:0);assert.equal(f.stats().submissions,count<3?1:0);assert.equal(f.stats().refunds,0);
 }
});

test('collection errors back off and pause instead of creating unlimited browser attempts',async()=>{
 const f=fixture({status:'submitted',op:{stage:'accepted',providerJobId}}),original=f.db.execute;let attempts=0;
 f.q.clientFactory=()=>({collectVideo:async()=>{attempts++;throw new Error('Blocked transfer');}});
 f.db.execute=async(sql,args)=>{if(sql.includes('SET provider_operation=?,error_message='))f.job.provider_operation=args[0];return original(sql,args)};
 for(let i=1;i<=3;i++){
  await f.q.runOnce(f.db);assert.equal(attempts,i);
  const op=JSON.parse(f.job.provider_operation);assert.equal(op.collectionFailures,i);assert.equal(op.collectionPaused,i===3);
  await f.q.runOnce(f.db);assert.equal(attempts,i,'delay/paused job must not be retried immediately');
  if(i<3)f.job.provider_operation=JSON.stringify({...op,collectionNextAt:0});
 }
 assert.equal(f.job.provider_job_id,providerJobId);assert.equal(f.stats().refunds,0);assert.equal(f.stats().submissions,0);
 await reconcileAivid(f.db,f.job.id,{action:'retry_collection'});
 assert.equal(JSON.parse(f.job.provider_operation).collectionPaused,undefined);
});


test('native collection uses generation history for the exact job without visiting its detail page',async()=>{
 const id='6aee348c6467353c0fd7ded1',page={goto:()=>assert.fail('detail page must not be opened')};
 const output={data:Buffer.from('0000ftypisom0000'),mimeType:'video/mp4'};
 for(const result of [{state:'completed',output},{state:'pending'},{state:'failed'}]){
  let calls=0;
  const client=new AividBrowserlessClient({collectFromHistory:async(p,job)=>{
   assert.equal(p,page);assert.equal(job,id);calls++;return result;
  },download:()=>assert.fail('native download must not be used')});
  client.withPage=async fn=>fn(page);
  assert.deepEqual(await client.collectVideo(id),result);
  assert.equal(calls,1);
 }
});

 test('Fast selection stays distinct from standard and Mini',()=>{
 const {selectedModelMatches}=require('../src/provider/aivid.js');
 assert.equal(selectedModelMatches('Seedance 2.0 (Fast) Faster generation with slightly reduced quality.','aivid_seedance_2_0_fast'),true);
 for(const text of ['Seedance 2.0','Seedance 2.0 (Mini)','Seedance 2.5'])assert.equal(selectedModelMatches(text,'aivid_seedance_2_0_fast'),false);
 });

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AividAdminService, publicLogin, LOGIN_KEY, ACTION_KEY } = require('../src/aivid_admin.js');
const { configFrom, validateConfig } = require('../src/aivid_settings.js');
const { createSession } = require('../src/provider/browserless.js');
const { EventEmitter } = require('node:events');

const connectUrl = 'wss://production-sfo.browserless.io/session/test?token=private-session-token';
const liveURL = 'https://production-sfo.browserless.io/live/viewer?i=private-viewer';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ session = false, connectError = false, verifyError = false, outstanding = 0 } = {}) {
  let locked = false, clock = 1000000, created = 0, connected = 0, closed = 0, verified = 0;
  const records = new Map(), secrets = new Map(), pauses = [], calls = [], sessions = [];
  const read = async (key, fallback) => records.get(key) ?? fallback;
  const write = async (key, value, options = {}) => { records.set(key, value); secrets.set(key, options.secret === true); };
  let config = { apiKey: 'saved-private-api-key', endpoint: 'https://production-sfo.browserless.io', ttlDays: 1,
    enabled: false, maxSourceCredits: 0, ...(session ? { connectUrl, session: { connect: connectUrl }, expiresAt: new Date(clock + 86400000).toISOString() } : {}) };
  const db = { execute: async () => [[{ total: outstanding }]], getConnection: async () => ({
    query: async sql => {
      if (sql.includes('GET_LOCK')) { if (locked) return [[{ acquired: 0 }]]; locked = true; return [[{ acquired: 1 }]]; }
      if (sql.includes('RELEASE_LOCK')) locked = false;
      return [[{}]];
    }, release() {},
  }) };
  const options = { db: () => db, read, write, getConfig: async () => config,
    saveConfig: async input => ({ saved: true, ...input }), now: () => clock,
    pause: ms => new Promise(resolve => pauses.push(() => { clock += ms; resolve(); })), loginMs: 10000,
    create: async args => { created++; calls.push(args); const value = { connect: connectUrl, id: 'session-test', ttl: 86400000, expiresAt: new Date(clock + 86400000).toISOString() }; config = { ...config, connectUrl, session: value, expiresAt: value.expiresAt }; return value; },
    connect: async () => {
      connected++; if (connectError) throw new Error(connectUrl);
      const cdp = new EventEmitter();
      sessions.push(cdp);
      cdp.send = async method => method === 'Browserless.liveURL' ? { liveURL, liveURLId: 'viewer-id', timeout: 9000 } : {};
      return { page: { goto: async () => {}, setViewportSize: async () => {}, bringToFront: async () => {} },
        context: { newCDPSession: async () => cdp }, close: async () => { closed++; } };
    },
    verify: async () => { verified++; if (verifyError) throw new Error('Sign In still visible'); },
    openLogin: async page => { await page.goto('https://aivid.dev/'); return true; },
  };
  const service = new AividAdminService(options);
  return { service, options, records, secrets, calls, read, write, sessions,
    async step() { await flush(); pauses.shift()?.(); await flush(); },
    advance(ms) { clock += ms; }, stats: () => ({ created, connected, closed, verified, locked }) };
}

test('dashboard configuration overrides legacy environment credentials and rejects unsafe fields', () => {
  const saved = { apiKey: 'dashboard-api-key', endpoint: 'https://production-lon.browserless.io', ttlDays: 7, enabled: false, maxSourceCredits: 0 };
  const config = configFrom({ AIVID_ENABLED: 'true', AIVID_MAX_SOURCE_CREDITS: '99', AIVID_BROWSERLESS_CONNECT_URL: connectUrl, BROWSERLESS_API_TOKEN: 'old-key' }, {}, saved);
  assert.equal(config.connectUrl, ''); assert.equal(config.apiKey, 'dashboard-api-key'); assert.equal(config.enabled, false);
  assert.equal(validateConfig({ apiKey: '', ttlDays: 1 }, config).apiKey, 'dashboard-api-key');
  for (const input of [{ endpoint: 'http://127.0.0.1' }, { apiKey: 'bad key' }, { apiKey: connectUrl }, { apiKey: 'token=some-api-key' }, { ttlDays: 1000 }, { enabled: 'true' }])
    assert.throws(() => validateConfig(input, config));
});

test('session creation errors reach Admin and persist through refresh with the lock released', async () => {
  for (const [status, body, expected] of [[401, 'Invalid API key', /HTTP 401/],
    [400, 'ttl exceeds maximum', /Select 1 day/], [429, 'Too many requests', /HTTP 429/]]) {
    const f = fixture();
    f.service.create = args => createSession({ ...args, fetchImpl: async () =>
      new Response(body + ' ' + connectUrl, { status }) });
    await assert.rejects(f.service.startLogin(), expected);
    await Promise.all([...f.service.tasks]);
    const state = await f.service.status();
    assert.equal(state.login.state, 'failed'); assert.match(state.login.message, expected);
    assert.equal(f.stats().locked, false); assert.equal(f.stats().connected, 0);
    assert.equal(f.records.has('aivid_browserless_session'), false);
    assert.doesNotMatch(JSON.stringify(state), /private-session-token|saved-private-api-key|wss:/);
  }
});

test('unknown infrastructure failures identify the failing stage and scrub all raw details', async () => {
  for (const stage of ['getConfig', 'assertReplaceable', 'create', 'writeLogin']) {
    const f = fixture();
    f.service[stage] = async () => { throw new Error(connectUrl); };
    await assert.rejects(f.service.startLogin(), error => {
      assert.equal(error.statusCode, 502); assert.doesNotMatch(error.stack, /private-session-token|wss:/);
      assert.match(error.message, stage === 'getConfig' ? /encrypted Browserless settings/ : stage === 'create' ? /create the persistent session/ : /database/);
      return true;
    });
    await Promise.all([...f.service.tasks]); assert.equal(f.stats().locked, false);
  }
});

test('login session is encrypted before opening and the cloud link is limited to login responses', async () => {
  const f = fixture();
  const login = await f.service.startLogin();
  assert.equal(login.state, 'waiting'); assert.equal(login.liveURL, liveURL);
  assert.equal(f.secrets.get('aivid_browserless_session'), true); assert.equal(f.secrets.get(LOGIN_KEY), true);
  const status = await f.service.status();
  assert.equal(JSON.stringify(status).includes('private-'), false);
  assert.equal(status.login.liveURL, undefined);
  await assert.rejects(f.service.startLogin(), /busy/);
  await f.service.requestAction(login.id, 'cancel'); await f.step();
  await Promise.all([...f.service.tasks]);
  assert.equal((await f.service.loginStatus(login.id)).state, 'cancelled');
  assert.equal(f.stats().locked, false);
});

test('another web process can finish login and verification proves persistence after reconnect', async () => {
  const f = fixture();
  const login = await f.service.startLogin();
  const otherProcess = new AividAdminService(f.options);
  assert.equal((await otherProcess.loginStatus(login.id)).liveURL, liveURL);
  await otherProcess.requestAction(login.id, 'finish'); await f.step();
  await Promise.all([...f.service.tasks]);
  const done = await otherProcess.loginStatus(login.id);
  assert.equal(done.state, 'connected'); assert.equal(done.liveURL, undefined); assert.ok(done.verifiedAt);
  assert.deepEqual(f.stats(), { created: 1, connected: 2, closed: 2, verified: 2, locked: false });
});

test('failed Google sign-in remains open for correction rather than claiming connected', async () => {
  const f = fixture({ verifyError: true });
  const login = await f.service.startLogin();
  await f.service.requestAction(login.id, 'finish'); await f.step();
  assert.equal((await f.service.loginStatus(login.id)).state, 'waiting');
  assert.equal(f.stats().verified, 1);
  await f.service.requestAction(login.id, 'cancel'); await f.step(); await f.step();
  await Promise.all([...f.service.tasks]);
  assert.equal((await f.service.loginStatus(login.id)).state, 'cancelled');
});

test('existing session is reused and its replacement is blocked while generations are outstanding', async () => {
  const f = fixture({ session: true, outstanding: 1 });
  await assert.rejects(f.service.startLogin({ replaceSession: true }), /outstanding/);
  assert.equal(f.stats().created, 0);
  const login = await f.service.startLogin(); assert.equal(f.stats().created, 0);
  await f.service.requestAction(login.id, 'cancel'); await f.step(); await Promise.all([...f.service.tasks]);
});

test('expiry and server shutdown close the browser and release the shared lock', async () => {
  for (const stopping of [false, true]) {
    const f = fixture(); const login = await f.service.startLogin();
    if (stopping) await f.service.stop(); else f.advance(10000);
    await f.step(); await Promise.all([...f.service.tasks]);
    assert.equal((await f.service.loginStatus(login.id)).state, stopping ? 'cancelled' : 'expired');
    assert.equal(f.stats().locked, false); assert.ok(f.stats().closed >= 1);
  }
});

test('viewer timeout or disconnect clears the live link promptly without claiming sign-in', async () => {
  for (const reason of ['timeout', 'viewerDisconnected', 'closed']) {
    const f = fixture(); const login = await f.service.startLogin();
    // Another viewer cannot end this attempt, and raw feedback is never saved.
    f.sessions[0].emit('Browserless.liveComplete', { liveURLId: 'other', reason: 'closed' });
    await f.step(); assert.equal((await f.service.loginStatus(login.id)).state, 'waiting');
    f.sessions[0].emit('Browserless.liveComplete', { liveURLId: 'viewer-id', reason,
      feedback: { message: connectUrl } });
    await f.step(); await Promise.all([...f.service.tasks]);
    const status = await f.service.loginStatus(login.id);
    assert.equal(status.state, reason === 'timeout' ? 'expired' : 'cancelled');
    assert.equal(status.liveURL, undefined); assert.equal(status.verifiedAt, null);
    assert.equal(f.stats().verified, 0); assert.equal(f.stats().locked, false);
    assert.equal(f.sessions[0].listenerCount('Browserless.liveComplete'), 0);
    assert.doesNotMatch(JSON.stringify(await f.service.status()), /private-session-token|wss:/);
  }
});

test('connection errors cannot leak tokens and wrong-attempt actions are refused', async () => {
  const f = fixture({ connectError: true });
  await assert.rejects(f.service.startLogin(), error => !error.message.includes('private-session-token'));
  await Promise.all([...f.service.tasks]); assert.equal(f.stats().locked, false);
  await assert.rejects(f.service.requestAction('other-id', 'finish'), /not found/);
  assert.equal(f.records.has(ACTION_KEY), false);
  const expired = publicLogin({ id: 'test', state: 'waiting', expiresAt: new Date(0).toISOString(), liveURL }, { includeLink: true });
  assert.equal(expired.state, 'expired'); assert.equal(expired.liveURL, undefined);
});


test('AIVID source USD pricing overrides the legacy persisted 480 rate',()=>{
  const {AIVID_USD_PER_CREDIT,AIVID_CUSTOMER_CREDITS_PER_SOURCE_CREDIT,aividBaseCredits,aividSourceUsd}=require('../src/aivid_pricing.js');
  const {usdToCredits,applyPriceRate,priceRate}=require('../src/billing.js');
  assert.equal(AIVID_USD_PER_CREDIT,0.12);
  assert.equal(AIVID_CUSTOMER_CREDITS_PER_SOURCE_CREDIT,usdToCredits(0.12));
  assert.equal(AIVID_CUSTOMER_CREDITS_PER_SOURCE_CREDIT,806.4);
  for(const [source,base,charged,usd] of [[1,806.4,846.72,0.12],[2,1612.8,1693.44,0.24],[3,2419.2,2540.16,0.36],[5,4032,4233.6,0.60],[10,8064,8467.2,1.2]]){
    assert.equal(aividBaseCredits(source),base);
    assert.equal(aividSourceUsd(source),usd);
    assert.equal(applyPriceRate(base,priceRate(null)),charged);
  }
  const saved={mode:'rdp',apiKey:'',enabled:true,maxSourceCredits:10,customerCreditsPerSourceCredit:480};
  const current=configFrom({}, {}, saved);
  assert.equal(current.customerCreditsPerSourceCredit,806.4);
  assert.equal(validateConfig({customerCreditsPerSourceCredit:1},current).customerCreditsPerSourceCredit,undefined);
  assert.equal(require('../src/aivid_settings.js').publicConfig({...current,rdpDevice:{}}).customerCreditsPerSourceCredit,806.4);
});

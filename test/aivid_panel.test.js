'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AividAdminService, publicLogin, LOGIN_KEY, ACTION_KEY } = require('../src/aivid_admin.js');
const { configFrom, validateConfig } = require('../src/aivid_settings.js');
const { EventEmitter } = require('node:events');

const connectUrl = 'wss://production-sfo.browserless.io/session/test?token=private-session-token';
const liveURL = 'https://production-sfo.browserless.io/live/viewer?i=private-viewer';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ session = false, connectError = false, verifyError = false, outstanding = 0 } = {}) {
  let locked = false, clock = 1000000, created = 0, connected = 0, closed = 0, verified = 0;
  const records = new Map(), secrets = new Map(), pauses = [], calls = [];
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
      cdp.send = async method => method === 'Browserless.liveURL' ? { liveURL, liveURLId: 'viewer-id', timeout: 9000 } : {};
      return { page: { goto: async () => {} }, context: { newCDPSession: async () => cdp }, close: async () => { closed++; } };
    },
    verify: async () => { verified++; if (verifyError) throw new Error('Sign In still visible'); },
  };
  const service = new AividAdminService(options);
  return { service, options, records, secrets, calls, read, write,
    async step() { await flush(); pauses.shift()?.(); await flush(); },
    advance(ms) { clock += ms; }, stats: () => ({ created, connected, closed, verified, locked }) };
}

test('dashboard configuration overrides legacy environment credentials and rejects unsafe fields', () => {
  const saved = { apiKey: 'dashboard-api-key', endpoint: 'https://production-lon.browserless.io', ttlDays: 7, enabled: false, maxSourceCredits: 0 };
  const config = configFrom({ AIVID_ENABLED: 'true', AIVID_MAX_SOURCE_CREDITS: '99', AIVID_BROWSERLESS_CONNECT_URL: connectUrl, BROWSERLESS_API_TOKEN: 'old-key' }, {}, saved);
  assert.equal(config.connectUrl, ''); assert.equal(config.apiKey, 'dashboard-api-key'); assert.equal(config.enabled, false);
  assert.equal(validateConfig({ apiKey: '', ttlDays: 1 }, config).apiKey, 'dashboard-api-key');
  for (const input of [{ endpoint: 'http://127.0.0.1' }, { apiKey: 'bad key' }, { ttlDays: 1000 }, { enabled: 'true' }])
    assert.throws(() => validateConfig(input, config));
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

test('connection errors cannot leak tokens and wrong-attempt actions are refused', async () => {
  const f = fixture({ connectError: true });
  await assert.rejects(f.service.startLogin(), error => !error.message.includes('private-session-token'));
  await Promise.all([...f.service.tasks]); assert.equal(f.stats().locked, false);
  await assert.rejects(f.service.requestAction('other-id', 'finish'), /not found/);
  assert.equal(f.records.has(ACTION_KEY), false);
  const expired = publicLogin({ id: 'test', state: 'waiting', expiresAt: new Date(0).toISOString(), liveURL }, { includeLink: true });
  assert.equal(expired.state, 'expired'); assert.equal(expired.liveURL, undefined);
});

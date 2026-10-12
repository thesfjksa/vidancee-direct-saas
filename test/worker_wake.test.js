const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

test('the video list wakes the worker while a video job is running', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false';
  process.env.WORKER_WAKE_URL = 'https://worker.example.com/live';
  const user = { id: 3, email: 'w@example.com', credits: 100, status: 'active', role: 'user' };
  const execute = async sql => {
    if (/^(INSERT INTO|DELETE FROM) runtime_boots/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  };
  const db = { execute, query: execute, async getConnection() { return { execute, query: execute, release() {} }; } };
  Object.assign(require('../src/db.js'), { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const auth = require('../src/auth.js');
  auth.requireUser = async () => user; auth.userFromRequest = async () => user;
  let list = [];
  require('../src/generations.js').listUserGenerations = async () => list;
  let wakes = 0;
  const wakeModule = require('../src/worker_wakeup.js'), Original = wakeModule.WorkerWakeup;
  wakeModule.WorkerWakeup = class extends Original {
    constructor(options) { super({ ...options, fetchImpl: async () => { wakes++; return Response.json({ ok: true }); } }); }
  };
  const server = require('../server.js');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); wakeModule.WorkerWakeup = Original; delete process.env.WORKER_WAKE_URL; });
  if (!server.listening) await once(server, 'listening');
  const get = async () => { const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/generations'); assert.equal(r.status, 200); await r.json(); await new Promise(r => setImmediate(r)); };

  list = [{ id: 'v1', status: 'completed' }];
  await get();
  assert.equal(wakes, 0);
  list = [{ id: 'v2', status: 'processing' }, { id: 'v1', status: 'completed' }];
  await get();
  assert.equal(wakes, 1);
});

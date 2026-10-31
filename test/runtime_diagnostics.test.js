const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { RuntimeDiagnostics, recordBoot, listBoots, routeLabel, STALL_MS, SLOW_REQUEST_MS } = require('../src/runtime_diagnostics.js');

test('diagnostics record event-loop stalls and slow requests without leaking ids', () => {
  let now = Date.parse('2026-10-12T06:00:00Z');
  const diag = new RuntimeDiagnostics({ now: () => now });
  diag.recordLag(40);
  assert.deepEqual(diag.summary(), { startedAt: '2026-10-12T06:00:00.000Z', eventLoopLagMs: 40, worstEventLoopLagMs: 40, stalls: 0 });
  now += 60000;
  diag.recordLag(STALL_MS + 2500);
  diag.recordLag(15);
  const d = diag.details();
  assert.equal(d.eventLoopLagMs, 15);
  assert.equal(d.worstEventLoopLagMs, STALL_MS + 2500);
  assert.equal(d.worstEventLoopLagAt, '2026-10-12T06:01:00.000Z');
  assert.deepEqual(d.recentStalls, [{ at: '2026-10-12T06:01:00.000Z', ms: STALL_MS + 2500 }]);

  diag.recordRequest('GET', '/api/config', 120, 200);
  diag.recordRequest('POST', '/api/image-generations/0f8fad5b-d9cb-469f-a165-70867728950e/delete?x=1', SLOW_REQUEST_MS + 1, 200);
  diag.recordRequest('POST', '/admin/users/42/providers', 20, 502);
  const after = diag.details();
  assert.equal(after.requests, 3);
  assert.equal(after.serverErrors, 1);
  assert.deepEqual(after.slowRequests.map(r => r.route), ['POST /api/image-generations/:id/delete']);
  assert.equal(routeLabel('PUT', '/admin/users/42/providers'), 'PUT /admin/users/:n/providers');
  // The live sampler runs on an unref'd timer and can be stopped cleanly.
  const live = new RuntimeDiagnostics({ sampleMs: 10 }).start();
  live.sample(); live.stop();
});

test('boot history is written, trimmed per service and listed newest first', async () => {
  const calls = [];
  const db = {
    async execute(sql, args) { calls.push([sql.replace(/\s+/g, ' ').trim(), args]); return [{ affectedRows: 1 }]; },
    async query(sql, args) {
      calls.push([sql, args]);
      return [[{ service: 'web', pid: 77, node_version: 'v20.19.4', started_at: new Date('2026-10-11T17:11:52Z') }]];
    },
  };
  await recordBoot(db, 'web');
  assert.match(calls[0][0], /^INSERT INTO runtime_boots/);
  assert.equal(calls[0][1][0], 'web');
  assert.match(calls[1][0], /^DELETE FROM runtime_boots WHERE service=\? AND id < \(/);
  assert.deepEqual(calls[1][1], ['web', 'web']);
  assert.deepEqual(await listBoots(db, 500), [{ service: 'web', pid: 77, node: 'v20.19.4', startedAt: '2026-10-11T17:11:52.000Z' }]);
  assert.deepEqual(calls[2][1], [100]);
});

test('browser actions use POST routes that the hosting firewall accepts', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'test-admin-only';
  const users = new Map([[1, { id: 1, email: 'test1@example.com', credits: 50, status: 'active', plan_code: 'pro', role: 'user' }]]);
  // Voice off, as saving Sources stored it while Voice Studio was opt-in.
  const access = new Map([[1, new Map([['vibi', 0]])]]); const updates = []; const settingsSaved = [];
  async function execute(sql, args = []) {
    if (sql.startsWith('CREATE')) return [[], []];
    if (sql.startsWith('INSERT IGNORE INTO app_settings')) return [{affectedRows:0}];
    if (sql.startsWith('SELECT setting_value FROM app_settings')) return [[{setting_value:'done'}]];
    if (sql.startsWith('INSERT INTO app_settings')) { settingsSaved.push(args[0]); return [{ affectedRows: 1 }]; }
    if (sql === "DELETE FROM user_provider_access WHERE provider='vibi' AND enabled=0") {
      let n = 0; for (const m of access.values()) if (m.get('vibi') === 0) { m.delete('vibi'); n++; }
      return [{ affectedRows: n }];
    }
    if (sql.includes('SELECT setting_key')) return [[]];
    if (sql.startsWith('SELECT provider,enabled')) return [[...(access.get(args[0]) || new Map()).entries()].map(([provider, enabled]) => ({ provider, enabled }))];
    if (sql.includes('INSERT INTO user_provider_access')) {
      if (!access.has(args[0])) access.set(args[0], new Map());
      access.get(args[0]).set(args[1], args[2]); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE users SET status=?')) { users.get(args[1]).status = args[0]; updates.push(args); return [{ affectedRows: 1 }]; }
    if (sql.includes('FROM users WHERE id=')) return [[users.get(Number(args[0]))].filter(Boolean)];
    if (/^(INSERT INTO|DELETE FROM) runtime_boots/.test(sql.trim())) return [{ affectedRows: 1 }];
    if (sql.includes('FROM runtime_boots')) return [[{ service: 'web', pid: 1, node_version: 'v20', started_at: new Date('2026-10-12T00:00:00Z') }]];
    throw new Error('Unexpected test SQL: ' + sql);
  }
  const db = { execute, query: execute, getConnection: async()=>({execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){}}) };
  const dbModule = require('../src/db.js'); const originalDb = { ...dbModule };
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const auth = require('../src/auth.js'); const originalAuth = { ...auth };
  auth.requireUser = async () => users.get(1); auth.userFromRequest = async () => users.get(1);
  const deleted = [];
  const modules = ['generations', 'image_generations', 'voice_generations'].map(name => require('../src/' + name + '.js'));
  const originals = modules.map(m => ({ ...m }));
  modules[0].deleteUserGeneration = async (userId, id) => { deleted.push(['video', userId, id]); };
  modules[1].deleteUserImageGeneration = async (userId, id) => { deleted.push(['image', userId, id]); };
  modules[2].deleteUserVoiceGeneration = async (userId, id) => { deleted.push(['voice', userId, id]); };
  const server = require('../server.js');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    Object.assign(dbModule, originalDb); Object.assign(auth, originalAuth);
    modules.forEach((m, i) => Object.assign(m, originals[i]));
  });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, body, admin = false) => {
    const r = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-token': 'test-admin-only' } : {}) }, body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json() };
  };

  // Startup turns Voice back on once for customers who had it off under the old default.
  for (let i = 0; i < 100 && !settingsSaved.includes('voice_access_default_on_at'); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(settingsSaved.includes('voice_access_default_on_at'));
  const saved = await post('/admin/users/1/providers', { providers: { vercel: false } }, true);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.provider_access.vercel, false);
  assert.equal(saved.data.provider_access.api888, true);
  const optedOut=await post('/admin/users/1/providers',{providers:{api888:false}},true);
  assert.equal(optedOut.status,200);
  assert.equal(optedOut.data.provider_access.api888,false);
  assert.equal((await post('/admin/users/1/providers',{providers:{api888:true}})).status,401);
  assert.equal(saved.data.provider_access.vibi, true);
  assert.equal(saved.data.provider_access.argolink, true);
  assert.equal((await post('/admin/users/1/providers', { providers: { vercel: true } })).status, 401);

  const status = await post('/admin/users/1', { status: 'disabled' }, true);
  assert.equal(status.status, 200);
  assert.equal(status.data.user.status, 'disabled');
  assert.deepEqual(updates, [['disabled', 1]]);
  users.get(1).status = 'active';

  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (const kind of ['generations', 'image-generations', 'voice-generations']) {
    const r = await post('/api/' + kind + '/' + id + '/delete');
    assert.equal(r.status, 200); assert.equal(r.data.deleted, true); assert.equal(r.data.id, id);
  }
  assert.deepEqual(deleted, [['video', 1, id], ['image', 1, id], ['voice', 1, id]]);
  // The old DELETE method keeps working for clients that have not reloaded.
  const legacy = await fetch(origin + '/api/image-generations/' + id, { method: 'DELETE' });
  assert.equal(legacy.status, 200);

  // The admin console arrives with its stylesheets inline and the small logo.
  const adminHtml = await (await fetch(origin + '/admin-console')).text();
  assert.equal(/<link rel="stylesheet"/.test(adminHtml), false);
  assert.match(adminHtml, /<style>[\s\S]*\.brand-logo/);
  assert.match(adminHtml, /src="\/assets\/cmmtools-logo-sm\.png"/);
  const logo = await fetch(origin + '/assets/cmmtools-logo-sm.png');
  assert.equal(logo.status, 200);
  assert.ok((await logo.arrayBuffer()).byteLength < 20000);

  const health = await (await fetch(origin + '/health')).json();
  const live = await (await fetch(origin + '/live')).json();
  assert.deepEqual(live.release, health.release);
  assert.ok(['git', 'environment', 'unavailable'].includes(live.release.source));
  assert.ok(live.release.commit === null || /^[a-f0-9]{40}$/.test(live.release.commit));
  assert.ok(health.runtime.startedAt);
  assert.equal(typeof health.runtime.worstEventLoopLagMs, 'number');
  const diag = await (await fetch(origin + '/admin/diagnostics', { headers: { 'x-admin-token': 'test-admin-only' } })).json();
  assert.equal(diag.ok, true);
  assert.ok(diag.web.requests >= 6);
  assert.equal(diag.boots[0].service, 'web');
  assert.equal((await fetch(origin + '/admin/diagnostics')).status, 401);
});



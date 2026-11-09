'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
test('RDP schema, atomic claims, reservation and binary chunks work in real MySQL', { skip: process.env.RDP_MYSQL_TEST !== '1', timeout: 120000 }, async t => {
  assert.equal(process.env.DB_NAME, 'cmm_rdp_ci'); // This test never operates on a production database.
  const { getPool, initDb } = require('../src/db.js');
  const { saveAividSettings } = require('../src/aivid_settings.js');
  const { RdpStore, AividRdpService, ensureRdpTables, hash } = require('../src/aivid_rdp.js');
  const db = getPool(); t.after(() => db.end());
  await initDb(); await ensureRdpTables(db); await saveAividSettings({ mode: 'rdp' });
  const { withAividLock } = require('../src/aivid_queue.js');
  const lockDb = {getConnection:async()=>{
    const conn=await db.getConnection();
    try { await conn.query('SET SESSION wait_timeout=1'); }
    catch(error) { conn.release();throw error; }
    return conn;
  }};
  assert.equal(await withAividLock(lockDb,async()=>{
    await new Promise(resolve=>setTimeout(resolve,1800));
    assert.equal(await withAividLock(db,async()=>true),null);
    return true;
  },{keepaliveMs:100}),true);
  assert.equal(await withAividLock(db,async()=>true),true);
  const store = new RdpStore(db), service = new AividRdpService({ store });
  const code = await service.createPairing(), paired = await service.pair(code.code);
  const device = await service.authorize('Bearer ' + paired.token);
  const id = crypto.randomUUID();
  await store.insert({ id, deviceId: paired.deviceId, generationId: null, kind: 'collect', payload: { providerJobId: '6aec589f09c74e1c2ef12900' }, expiresAt: Date.now() + 60000 });
  const claims = await Promise.all([service.poll(device, 'ready', 'edge'), service.poll(device, 'ready', 'edge')]);
  assert.equal(claims.filter(r => r.command).length, 1);
  const data = Buffer.alloc(1024 * 1024 + 16); data.write('ftyp', 4, 'ascii');
  await store.chunk(id, 0, data.subarray(0, 1024 * 1024));
  await store.chunk(id, 0, data.subarray(0, 1024 * 1024)); // Idempotent upload retry.
  await assert.rejects(store.chunk(id, 0, Buffer.from('changed bytes')), /Conflicting/);
  await store.chunk(id, 1, data.subarray(1024 * 1024));
  await service.result(device, id, { state: 'completed', size: data.length, chunks: 2, sha256: hash(data) });
  assert.equal((await store.get(id)).state, 'done');
  assert.deepEqual((await store.output(id, { size: data.length, chunks: 2, sha256: hash(data) })).data, data);
  await store.remove(id);
  const [[chunks]] = await db.query('SELECT COUNT(*) AS total FROM aivid_rdp_chunks WHERE command_id=?', [id]); assert.equal(Number(chunks.total), 0);
  const submit = crypto.randomUUID();
  await store.insert({ id: submit, deviceId: paired.deviceId, generationId: null, kind: 'submit', payload: {}, expiresAt: Date.now() + 60000 });
  await service.poll(device, 'ready', 'edge'); await service.reserve(device, submit, 2);
  assert.equal((await store.get(submit)).state, 'review');
  await store.move(submit, 'review', 'reserved', { price: 2 });
  await service.result(device, submit, { state: 'accepted', providerJobId: '6aec589f09c74e1c2ef12900' });
  assert.equal((await store.get(submit)).response.providerJobId, '6aec589f09c74e1c2ef12900');
  await assert.rejects(service.pair(code.code), /Invalid or expired/);
});

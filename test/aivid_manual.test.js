'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { copyRequest, readPacket, readMp4, deliverVideo, signPacket, verifyPacket } = require('../src/aivid_manual.js');
const { serializeGeneration } = require('../src/generations.js');

const id = '5e048d5d-a5e2-4ca6-9e69-edeb20b8089d';
const secret = 'admin-fixture-key';
const file = { mime_type: 'image/png', media_data: Buffer.from('image fixture') };
const ref = { position_index: 1, media_kind: 'image', mime_type: file.mime_type };

function fixture(stage = 'manual_pending') {
  const job = { id, user_id: 42, provider: 'aivid', media_type: 'video', status: 'processing',
    provider_operation: JSON.stringify({ stage }), model: 'aivid_seedance_2_0_mini', prompt: 'A blue river',
    duration: 5, resolution: '480p', aspect_ratio: '16:9', provider_cost: '2.5' };
  const conn = {
    async query() { return [[{ acquired: 1 }]]; },
    async execute(sql, args) {
      if (sql.startsWith('SELECT * FROM generations')) return [[args[0] === id ? job : null]];
      if (sql.startsWith('SELECT position_index')) return [[ref]];
      if (sql.startsWith('SELECT mime_type')) return [[args[0] === id && args[1] === 1 ? file : null]];
      if (sql.startsWith('UPDATE generations SET provider_operation')) job.provider_operation = args[0];
      else if (sql.startsWith("UPDATE generations SET status='completed'")) {
        job.status = 'completed';
        [job.output_url, job.provider_operation] = args;
      } else assert.fail(sql);
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  };
  return { job, db: { getConnection: async () => conn, execute: conn.execute } };
}

test('copy releases only the intended manual job and revokes old packets after recopy', async () => {
  const { db, job } = fixture();
  assert.equal(serializeGeneration(job).awaiting_delivery, true);
  await assert.rejects(readPacket(db, secret, 'Bearer ' + secret), { statusCode: 403 });
  const first = await copyRequest(db, secret, id);
  const authorization = 'Bearer ' + first.clipboard.split(' ')[1];
  const packet = await readPacket(db, secret, authorization);
  assert.deepEqual(packet, { id, model: job.model, prompt: job.prompt, duration: 5, resolution: '480p',
    aspectRatio: '16:9', sourceCredits: 2.5, references: [{ position: 1, kind: 'image', mimeType: 'image/png' }] });
  assert.deepEqual(await readPacket(db, secret, authorization, 1), file);
  await assert.rejects(readPacket(db, secret, authorization, 2), { statusCode: 404 });
  await copyRequest(db, secret, id);
  await assert.rejects(readPacket(db, secret, authorization), { statusCode: 403 });
  const regular = fixture('accepted');
  await assert.rejects(copyRequest(regular.db, secret, id), { statusCode: 409 });
});

test('the packet signature covers expiry, job and nonce', () => {
  const now = 1794132900000;
  const nonce = 'b'.repeat(32);
  const token = signPacket(secret, id, nonce, now);
  assert.deepEqual(verifyPacket(secret, token, now), { id, nonce });
  assert.equal(verifyPacket(secret, token, now + 900000), null);
  assert.equal(verifyPacket(secret, token.replace(id, 'a' + id.slice(1)), now), null);
  assert.equal(verifyPacket(secret, token.replace(nonce, 'a'.repeat(32)), now), null);
  assert.equal(verifyPacket('another key', token, now), null);
});

test('an upload completes the original job once and invalidates its clipboard packet', async () => {
  const { db, job } = fixture();
  const mp4 = Buffer.from('0000000866747970000000086d6f6f76000000086d646174', 'hex');
  const request = data => Object.assign(Readable.from([data]), { headers: { 'content-type': 'video/mp4' } });
  assert.deepEqual(await readMp4(request(mp4)), mp4);
  await assert.rejects(readMp4(request(mp4.subarray(0, -1))), { statusCode: 400 });
  let saves = 0;
  const save = async (conn, jobId, output) => {
    assert.equal(jobId, id);
    assert.deepEqual(output, { mimeType: 'video/mp4', data: mp4 });
    saves++;
    return 'db:video';
  };
  await assert.rejects(deliverVideo(db, id, mp4, save), { statusCode: 409 });
  const { clipboard } = await copyRequest(db, secret, id);
  await assert.rejects(deliverVideo(db, id, mp4, async () => { throw new Error('storage unavailable'); }), /storage unavailable/);
  assert.equal(job.status, 'processing');
  assert.deepEqual(await deliverVideo(db, id, mp4, save), { completed: true });
  assert.deepEqual(await deliverVideo(db, id, mp4, save), { completed: true });
  assert.equal(saves, 1);
  assert.equal(job.user_id, 42);
  assert.equal(serializeGeneration(job).video_url, '/api/generations/' + id + '/media?type=video');
  await assert.rejects(readPacket(db, secret, 'Bearer ' + clipboard.split(' ')[1]), { statusCode: 403 });
});

'use strict';

const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { getSettingValue, setSettingValue } = require('./settings.js');
const { ID, validateJob, DIAGNOSTICS, diagnosticMessage } = require('./provider/aivid.js');
const DEVICE_KEY = 'aivid_rdp_device', HEARTBEAT_KEY = 'aivid_rdp_heartbeat', PAIR_KEY = 'aivid_rdp_pairing';
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const CHUNK = 1024 * 1024, MAX_OUTPUT = 100 * CHUNK;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, aividSafe: true });
const hash = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
const matches = (a, b) => /^[a-f0-9]{64}$/.test(a || '') && /^[a-f0-9]{64}$/.test(b || '') && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS aivid_rdp_commands (
    id CHAR(36) NOT NULL PRIMARY KEY, device_id CHAR(36) NOT NULL, generation_id CHAR(36) NULL,
    kind VARCHAR(20) NOT NULL, state VARCHAR(20) NOT NULL, request_json LONGTEXT NOT NULL,
    response_json LONGTEXT NULL, expires_at DATETIME(3) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_aivid_rdp_device (device_id,state,expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS aivid_rdp_chunks (
    command_id CHAR(36) NOT NULL, position_index INT NOT NULL, media_data MEDIUMBLOB NOT NULL,
    PRIMARY KEY(command_id,position_index),
    CONSTRAINT fk_aivid_rdp_chunk FOREIGN KEY(command_id) REFERENCES aivid_rdp_commands(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
const ready = new WeakSet();
async function ensureRdpTables(db) {
  if (ready.has(db)) return;
  try {
    await db.query('SELECT id FROM aivid_rdp_commands LIMIT 0');
    await db.query('SELECT command_id FROM aivid_rdp_chunks LIMIT 0');
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    try { for (const statement of SCHEMA) await db.query(statement); }
    catch { throw failure('Create the two RDP tables from docs/AIVID_RDP.sql in the CMMTools database, then retry pairing.', 503); }
  }
  ready.add(db);
}

class RdpStore {
  constructor(db = getPool()) { this.db = db; }
  async insert(command) {
    await ensureRdpTables(this.db);
    await this.db.execute('DELETE FROM aivid_rdp_commands WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)');
    await this.db.execute('INSERT INTO aivid_rdp_commands (id,device_id,generation_id,kind,state,request_json,expires_at) VALUES (?,?,?,?,?,?,?)',
      [command.id, command.deviceId, command.generationId, command.kind, 'queued', JSON.stringify(command.payload), new Date(command.expiresAt)]);
  }
  async get(id) {
    const [[row]] = await this.db.execute('SELECT * FROM aivid_rdp_commands WHERE id=?', [id]);
    return row ? { ...row, payload: parse(row.request_json), response: parse(row.response_json), expiresAt: new Date(row.expires_at).getTime() } : null;
  }
  async move(id, from, to, response = null) {
    const [result] = await this.db.execute('UPDATE aivid_rdp_commands SET state=?,response_json=? WHERE id=? AND state=? AND expires_at>UTC_TIMESTAMP(3)',
      [to, response === null ? null : JSON.stringify(response), id, from]);
    return result.affectedRows === 1;
  }
  async cancel(id) { await this.db.execute("UPDATE aivid_rdp_commands SET state='cancelled' WHERE id=? AND state<>'done'", [id]); }
  async claim(deviceId, readOnly) {
    await ensureRdpTables(this.db);
    const [rows] = await this.db.execute("SELECT id FROM aivid_rdp_commands WHERE device_id=? AND state='queued' AND expires_at>UTC_TIMESTAMP(3)" +
      (readOnly ? " AND kind='preflight'" : '') + ' ORDER BY created_at,id LIMIT 1', [deviceId]);
    if (!rows.length || !await this.move(rows[0].id, 'queued', 'running')) return null;
    return this.get(rows[0].id);
  }
  async chunk(id, index, data) {
    // A retry of an identical chunk is idempotent; conflicting bytes fail closed.
    await this.db.execute('INSERT IGNORE INTO aivid_rdp_chunks (command_id,position_index,media_data) VALUES (?,?,?)', [id, index, data]);
    const [[row]] = await this.db.execute('SELECT media_data FROM aivid_rdp_chunks WHERE command_id=? AND position_index=?', [id, index]);
    if (!row || !Buffer.from(row.media_data).equals(data)) throw failure('Conflicting output chunk.', 409);
  }
  async output(id, metadata) {
    const [rows] = await this.db.execute('SELECT position_index,media_data FROM aivid_rdp_chunks WHERE command_id=? ORDER BY position_index', [id]);
    if (rows.length !== metadata.chunks || rows.some((r, i) => r.position_index !== i)) throw failure('Incomplete MP4 upload.', 409);
    const size = rows.reduce((n, r) => n + r.media_data.length, 0);
    if (size !== metadata.size || size > MAX_OUTPUT) throw failure('Invalid MP4 size.', 409);
    const data = Buffer.concat(rows.map(r => r.media_data), size);
    if (data.length < 12 || data.toString('ascii', 4, 8) !== 'ftyp' || hash(data) !== metadata.sha256)
      throw failure('Invalid MP4 upload.', 409);
    return { data, mimeType: 'video/mp4' };
  }
  async remove(id) { await this.db.execute('DELETE FROM aivid_rdp_commands WHERE id=?', [id]); }
}

async function readDevice(read = getSettingValue) {
  const [device, beat] = await Promise.all([read(DEVICE_KEY, ''), read(HEARTBEAT_KEY, '')]);
  const value = parse(device), heartbeat = parse(beat);
  return { ...value, ...(heartbeat.deviceId === value.deviceId ? heartbeat : {}) };
}
function publicDevice(device, now = Date.now()) {
  const age = now - Date.parse(device.seenAt);
  return { paired: Boolean(device.deviceId && device.tokenHash), deviceId: device.deviceId || null,
    online: Number.isFinite(age) && age >= 0 && age < 45000,
    seenAt: device.seenAt || null, status: ['ready', 'needs_login', 'starting', 'busy'].includes(device.status) ? device.status : 'offline' };
}

class AividRdpClient {
  constructor({ rdpDevice, maxSourceCredits = 0, store, now = Date.now, delay = pause } = {}) {
    this.device = rdpDevice; this.maxSourceCredits = maxSourceCredits; this.store = store || new RdpStore(); this.now = now; this.delay = delay;
  }
  async run(kind, payload, { beforeClick, references = [], generationId = null, timeoutMs = 180000 } = {}) {
    if (!this.device?.deviceId || !this.device?.tokenHash) throw failure('Pair the Windows RDP agent in Admin first.', 503);
    const command = { id: crypto.randomUUID(), deviceId: this.device.deviceId, generationId, kind,
      expiresAt: this.now() + timeoutMs, payload: { ...payload, references: references.map((r, index) =>
        ({ index, kind: r.kind, mimeType: r.mimeType, size: r.data.length, sha256: hash(r.data) })) } };
    await this.store.insert(command);
    let reserved = false;
    let commandFinished = false;
    try {
      while (this.now() < command.expiresAt) {
        const current = await this.store.get(command.id);
        if (!current || current.state === 'cancelled') throw failure('The RDP operation was cancelled.', 503);
        if (current.state === 'review') {
          const price = Number(current.response.price);
          if (kind !== 'submit' || reserved || !Number.isFinite(price) || price <= 0 || typeof beforeClick !== 'function')
            throw failure('Invalid RDP submission reservation.', 409);
          await beforeClick({ price });
          reserved = true;
          if (!await this.store.move(command.id, 'review', 'reserved', { price })) throw failure('The RDP reservation expired.', 409);
        }
        if (current.state === 'done') {
          commandFinished = true;
          if (kind === 'submit' && !reserved && current.response.state!=='rejected' && !current.response.error) throw failure('RDP submission had no server reservation.', 409);
          if (current.response.error) throw Object.assign(failure(current.response.errorCode
            ? 'RDP check [' + current.response.errorCode + ']: ' + diagnosticMessage(current.response.errorCode)
            : 'The RDP browser needs attention. Check its agent window and AIVID sign-in.', 503),{aividCode:current.response.errorCode});
          const result = current.response;
          if (kind === 'collect' && result.state === 'completed') result.output = await this.store.output(command.id, result);
          return result;
        }
        await this.delay(750);
      }
      throw failure('The RDP agent did not finish in time. Check that it is running and signed in.', 503);
    } finally {
      if (commandFinished) {
        // Expired rows are pruned on future inserts. A cleanup failure must
        // not discard an already accepted provider ID or a verified output.
        await this.store.remove(command.id).catch(() => {});
      } else {
        // A late agent cannot obtain a reservation after a safe refund.
        await this.store.cancel(command.id);
      }
    }
  }
  preflight(value, references = []) {
    validateJob(value, references);
    if (references.length && !UUID.test(value.jobId || '')) throw failure('A reference preflight requires a CMMTools generation ID.');
    return this.run('preflight', { value }, { references, generationId: references.length ? value.jobId : null, timeoutMs: 90000 });
  }
  checkReferences(value,references=[]){
    validateJob(value,references);
    if(references.length!==3||references.reduce((sum,r)=>sum+r.data.length,0)>128*1024||
      !(references.every(r=>r.kind==='image')||new Set(references.map(r=>r.kind)).size===3))throw failure('Invalid diagnostic media.');
    return this.run('reference_check',{value,probeFiles:references.map(r=>r.data.toString('base64'))},{references,timeoutMs:180000});
  }
  startVideo(value, references = [], hooks = {}) {
    if (!UUID.test(value.jobId || '')) throw failure('RDP jobs require a CMMTools generation ID.');
    validateJob(value, references);
    return this.run('submit', { value, maxSourceCredits: this.maxSourceCredits }, { ...hooks, references, generationId: value.jobId });
  }
  collectVideo(providerJobId) {
    if (!ID.test(providerJobId || '')) throw failure('Invalid AIVID job ID.');
    return this.run('collect', { providerJobId }, { timeoutMs: 300000 });
  }
}

class AividRdpService {
  constructor({ db = getPool, read = getSettingValue, write = setSettingValue, getConfig, store, now = Date.now } = {}) {
    Object.assign(this, { db, read, write, now });
    this.getConfig = getConfig || require('./aivid_settings.js').getAividSettings;
    this.store = store || new RdpStore(db());
  }
  async assertPairingSafe(){
    const [[row]]=await this.db().execute("SELECT COUNT(*) AS total FROM generations WHERE provider='aivid' AND status IN ('submitting','submitted','processing') AND refunded_at IS NULL");
    if(!Number(row?.total||0))return;
    if(publicDevice(await readDevice(this.read),this.now()).online)throw failure('Stop the existing RDP agent before pairing a replacement while videos are outstanding.',409);
    const [[unsafe]]=await this.db().execute("SELECT COUNT(*) AS total FROM generations WHERE provider='aivid' AND status IN ('submitting','submitted','processing') AND refunded_at IS NULL AND (status='submitting' OR provider_job_id IS NULL OR provider_job_id NOT REGEXP '^[a-zA-Z0-9_-]{16,80}$' OR provider_operation LIKE '%review_required%')");
    if(Number(unsafe?.total||0))throw failure('Resolve outstanding AIVID jobs with an uncertain submission before replacing the RDP agent.',409);
    // All remaining jobs have accepted IDs and can only be collected. The
    // browser lock excludes active operations; new credentials revoke the old.
  }
  async createPairing() {
    await ensureRdpTables(this.db());
    await this.assertPairingSafe();
    const code = crypto.randomBytes(12).toString('hex').toUpperCase();
    const expiresAt = new Date(this.now() + 10 * 60000).toISOString();
    await this.write(PAIR_KEY, JSON.stringify({ codeHash: hash(code), expiresAt }), { secret: true });
    return { code, expiresAt };
  }
  async pair(code) {
    const conn = await this.db().getConnection(); let locked = false, browserLocked = false;
    try {
      const [[row]] = await conn.query("SELECT GET_LOCK('cmm_aivid_rdp_pair',2) AS acquired");
      locked = Number(row?.acquired) === 1;
      if (!locked) throw failure('Pairing is busy. Retry shortly.', 409);
      const [[browser]] = await conn.query("SELECT GET_LOCK('cmm_aivid_browser',0) AS acquired");
      browserLocked = Number(browser?.acquired) === 1;
      if (!browserLocked) throw failure('The AIVID browser is busy. Retry pairing after its operation finishes.', 409);
      const config = await this.getConfig();
      if (config.mode !== 'rdp') throw failure('Select RDP in the AIVID Admin panel first.', 409);
      const saved = parse(await this.read(PAIR_KEY, ''));
      if (typeof code !== 'string' || !/^[A-F0-9]{24}$/i.test(code) || !Number.isFinite(Date.parse(saved.expiresAt)) || Date.parse(saved.expiresAt) <= this.now() ||
          !matches(saved.codeHash, hash(code.toUpperCase()))) throw failure('Invalid or expired pairing code.', 401);
      await this.assertPairingSafe();
      const token = crypto.randomBytes(32).toString('hex'), deviceId = crypto.randomUUID();
      await this.write(PAIR_KEY, '', { secret: true });
      await this.write(DEVICE_KEY, JSON.stringify({ deviceId, tokenHash: hash(token), pairedAt: new Date(this.now()).toISOString() }), { secret: true });
      return { deviceId, token };
    } finally {
      if (browserLocked) await conn.query("SELECT RELEASE_LOCK('cmm_aivid_browser')").catch(() => {});
      if (locked) await conn.query("SELECT RELEASE_LOCK('cmm_aivid_rdp_pair')").catch(() => {});
      conn.release();
    }
  }
  async authorize(header) {
    const token = String(header || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) throw failure('RDP agent authentication required.', 401);
    const device = await readDevice(this.read);
    if (!matches(device.tokenHash, hash(token))) throw failure('RDP agent authentication required.', 401);
    if ((await this.getConfig()).mode !== 'rdp') throw failure('RDP mode is not active.', 409);
    return device;
  }
  async poll(device, status) {
    if (!['ready', 'needs_login', 'starting', 'busy'].includes(status)) throw failure('Invalid RDP status.');
    await this.write(HEARTBEAT_KEY, JSON.stringify({ deviceId: device.deviceId, status, seenAt: new Date(this.now()).toISOString() }));
    if (['busy', 'starting'].includes(status)) return { command: null };
    const command = await this.store.claim(device.deviceId, status !== 'ready');
    return { command: command ? { id: command.id, kind: command.kind, payload: command.payload, expiresAt: command.expiresAt } : null };
  }
  async command(device, id) {
    if (!UUID.test(id)) throw failure('Invalid RDP operation.');
    const command = await this.store.get(id);
    if (!command || command.device_id !== device.deviceId || command.expiresAt <= this.now() || !['running', 'review', 'reserved', 'done'].includes(command.state))
      throw failure('The RDP operation has ended.', 409);
    return command;
  }
  async reserve(device, id, price) {
    const command = await this.command(device, id);
    if (command.kind !== 'submit' || !Number.isFinite(price) || price <= 0) throw failure('Invalid RDP reservation.');
    if (command.state === 'review' || command.state === 'reserved') {
      if (command.response.price !== price) throw failure('Reservation price changed.', 409);
      return { state: command.state };
    }
    if (!await this.store.move(id, 'running', 'review', { price })) throw failure('RDP operation changed.', 409);
    return { state: 'review' };
  }
  async result(device, id, input) {
    const command = await this.command(device, id);
    if (command.state === 'done') return { saved: true };
    let result;
    if (input.error === true) result = { error: true,
      ...(Object.hasOwn(DIAGNOSTICS, input.errorCode) ? { errorCode: input.errorCode } : {}) };
    else if(command.kind==='reference_check'){
      const expected=validateJob(command.payload.value);
      const refs=command.payload.references;
      const counts={image:refs.filter(r=>r.kind==='image').length,video:refs.filter(r=>r.kind==='video').length,audio:refs.filter(r=>r.kind==='audio').length};
      if(input.verified!==true||input.generationBlocked!==true||input.submitted!==false||input.ready!==true||
        input.modelId!==expected.modelId||input.duration!==expected.duration||input.resolution!==expected.resolution||input.aspectRatio!==expected.aspectRatio||
        !Number.isFinite(input.price)||input.price<=0||!Number.isFinite(input.balanceBefore)||input.balanceBefore<0||input.balanceAfter!==input.balanceBefore||
        Object.entries(counts).some(([kind,count])=>input.uploadedCounts?.[kind]!==count))throw failure('Invalid reference-check result.');
      result={ready:true,verified:true,submitted:false,generationBlocked:true,modelId:expected.modelId,
        duration:expected.duration,resolution:expected.resolution,aspectRatio:expected.aspectRatio,
        uploadedCounts:counts,price:input.price,balanceBefore:input.balanceBefore,balanceAfter:input.balanceAfter};
    }
    else if (command.kind === 'preflight' && input.ready === true && input.submitted === false &&
      Number.isFinite(input.price) && input.price > 0 && Number.isFinite(input.balance) && input.balance >= 0) {
      result = { ready: true, submitted: false, price: input.price, balance: input.balance };
      // Premium prices must attest the actual prepared model/settings. Older
      // agents that report only Mini's balance/price cannot quote another model.
      const requested=command.payload.value;
      if(requested.model || input.modelId){
        const expected=validateJob(requested);
        const mismatch=input.modelId!==expected.modelId?'form_model':
          input.duration!==expected.duration?'form_duration':
          input.resolution!==expected.resolution?'form_resolution':
          input.aspectRatio!==expected.aspectRatio?'form_aspect_ratio':null;
        result=mismatch?{error:true,errorCode:mismatch}:{...result,modelId:expected.modelId,
          duration:expected.duration,resolution:expected.resolution,aspectRatio:expected.aspectRatio};
      }
    }
    else if (command.kind === 'submit' && ['accepted', 'rejected', 'submission_uncertain'].includes(input.state)) {
      if (command.state !== 'reserved' && !(command.state==='running' && input.state==='rejected')) throw failure('Submission was not reserved.', 409);
      if (input.state === 'accepted' && !ID.test(input.providerJobId || '')) throw failure('Invalid AIVID result.');
      result = { state: input.state, ...(input.state === 'accepted' ? { providerJobId: input.providerJobId } : {}) };
      if(input.state==='rejected'&&Object.hasOwn(DIAGNOSTICS,input.errorCode)){
        result.errorCode=input.errorCode;
        if(input.errorCode==='source_rejected'&&Number.isInteger(input.httpStatus)&&input.httpStatus>=400&&input.httpStatus<500)
          result.httpStatus=input.httpStatus;
      }
    } else if (command.kind === 'collect' && ['pending', 'failed'].includes(input.state)) result = { state: input.state };
    else if (command.kind === 'collect' && input.state === 'completed' && Number.isSafeInteger(input.size) && input.size >= 12 && input.size <= MAX_OUTPUT &&
      Number.isSafeInteger(input.chunks) && input.chunks === Math.ceil(input.size / CHUNK) && /^[a-f0-9]{64}$/.test(input.sha256 || '')) {
      result = { state: 'completed', size: input.size, chunks: input.chunks, sha256: input.sha256 };
      await this.store.output(id, result);
    } else throw failure('Invalid RDP result.');
    if (!await this.store.move(id, command.state, 'done', result)) throw failure('RDP operation changed.', 409);
    return { saved: true };
  }
  async reference(device, id, index) {
    const command = await this.command(device, id);
    const wanted = command.payload.references?.[index];
    if(command.kind==='reference_check'){
      if(command.generation_id||command.payload.references?.length!==3||!wanted||wanted.index!==index||wanted.size>128*1024)throw failure('Reference not found.',404);
      const encoded=command.payload.probeFiles?.[index];
      if(typeof encoded!=='string'||encoded.length>180000)throw failure('Invalid diagnostic media.');
      const data=Buffer.from(encoded,'base64');
      if(data.length!==wanted.size||hash(data)!==wanted.sha256)throw failure('Diagnostic reference changed.',409);
      return {data,mimeType:wanted.mimeType};
    }
    if (!['submit', 'preflight'].includes(command.kind) || !command.generation_id || !wanted || wanted.index !== index) throw failure('Reference not found.', 404);
    const [rows] = await this.db().execute('SELECT media_kind,filename,mime_type,media_data FROM generation_media WHERE generation_id=? ORDER BY position_index', [command.generation_id]);
    await require('./object_storage.js').hydrateBlobs(rows, 'media_data');
    const row = rows[index];
    if (!row || row.media_kind !== wanted.kind || row.mime_type !== wanted.mimeType || row.media_data.length !== wanted.size || hash(row.media_data) !== wanted.sha256) throw failure('Reference changed.', 409);
    return { data: row.media_data, mimeType: row.mime_type };
  }
}

module.exports = { AividRdpClient, AividRdpService, RdpStore, readDevice, publicDevice, ensureRdpTables,
  DEVICE_KEY, HEARTBEAT_KEY, PAIR_KEY, CHUNK, MAX_OUTPUT, SCHEMA, hash, matches, failure };

'use strict';

const { createHash } = require('node:crypto');
const { ensureSchemaTable } = require('./db.js');
const { MODEL_ID } = require('./longai_video_tests.js');

const PROMPT = 'A white paper boat drifts on a small pond in daylight, with gentle ripples and a steady camera.';
const ACTIVE = "('queued','submitting','accepted')";
const QUEUE_TTL_SECONDS = 5 * 60;
const POLL_TTL_SECONDS = 3 * 60 * 60;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const schema = `CREATE TABLE IF NOT EXISTS longai_render_tests (
  id CHAR(36) NOT NULL PRIMARY KEY,
  model VARCHAR(191) NOT NULL,
  key_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  provider_operation TEXT NULL,
  task_id VARCHAR(191) NULL,
  provider_status SMALLINT UNSIGNED NULL,
  provider_request_id VARCHAR(96) NULL,
  diagnostic VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_longai_render_status (status, created_at),
  KEY idx_longai_render_recent (created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
const ready = new WeakSet();
const fingerprint = key => createHash('sha256').update(key).digest('hex');
const problem = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const publicFields = `id, model, status, task_id AS taskId, provider_status AS providerStatus,
  provider_request_id AS providerRequestId, diagnostic, created_at AS createdAt, updated_at AS updatedAt`;

function validateRenderRequest(body) {
  if (body?.confirmPaid !== true) throw problem('Confirm the paid LONG AI render first.', 400);
  if (typeof body.id !== 'string' || !UUID.test(body.id) ||
      typeof body.model !== 'string' || !MODEL_ID.test(body.model)) {
    throw problem('Invalid LONG AI render test ID or model.', 400);
  }
}

async function readIfPresent(db, sql, params) {
  try {
    const [rows] = await db.execute(sql, params);
    return rows;
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    return [];
  }
}

function listRenderTests(db) {
  return readIfPresent(db, `SELECT ${publicFields} FROM longai_render_tests
    ORDER BY created_at DESC, id DESC LIMIT 100`);
}

async function hasActiveRenderTest(db) {
  return (await readIfPresent(db, `SELECT id FROM longai_render_tests WHERE status IN ${ACTIVE} LIMIT 1`)).length > 0;
}

async function hasRunningRenderTest(db) {
  try {
    return (await readIfPresent(db, "SELECT id FROM longai_render_tests WHERE status IN ('submitting','accepted') LIMIT 1")).length > 0;
  } catch (error) {
    if (error.code === 'ER_TABLEACCESS_DENIED_ERROR') return false;
    throw error;
  }
}

async function findRenderTest(db, id, model) {
  const [test] = await readIfPresent(db, `SELECT ${publicFields} FROM longai_render_tests WHERE id=?`, [id]);
  if (test && test.model !== model) throw problem('This render test ID belongs to another model.', 409);
  return test;
}

async function withLock(db, name, work) {
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[row]] = await conn.query('SELECT GET_LOCK(?,0) AS acquired', [name]);
    locked = Number(row?.acquired) === 1;
    if (locked) return await work(conn);
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {});
    conn.release();
  }
}

async function queueRenderTest(db, { id, model, confirmReconciled }, apiKey) {
  // This optional table is created on first use, without gating customer DB startup.
  if (!ready.has(db)) {
    await ensureSchemaTable(db, schema);
    ready.add(db);
  }
  const queued = await withLock(db, 'cmm_longai_render_admit', async conn => {
    const replay = await findRenderTest(conn, id, model);
    if (replay) return replay;
    await conn.execute(`UPDATE longai_render_tests SET status='expired',
      diagnostic='The worker did not start this test in time.', updated_at=UTC_TIMESTAMP()
      WHERE status='queued' AND TIMESTAMPDIFF(SECOND,created_at,UTC_TIMESTAMP())>=?`, [QUEUE_TTL_SECONDS]);
    if (await hasActiveRenderTest(conn)) throw problem('A LONG AI render test is already in progress.', 409);
    const [[previous]] = await conn.execute(
      'SELECT status FROM longai_render_tests WHERE model=? ORDER BY created_at DESC,id DESC LIMIT 1', [model]);
    if (previous?.status === 'submission_unknown' && confirmReconciled !== true) {
      throw problem('Check the uncertain attempt in LONG AI history before testing this model again.', 409);
    }
    await conn.execute("INSERT INTO longai_render_tests (id,model,key_fingerprint,status) VALUES (?,?,?,'queued')",
      [id, model, fingerprint(apiKey)]);
    return findRenderTest(conn, id, model);
  });
  if (!queued) throw problem('Another LONG AI render test is being queued. Refresh the results.', 409);
  return queued;
}

async function update(db, row, status, diagnostic = null, { operation, providerStatus, providerRequestId } = {}) {
  await db.execute(`UPDATE longai_render_tests SET status=?, diagnostic=?, provider_status=?, provider_request_id=?,
    provider_operation=COALESCE(?,provider_operation), task_id=COALESCE(?,task_id), updated_at=UTC_TIMESTAMP()
    WHERE id=? AND status=?`,
  [status, diagnostic, providerStatus ?? null, providerRequestId ?? null,
    operation ? JSON.stringify(operation) : null, operation?.requestId ?? null, row.id, row.status]);
}

function errorMetadata(error) {
  return { providerStatus: error.providerStatus, providerRequestId: error.providerRequestId };
}

async function submit(db, row, client) {
  const [claim] = await db.execute("UPDATE longai_render_tests SET status='submitting',updated_at=UTC_TIMESTAMP() WHERE id=? AND status='queued'", [row.id]);
  if (!claim.affectedRows) return;
  const claimed = { ...row, status: 'submitting' };
  let operation;
  try {
    operation = await client.startVideo({ prompt: PROMPT }, row.model);
  } catch (error) {
    const rejected = error.code === 'LONG_AI_NO_UPSTREAM' || error.providerStatus === 503 ||
      (error.providerStatus >= 400 && error.providerStatus < 500);
    const diagnostic = error.providerStatus === 503 ? 'LONG AI reported that the model was temporarily unavailable.' :
      rejected ? 'LONG AI rejected the submission.' : 'No task ID was confirmed. Check LONG AI history before another paid test.';
    return update(db, claimed, rejected ? 'submit_failed' : 'submission_unknown', diagnostic, errorMetadata(error));
  }
  await update(db, claimed, 'accepted', null, { operation });
}

async function poll(db, row, client) {
  let result;
  try {
    result = await client.videoStatus(JSON.parse(row.provider_operation), { reportMissingOutput: true });
  } catch (error) {
    return update(db, row, 'accepted', 'Could not read status. The worker will check the same task again.', errorMetadata(error));
  }
  if (result.status === 'failed') return update(db, row, 'render_failed', 'LONG AI accepted the task and reported a render failure.');
  if (result.status === 'missing_output') return update(db, row, 'output_unverified', 'LONG AI reported completion without a video URL.');
  if (result.status !== 'done') {
    if (row.diagnostic) await update(db, row, 'accepted');
    return;
  }
  try {
    await client.download(result.url);
  } catch {
    return update(db, row, 'output_unverified', 'LONG AI reported completion, but the MP4 could not be downloaded and verified.');
  }
  await update(db, row, 'verified', 'Completed and verified a full MP4.');
}

async function runRenderTest(db, client, canSubmit) {
  const query = `SELECT *,TIMESTAMPDIFF(SECOND,created_at,UTC_TIMESTAMP()) AS age
    FROM longai_render_tests WHERE status IN ${ACTIVE} ORDER BY created_at LIMIT 1`;
  if (!(await readIfPresent(db, query)).length) return;
  await withLock(db, 'cmm_longai_queue', async conn => {
    const [row] = await readIfPresent(conn, query);
    if (!row) return;
    if (row.status === 'submitting') {
      // The previous lock holder disappeared after claiming the only paid attempt.
      return update(conn, row, 'submission_unknown', 'The worker stopped during submission. Check LONG AI history before another paid test.');
    }
    if (row.status === 'queued') {
      if (row.age >= QUEUE_TTL_SECONDS) return update(conn, row, 'expired', 'The worker did not start this test in time.');
      if (row.key_fingerprint !== fingerprint(client.apiKey)) {
        return update(conn, row, 'expired', 'The saved LONG AI key changed before this test started.');
      }
      if (!canSubmit) return;
      const [[customer]] = await conn.execute(`SELECT id FROM generations
        WHERE provider='longai' AND status IN ('submitting','submitted','processing') LIMIT 1`);
      if (!customer) return submit(conn, row, client);
      return;
    }
    if (row.age >= POLL_TTL_SECONDS) return update(conn, row, 'expired', 'The accepted task did not finish within the test window.');
    if (row.key_fingerprint !== fingerprint(client.apiKey)) {
      return update(conn, row, 'output_unverified', 'The saved LONG AI key changed after the task was accepted.');
    }
    await poll(conn, row, client);
  });
}

module.exports = { validateRenderRequest, findRenderTest, listRenderTests, hasActiveRenderTest, hasRunningRenderTest, queueRenderTest, runRenderTest };

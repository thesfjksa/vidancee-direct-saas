'use strict';

const { randomUUID } = require('node:crypto');
const { getPool } = require('./db.js');
const { ensureSettingsTable, getProviderSettings } = require('./settings.js');
const { fetchFalImageCatalog, PROVIDER } = require('./fal_images.js');
const { syncProviderModels } = require('./provider_models.js');
const { logActivity } = require('./activity_log.js');

const LOCK_KEY = "CONCAT('cmmtools.fal.catalog.',LEFT(SHA2(DATABASE(),256),32))";
const SETTING = 'fal_image_catalog_sync';
const RUN_LIMIT_MS = 9 * 60 * 1000;
const QUEUE_LIMIT_MS = 2 * 60 * 1000;

async function readJob(db) {
  const [[row]] = await db.execute('SELECT setting_value FROM app_settings WHERE setting_key=?', [SETTING]);
  return row ? JSON.parse(row.setting_value) : { status: 'idle' };
}

function expireJob(job) {
  const running = job.status === 'running';
  if (!running && job.status !== 'queued') return job;
  const started = Date.parse(running ? job.startedAt : job.requestedAt);
  if (Number.isFinite(started) && Date.now() - started < (running ? RUN_LIMIT_MS : QUEUE_LIMIT_MS)) return job;
  return {
    ...job, status: 'failed',
    error: running
      ? 'The sync worker stopped or exceeded its time limit. Start a new sync to retry.'
      : 'No worker picked up this sync. Check that the generation worker is running, then retry.',
  };
}

async function falCatalogStatus(db = getPool()) {
  await ensureSettingsTable(db);
  return expireJob(await readJob(db));
}

async function writeJob(conn, job) {
  await conn.execute('UPDATE app_settings SET setting_value=? WHERE setting_key=?', [JSON.stringify(job), SETTING]);
}

async function withCatalogLock(db, work) {
  const conn = await db.getConnection();
  let locked = false;
  let destroyed = false;
  try {
    const [[result]] = await conn.query("SELECT GET_LOCK(" + LOCK_KEY + ",0) AS acquired");
    locked = Number(result.acquired) === 1;
    if (locked) return await work(conn);
  } finally {
    if (locked) {
      try {
        await conn.query("SELECT RELEASE_LOCK(" + LOCK_KEY + ")");
      } catch {
        conn.destroy();
        destroyed = true;
      }
    }
    if (!destroyed) conn.release();
  }
}

async function queueFalCatalogSync(db = getPool()) {
  await ensureSettingsTable(db);
  const existing = await readJob(db);
  if (expireJob(existing) !== existing) {
    await withCatalogLock(db, async conn => {
      const current = await readJob(conn);
      const expired = expireJob(current);
      if (expired !== current) await writeJob(conn, { ...expired, finishedAt: new Date().toISOString() });
    });
  }
  const job = { status: 'queued', requestedAt: new Date().toISOString() };
  await db.execute(
    `INSERT INTO app_settings (setting_key,setting_value,is_secret) VALUES (?,?,0)
     ON DUPLICATE KEY UPDATE setting_value=IF(
       JSON_UNQUOTE(JSON_EXTRACT(setting_value,'$.status')) IN ('queued','running'),
       setting_value, VALUES(setting_value))`,
    [SETTING, JSON.stringify(job)],
  );
  return falCatalogStatus(db);
}

async function runFalCatalogSync(db = getPool()) {
  await ensureSettingsTable(db);
  if ((await readJob(db)).status !== 'queued') return;
  const job = await withCatalogLock(db, async conn => {
    const current = await readJob(conn);
    if (expireJob(current).status !== 'queued') return;
    const running = { ...current, status: 'running', attempt: randomUUID(), startedAt: new Date().toISOString() };
    await writeJob(conn, running);
    return running;
  });
  if (!job) return;

  // Fetching the provider catalog can take minutes. Keep the database session
  // and advisory lock free until the catalog is ready to publish.
  try {
    const { falApiKey } = await getProviderSettings(db);
    if (!falApiKey) throw new Error('Save a fal.ai API key before syncing.');
    const catalog = await fetchFalImageCatalog({ apiKey: falApiKey });
    const details = await withCatalogLock(db, async conn => {
      const current = expireJob(await readJob(conn));
      if (current.status !== 'running' || current.attempt !== job.attempt) return;
      if ((await getProviderSettings(conn)).falApiKey !== falApiKey) {
        throw new Error('The fal.ai key changed during import. Start a new import with the current key.');
      }
      await conn.beginTransaction();
      try {
        const models = await syncProviderModels(PROVIDER, catalog, conn, { preserveExisting: catalog.diagnostics?.partial === true });
        const totals = { total: models.length, ready: models.filter(model => model.ready).length, diagnostics: catalog.diagnostics || null };
        await writeJob(conn, { ...job, status: 'completed', finishedAt: new Date().toISOString(), ...totals });
        await conn.commit();
        return totals;
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    });
    if (details) logActivity({ category: 'system', event: 'fal.images_synced', provider: PROVIDER, message: 'fal.ai image models synced', details });
  } catch (error) {
    const message = String(error.message || 'Catalog sync failed.').slice(0, 240);
    await withCatalogLock(db, async conn => {
      const current = await readJob(conn);
      if (current.status === 'running' && current.attempt === job.attempt) {
        await writeJob(conn, { ...job, status: 'failed', finishedAt: new Date().toISOString(), error: message });
      }
    });
    logActivity({ level: 'warn', category: 'system', event: 'fal.images_sync_failed', provider: PROVIDER, message });
  }
}

module.exports = { falCatalogStatus, queueFalCatalogSync, runFalCatalogSync };

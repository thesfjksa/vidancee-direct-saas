'use strict';

// Activity log: one row per action in the web app and the worker (requests,
// generations, provider calls and replies, refunds, Admin changes). Admin
// reads it in the Activity tab; a read-only support key can read it too.
// Writing never blocks or breaks the action being logged.
const crypto = require('node:crypto');
const os = require('node:os');
const { getPool, dbConfigured } = require('./db.js');

const SECRET_KEY = /(api[_-]?key|token|password|secret|authorization|cookie|signature|sig$)/i;
const MAX_DETAILS = 16 * 1024;
const KEEP_DAYS = 30;
let service = 'web';
let sink = null; // tests replace the writer

function setActivityService(name) { service = String(name || 'web').slice(0, 20); }
function setActivitySink(fn) { sink = fn; }
function enabled() { return process.env.ACTIVITY_LOG !== 'off' || Boolean(sink); }

// Masks secrets, long base64 data and signed-link signatures before storing.
function redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (typeof value === 'string') {
    let s = value.replace(/([?&](sig|signature|token|key|[\w.-]*(signature|credential|security-token)[\w.-]*)=)[^&\s"]+/gi, '$1***');
    if (/^data:[^;]+;base64,/.test(s) || (/^[A-Za-z0-9+/=]{400,}$/.test(s))) s = '[' + s.length + ' bytes of data]';
    return s.length > 4000 ? s.slice(0, 4000) + '…' : s;
  }
  if (Buffer.isBuffer(value)) return '[' + value.length + ' bytes]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v ? '***' : redact(v, depth + 1);
    return out;
  }
  return value;
}

function serializeDetails(details) {
  if (details == null) return null;
  let text;
  try { text = JSON.stringify(redact(details)); } catch { text = JSON.stringify({ unserializable: true }); }
  return text.length > MAX_DETAILS ? text.slice(0, MAX_DETAILS) + '…' : text;
}

function errorDetails(error) {
  if (!error) return null;
  return { message: String(error.message || error).slice(0, 1000), statusCode: error.statusCode, providerStatus: error.providerStatus, providerMessage: error.providerMessage, providerRequestId: error.providerRequestId,
    detail: error.detail, code: error.code,
    cause: error.cause ? String(error.cause.code || '') + ' ' + String(error.cause.message || error.cause).slice(0, 300) : undefined, stack: String(error.stack || '').split('\n').slice(1, 4).join(' | ') };
}

// level: info | warn | error. category: auth, generation, provider, refund, admin, request, system...
function logActivity({ level = 'info', category, event, userId = null, generationId = null, provider = null, message = '', details = null } = {}) {
  if (!enabled()) return;
  const row = {
    service, level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    category: String(category || 'system').slice(0, 30), event: String(event || 'event').slice(0, 60),
    userId: userId == null || userId === '' ? null : Number(userId) || null,
    generationId: generationId ? String(generationId).slice(0, 36) : null,
    provider: provider ? String(provider).slice(0, 30) : null,
    message: redact(String(message || '')).slice(0, 500), details: serializeDetails(details),
  };
  try {
    if (sink) { sink(row); return; }
    if (!dbConfigured()) return;
    getPool().execute(
      `INSERT INTO activity_log (service,level,category,event,user_id,generation_id,provider,message,details,host)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [row.service, row.level, row.category, row.event, row.userId, row.generationId, row.provider, row.message, row.details, os.hostname().slice(0, 60)],
    ).catch(() => {});
  } catch {}
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  return domain ? name.slice(0, 2) + '***@' + domain : email;
}

async function listActivity(db, { limit = 200, beforeId, sinceMinutes, level, category, provider, generationId, userId, q } = {}) {
  const where = [], args = [];
  if (beforeId) { where.push('a.id < ?'); args.push(Number(beforeId)); }
  if (sinceMinutes) { where.push('a.created_at >= UTC_TIMESTAMP() - INTERVAL ? MINUTE'); args.push(Math.min(60 * 24 * 30, Number(sinceMinutes))); }
  if (level) { where.push('a.level = ?'); args.push(String(level)); }
  if (category) { where.push('a.category = ?'); args.push(String(category)); }
  if (provider) { where.push('a.provider = ?'); args.push(String(provider)); }
  if (generationId) { where.push('a.generation_id = ?'); args.push(String(generationId)); }
  if (userId) { where.push('a.user_id = ?'); args.push(Number(userId)); }
  if (q) { where.push('(a.message LIKE ? OR a.event LIKE ? OR a.details LIKE ?)'); const like = '%' + String(q).slice(0, 100) + '%'; args.push(like, like, like); }
  const n = Math.min(1000, Math.max(1, Number(limit) || 200));
  const [rows] = await db.query(
    `SELECT a.id,a.created_at,a.service,a.level,a.category,a.event,a.user_id,u.email,a.generation_id,a.provider,a.message,a.details
     FROM activity_log a LEFT JOIN users u ON u.id=a.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${n}`, args);
  return rows.map(r => ({ id: Number(r.id), at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, service: r.service,
    level: r.level, category: r.category, event: r.event, userId: r.user_id == null ? null : Number(r.user_id), email: r.email || null,
    generationId: r.generation_id, provider: r.provider, message: r.message,
    details: (() => { try { return r.details ? JSON.parse(r.details) : null; } catch { return r.details; } })() }));
}

async function pruneActivity(db) {
  await db.execute('DELETE FROM activity_log WHERE created_at < UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT 50000', [KEEP_DAYS]).catch(() => {});
}

// Read-only support key: only its SHA-256 hash is stored.
const SUPPORT_KEY_SETTING = 'support_access_key_hash';
function newSupportKey() { return 'cmm_support_' + crypto.randomBytes(24).toString('base64url'); }
function hashSupportKey(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }
function supportKeyMatches(supplied, storedHash) {
  if (!supplied || !storedHash) return false;
  const a = Buffer.from(hashSupportKey(supplied)), b = Buffer.from(String(storedHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { logActivity, errorDetails, redact, listActivity, pruneActivity, maskEmail, setActivityService, setActivitySink,
  SUPPORT_KEY_SETTING, newSupportKey, hashSupportKey, supportKeyMatches, KEEP_DAYS };

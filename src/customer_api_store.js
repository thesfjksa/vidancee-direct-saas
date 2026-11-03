'use strict';
const crypto = require('node:crypto');
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const KEY_FIELDS = 'id,name,key_prefix,created_at,expires_at,last_used_at,revoked_at';
const RATE_LIMIT = 120;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS customer_api_keys (
    id CHAR(36) NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(80) NOT NULL, key_hash CHAR(64) NOT NULL, key_prefix VARCHAR(24) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL,
    last_used_at DATETIME NULL, revoked_at DATETIME NULL,
    rate_window BIGINT NOT NULL DEFAULT 0, rate_count INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id), UNIQUE KEY uq_customer_api_hash (key_hash), KEY idx_customer_api_user (user_id),
    CONSTRAINT fk_customer_api_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS customer_api_requests (
    user_id BIGINT UNSIGNED NOT NULL, request_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL, api_key_id CHAR(36) NOT NULL, generation_id CHAR(36) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id,request_key_hash), UNIQUE KEY uq_customer_api_generation (generation_id),
    KEY idx_customer_api_requests_key (api_key_id),
    CONSTRAINT fk_customer_api_request_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

function canonical(value) {
  if (Buffer.isBuffer(value)) return { sha256: hash(value), bytes: value.length };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function requestContext(keyId, idempotencyKey, body, mediaType) {
  if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(idempotencyKey)) {
    fail(400, 'Provide an Idempotency-Key header of 8–128 printable characters. Reuse it only for retries of the same request.');
  }
  return { keyId, requestKeyHash: hash(idempotencyKey), requestHash: hash(JSON.stringify(canonical({ mediaType, body }))) };
}
async function createKey(db, userId, input = {}) {
  const name = String(input.name || '').trim();
  const days = input.expiresInDays === undefined ? 90 : Number(input.expiresInDays);
  if (!name || name.length > 80) fail(400, 'Key name must contain 1–80 characters.');
  if (!Number.isInteger(days) || days < 1 || days > 365) fail(400, 'Key expiry must be 1–365 days.');
  const secret = 'cmm_live_' + crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[user]] = await conn.execute('SELECT id,status FROM users WHERE id=? FOR UPDATE', [userId]);
    if (!user || user.status !== 'active') fail(403, 'Account unavailable.');
    const [[count]] = await conn.execute('SELECT COUNT(*) AS total FROM customer_api_keys WHERE user_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP()', [userId]);
    if (Number(count.total) >= 10) fail(409, 'You can have up to 10 active API keys. Revoke an existing key first.');
    await conn.execute('INSERT INTO customer_api_keys (id,user_id,name,key_hash,key_prefix,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? DAY))',
      [id, userId, name, hash(secret), secret.slice(0, 17), days]);
    const [[key]] = await conn.execute('SELECT ' + KEY_FIELDS + ' FROM customer_api_keys WHERE id=?', [id]);
    await conn.commit();
    return { key, secret };
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
}
async function listKeys(db, userId) {
  const [rows] = await db.execute('SELECT ' + KEY_FIELDS + ' FROM customer_api_keys WHERE user_id=? ORDER BY (revoked_at IS NULL AND expires_at>UTC_TIMESTAMP()) DESC,created_at DESC LIMIT 100', [userId]);
  return rows;
}
async function revokeKey(db, userId, id) {
  const [result] = await db.execute('UPDATE customer_api_keys SET revoked_at=COALESCE(revoked_at,UTC_TIMESTAMP()) WHERE id=? AND user_id=?', [id, userId]);
  if (!result.affectedRows) fail(404, 'API key not found.');
}
async function authenticate(db, req) {
  const match = /^Bearer (cmm_live_[A-Za-z0-9_-]{43})$/i.exec(String(req.headers.authorization || ''));
  if (!match) fail(401, 'A valid CMM Tools API key is required in Authorization: Bearer.');
  const [[row]] = await db.execute(`SELECT k.id AS api_key_id,u.id,u.credits,u.status,u.role
    FROM customer_api_keys k JOIN users u ON u.id=k.user_id
    WHERE k.key_hash=? AND k.revoked_at IS NULL AND k.expires_at>UTC_TIMESTAMP() AND u.status='active' LIMIT 1`, [hash(match[1])]);
  if (!row) fail(401, 'API key is invalid, expired or revoked.');
  // Fixed UTC minute window, persisted across processes and server restarts.
  const [result] = await db.execute(`UPDATE customer_api_keys SET
    rate_count=IF(rate_window=FLOOR(UNIX_TIMESTAMP()/60),rate_count+1,1),
    rate_window=FLOOR(UNIX_TIMESTAMP()/60),last_used_at=UTC_TIMESTAMP()
    WHERE id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP()
    AND (rate_window<>FLOOR(UNIX_TIMESTAMP()/60) OR rate_count<?)`, [row.api_key_id, RATE_LIMIT]);
  if (!result.affectedRows) fail(429, 'API request limit reached, or key revoked. Wait until the next minute and retry.');
  req.activityUserId = row.id;
  return { user: row, keyId: row.api_key_id };
}
async function findReplay(db, userId, context) {
  const [[request]] = await db.execute('SELECT request_hash,generation_id FROM customer_api_requests WHERE user_id=? AND request_key_hash=?', [userId, context.requestKeyHash]);
  if (!request) return null;
  if (request.request_hash !== context.requestHash) fail(409, 'This Idempotency-Key was already used with a different request.');
  const [[generation]] = await db.execute('SELECT * FROM generations WHERE id=? AND user_id=?', [request.generation_id, userId]);
  if (!generation) fail(410, 'The generation for this Idempotency-Key was deleted. Use a new key to create a new generation.');
  return generation;
}
// Called inside the existing generation transaction, AFTER the user row lock.
// This serializes website/API charging and concurrent retries across all keys.
async function beginRequest(conn, userId, context) {
  if (!context) return null;
  const [[key]] = await conn.execute('SELECT id FROM customer_api_keys WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP() FOR UPDATE', [context.keyId, userId]);
  if (!key) fail(401, 'API key is expired or revoked.');
  return findReplay(conn, userId, context);
}
async function completeRequest(conn, userId, context, generationId) {
  if (!context) return;
  await conn.execute('INSERT INTO customer_api_requests (user_id,request_key_hash,request_hash,api_key_id,generation_id) VALUES (?,?,?,?,?)',
    [userId, context.requestKeyHash, context.requestHash, context.keyId, generationId]);
}
async function usage(db, userId) {
  const [rows] = await db.execute(`SELECT r.api_key_id,COUNT(*) AS generations,
    COALESCE(SUM(g.credits_cost),0) AS reserved_credits,
    COALESCE(SUM(IF(g.refunded_at IS NOT NULL,g.credits_cost,0)),0) AS refunded_credits
    FROM customer_api_requests r JOIN generations g ON g.id=r.generation_id AND g.user_id=r.user_id
    WHERE r.user_id=? GROUP BY r.api_key_id`, [userId]);
  return rows.map(row => ({ key_id: row.api_key_id, generations: Number(row.generations),
    reserved_credits: Number(row.reserved_credits), refunded_credits: Number(row.refunded_credits),
    net_credits: Number((Number(row.reserved_credits) - Number(row.refunded_credits)).toFixed(4)) }));
}
module.exports = { SCHEMA, RATE_LIMIT, hash, canonical, requestContext, createKey, listKeys, revokeKey, authenticate, findReplay, beginRequest, completeRequest, usage };

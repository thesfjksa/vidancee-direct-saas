const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { getPool } = require('./db.js');

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = 'cmm_session';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function hashPassword(password) {
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, 64);
  return 'scrypt$' + salt + '$' + Buffer.from(derived).toString('hex');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const derived = await scrypt(String(password), parts[1], 64);
  const expected = Buffer.from(parts[2], 'hex');
  const actual = Buffer.from(derived);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionMaxAgeSeconds() {
  const days = Number(process.env.SESSION_DAYS || 30);
  return Math.max(1, days) * 86400;
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sessionHash(token);
  const maxAge = sessionMaxAgeSeconds();
  const db = getPool();
  await db.execute(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))',
    [tokenHash, userId, maxAge],
  );

  const secure = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const cookie = [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAge,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookie);
}

async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) {
    const db = getPool();
    await db.execute('DELETE FROM sessions WHERE token_hash = ?', [sessionHash(token)]);
  }

  const secure = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const cookie = [
    COOKIE_NAME + '=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookie);
}

async function userFromRequest(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;

  const db = getPool();
  const [rows] = await db.execute(
    `SELECT u.id, u.email, u.credits, u.role, u.status, u.created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.status = 'active'
     LIMIT 1`,
    [sessionHash(token)],
  );

  return rows[0] || null;
}

// Hash of the signed-in session, for binding forms to it (Claude connector consent).
function sessionTokenHash(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return token ? sessionHash(token) : '';
}

async function requireUser(req) {
  const user = await userFromRequest(req);
  if (!user) {
    const error = new Error('Authentication required.');
    error.statusCode = 401;
    throw error;
  }
  return user;
}

module.exports = {
  normalizeEmail,
  validateEmail,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userFromRequest,
  requireUser,
  sessionTokenHash,
};

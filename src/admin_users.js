'use strict';

// Admin tools for one customer: change plan, change credits, and signed links
// that let the admin page show any customer's videos, images and audio.
const crypto = require('node:crypto');
const { PLANS, LEGACY_PLANS, getPlan } = require('./plans.js');
const { roundCredits } = require('./billing.js');

function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }

// Every plan the admin can assign, current plans first.
function adminPlanOptions() {
  const row = (p, legacy) => ({ code: p.code, name: p.name, credits: Number(p.credits) || 0, pricePkr: p.pricePkr ?? null,
    concurrency: p.concurrency, legacy });
  return [...Object.values(PLANS).map(p => row(p, false)), ...Object.values(LEGACY_PLANS).map(p => row(p, true))];
}

const USER_FIELDS = 'id,email,credits,plan_code,role,status,created_at,updated_at';

// plan '' or null removes the plan. grantCredits adds that plan's credits with
// a ledger row, the same as approving a plan request.
async function setUserPlan(db, userId, planCode, { grantCredits = false, note = '' } = {}) {
  const code = String(planCode || '').trim().toLowerCase();
  const plan = code ? getPlan(code) : null;
  if (code && !plan) throw httpError(400, 'Choose a valid plan.');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [users] = await conn.execute('SELECT id,plan_code FROM users WHERE id=? FOR UPDATE', [userId]);
    if (!users[0]) throw httpError(404, 'User not found.');
    const grant = plan && grantCredits ? Number(plan.credits) || 0 : 0;
    await conn.execute('UPDATE users SET plan_code=?,credits=credits+?,updated_at=UTC_TIMESTAMP() WHERE id=?', [plan ? plan.code : null, grant, userId]);
    if (grant) {
      await conn.execute("INSERT INTO credit_transactions (user_id,generation_id,amount,type,note) VALUES (?,NULL,?,'plan_credit',?)",
        [userId, grant, String(note || plan.name + ' plan credits (set by admin)').slice(0, 255)]);
    }
    await conn.commit();
    const [rows] = await db.execute('SELECT ' + USER_FIELDS + ' FROM users WHERE id=?', [userId]);
    return { user: rows[0], previousPlan: users[0].plan_code || null, creditsGranted: grant };
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
}

// mode 'add' changes the balance by amount (negative removes); mode 'set'
// makes the balance exactly amount. Either way one ledger row records the change.
async function changeUserCredits(db, userId, { amount, mode = 'add', note = '' } = {}) {
  const value = roundCredits(Number(amount));
  if (!Number.isFinite(value)) throw httpError(400, 'Enter a number of credits.');
  if (mode === 'set' && value < 0) throw httpError(400, 'The balance cannot be negative.');
  if (mode !== 'set' && value === 0) throw httpError(400, 'Enter a non-zero amount.');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [users] = await conn.execute('SELECT id,credits FROM users WHERE id=? FOR UPDATE', [userId]);
    const user = users[0];
    if (!user) throw httpError(404, 'User not found.');
    const delta = mode === 'set' ? roundCredits(value - Number(user.credits)) : value;
    if (Number(user.credits) + delta < 0) throw httpError(400, 'This would make the balance negative.');
    if (delta !== 0) {
      await conn.execute('UPDATE users SET credits=credits+?,updated_at=UTC_TIMESTAMP() WHERE id=?', [delta, userId]);
      const fallback = mode === 'set' ? 'Balance set to ' + value + ' by admin' : 'Admin credit adjustment';
      await conn.execute("INSERT INTO credit_transactions (user_id,amount,type,note) VALUES (?,?,'admin_adjustment',?)",
        [userId, delta, String(note || fallback).slice(0, 255)]);
    }
    await conn.commit();
    const [rows] = await db.execute('SELECT ' + USER_FIELDS + ' FROM users WHERE id=?', [userId]);
    return { user: rows[0], delta };
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
}

// Signed, short-lived links for <video>/<img> tags, which cannot send the admin header.
const MEDIA_TTL_SECONDS = 6 * 3600;
function mediaSignature(secret, id, type, exp) {
  return crypto.createHmac('sha256', 'admin-media:' + secret).update(id + '|' + type + '|' + exp).digest('base64url');
}
function adminMediaUrl(secret, id, type, now = Date.now()) {
  const exp = Math.floor(now / 1000) + MEDIA_TTL_SECONDS;
  return '/admin-media/' + id + '?type=' + type + '&exp=' + exp + '&sig=' + mediaSignature(secret, id, type, exp);
}
function verifyAdminMedia(secret, id, type, exp, sig, now = Date.now()) {
  if (!secret || !/^\d+$/.test(String(exp)) || Number(exp) < now / 1000) return false;
  const want = Buffer.from(mediaSignature(secret, id, type, exp)), got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Links for one generation row: what the admin gallery shows.
function adminMediaLinks(secret, row) {
  if (!secret || !row.output_url) return {};
  const type = row.media_type || 'video', links = {};
  if (type === 'image') { links.image_url = adminMediaUrl(secret, row.id, 'image'); links.thumb_url = adminMediaUrl(secret, row.id, 'thumbnail'); }
  else if (type === 'audio') links.audio_url = adminMediaUrl(secret, row.id, 'audio');
  else { links.video_url = adminMediaUrl(secret, row.id, 'video'); if (row.poster_url) links.poster_url = adminMediaUrl(secret, row.id, 'poster'); }
  return links;
}

module.exports = { adminPlanOptions, setUserPlan, changeUserCredits, adminMediaUrl, verifyAdminMedia, adminMediaLinks, USER_FIELDS };

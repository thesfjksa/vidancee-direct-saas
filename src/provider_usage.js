'use strict';

// Admin "Usage & limits": remaining balance where a provider reports one, and
// consumption from this app's own job records for every provider.
const { VercelGatewayClient } = require('./provider/vercel.js');
const { ArgoLinkClient } = require('./provider/argolink.js');

// Grouped by studio: Video (ArgoLink, Higgsfield), Image (AI Gateway, SmartAIPI, then
// ArgoLink), Video and Cartoon (vgenv), Upscaler and HD enhancement (fal.ai) and Voice (Vibi).
const PROVIDERS = [
  ['argolink', 'ArgoLink'], ['higgsfield', 'Higgsfield'], ['sluice', 'Sluice'], ['longai', 'LONG AI'], ['vidancee', 'Vidancee'], ['vercel', 'Vercel AI Gateway'], ['smartaipi', 'SmartAIPI'],
  ['vgenv', 'MiniMax (vgenv)'], ['fal', 'fal.ai upscaler'], ['vibi', 'Vibi voice'],
];
const STATUS_KEY = 'status_provider_runtime';

// The worker saves what it learns about sources (out-of-credits marks) here.
async function recordProviderStatus(db, patch) {
  const [rows] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [STATUS_KEY]);
  let current = {};
  try { current = JSON.parse(rows[0]?.setting_value || '{}') || {}; } catch {}
  const next = { ...current, ...patch };
  await db.execute(
    `INSERT INTO app_settings (setting_key,setting_value,is_secret) VALUES (?,?,0)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
    [STATUS_KEY, JSON.stringify(next)],
  );
}

async function readProviderStatus(db) {
  const [rows] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [STATUS_KEY]);
  try { return JSON.parse(rows[0]?.setting_value || '{}') || {}; } catch { return {}; }
}

async function localUsage(db) {
  const [rows] = await db.query(
    `SELECT provider,
       SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS jobs24h,
       COUNT(*) AS jobs30d,
       SUM(status='completed') AS completed30d,
       SUM(status IN ('failed','submit_error')) AS failed30d,
       SUM(status IN ('queued','submitting','submitted','processing')) AS active,
       SUM(CASE WHEN status='completed' THEN credits_cost ELSE 0 END) AS customerCredits30d
     FROM generations WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY GROUP BY provider`,
  );
  const [costs] = await db.query(
    `SELECT provider, provider_cost_unit AS unit, SUM(provider_cost) AS total
     FROM generations
     WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY AND status='completed' AND provider_cost IS NOT NULL
     GROUP BY provider, provider_cost_unit`,
  );
  const out = {};
  for (const r of rows) {
    out[r.provider] = {
      jobs24h: Number(r.jobs24h || 0), jobs30d: Number(r.jobs30d || 0), completed30d: Number(r.completed30d || 0),
      failed30d: Number(r.failed30d || 0), active: Number(r.active || 0),
      customerCredits30d: Math.round(Number(r.customerCredits30d || 0) * 100) / 100, sourceCost30d: [],
    };
  }
  for (const c of costs) {
    if (!out[c.provider]) continue;
    out[c.provider].sourceCost30d.push({ unit: c.unit || 'credits', total: Math.round(Number(c.total || 0) * 10000) / 10000 });
  }
  return out;
}

const withTimeout = (promise, ms = 8000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('The provider did not answer in time.')), ms).unref())]);

// Many OpenAI-compatible resellers expose these billing routes; SmartAIPI is
// not documented to, so a failure just means "not reported".
async function smartAipiBalance(baseUrl, apiKey, fetchImpl = globalThis.fetch) {
  const base = String(baseUrl || 'https://api.smartaipi.com/v1').replace(/\/$/, '');
  const get = async path => {
    const r = await fetchImpl(base + path, { headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const sub = await get('/dashboard/billing/subscription');
  const limit = Number(sub.hard_limit_usd ?? sub.system_hard_limit_usd);
  if (!Number.isFinite(limit)) throw new Error('No limit reported.');
  const today = new Date(), start = new Date(today.getTime() - 99 * 864e5);
  const day = d => d.toISOString().slice(0, 10);
  let used = null;
  try { const u = await get('/dashboard/billing/usage?start_date=' + day(start) + '&end_date=' + day(new Date(today.getTime() + 864e5))); used = Number(u.total_usage) / 100; } catch {}
  return { remaining: used == null ? null : Math.max(0, limit - used), limit, used, unit: 'USD' };
}

async function remoteBalances(settings, status, { fetchImpl } = {}) {
  const out = {};
  const outOfCredits = status.outOfCredits || {};
  for (const key of Object.keys(outOfCredits)) {
    if (Number(outOfCredits[key]) > Date.now()) out[key] = { ...(out[key] || {}), outOfCreditsUntil: new Date(Number(outOfCredits[key])).toISOString() };
  }

  const tasks = [];
  if (settings.vercelApiKey) tasks.push(withTimeout(new VercelGatewayClient({ apiKey: settings.vercelApiKey, ...(fetchImpl ? { fetchImpl } : {}) }).credits())
    .then(c => { out.vercel = { remaining: Number(c.balance), used: Number(c.totalUsed ?? c.total_used), unit: 'USD' }; })
    .catch(e => { out.vercel = { error: e.message }; }));
  if (settings.smartAipiApiKey) tasks.push(withTimeout(smartAipiBalance(settings.smartAipiBaseUrl, settings.smartAipiApiKey, fetchImpl))
    .then(b => { out.smartaipi = b; })
    .catch(() => { out.smartaipi = { note: 'SmartAIPI does not report a balance through its API.' }; }));
  if (settings.argoLinkApiKey) tasks.push(withTimeout(new ArgoLinkClient({ apiKey: settings.argoLinkApiKey, ...(fetchImpl ? { fetchImpl } : {}) }).balance())
    .then(b => { out.argolink = b || { note: 'ArgoLink did not report a balance. Check the wallet in the ArgoLink console.' }; })
    .catch(e => { out.argolink = { error: e.message }; }));
  await Promise.all(tasks);
  for (const [key] of PROVIDERS) if (!out[key]) out[key] = { note: 'This provider does not report a balance through its API.' };
  return out;
}

async function providerUsage(db, settings, adminSettings, options) {
  const [local, status] = await Promise.all([localUsage(db), readProviderStatus(db)]);
  const remote = await remoteBalances(settings, status, options);
  return PROVIDERS.map(([key, label]) => ({
    key, label,
    active: Boolean(adminSettings[key]?.active), configured: Boolean(adminSettings[key]?.configured),
    balance: remote[key],
    usage: local[key] || { jobs24h: 0, jobs30d: 0, completed30d: 0, failed30d: 0, active: 0, customerCredits30d: 0, sourceCost30d: [] },
  }));
}

module.exports = { PROVIDERS, STATUS_KEY, recordProviderStatus, readProviderStatus, localUsage, remoteBalances, smartAipiBalance, providerUsage };

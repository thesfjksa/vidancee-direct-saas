'use strict';

// Read-only answer to "is it us, the source or the host?": from inside the
// process that runs it, time DNS and HTTPS to 888API next to other services
// several times over. Only status codes, timings and error codes come back,
// never response bodies or keys.
const dns = require('node:dns').promises;

const TARGETS = [
  { name: '888api', url: 'https://888api.xin/v1/models' },
  { name: 'vgenv', url: 'https://api.vgenv.com/' },
  { name: 'fal', url: 'https://queue.fal.run/' },
  { name: 'cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace' },
  { name: 'google', url: 'https://www.google.com/generate_204' },
];

function errorCode(error) {
  const code = String(error?.cause?.code || error?.code || error?.name || 'error').slice(0, 50);
  return /^[A-Za-z][A-Za-z0-9_]{1,49}$/.test(code) ? code : 'error';
}

async function timed(fn) {
  const start = Date.now();
  try { return { ms: Date.now() - start, ...(await fn()) }; }
  catch (error) { return { ms: Date.now() - start, error: errorCode(error) }; }
}

async function probe(url, { fetchImpl, timeoutMs, headers = {} }) {
  return timed(async () => {
    const start = Date.now();
    const r = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await r.body?.cancel?.().catch(() => {});
    return { status: r.status, ms: Date.now() - start };
  });
}

function summary(tries) {
  const ok = tries.filter(t => t.status && t.status < 500).length;
  const errors = {};
  for (const t of tries) if (!t.status || t.status >= 500) { const k = t.error || 'HTTP ' + t.status; errors[k] = (errors[k] || 0) + 1; }
  const times = tries.filter(t => t.status).map(t => t.ms).sort((a, b) => a - b);
  return { ok, failed: tries.length - ok, errors, medianMs: times.length ? times[Math.floor(times.length / 2)] : null };
}

// task: an 888API task id whose finished video is fetched (first 1 KB only)
// through the authenticated content endpoint.
async function runNetworkCheck({ rounds = 5, timeoutMs = 15000, api888Key = '', task = '',
  fetchImpl = fetch, lookup = host => dns.lookup(host, { all: true }) } = {}) {
  rounds = Math.max(1, Math.min(10, Number(rounds) || 5));
  const targets = TARGETS.slice();
  if (task && api888Key && /^[A-Za-z0-9_-]{5,191}$/.test(task)) {
    targets.push({ name: '888api-content', url: 'https://888api.xin/v1/videos/' + encodeURIComponent(task) + '/content',
      headers: { authorization: 'Bearer ' + api888Key, range: 'bytes=0-1023' } });
  }
  const results = {};
  await Promise.all(targets.map(async target => {
    const host = new URL(target.url).hostname;
    const resolved = await timed(async () => ({ addresses: (await lookup(host)).map(a => a.address).slice(0, 4) }));
    const tries = [];
    for (let i = 0; i < rounds; i++) tries.push(await probe(target.url, { fetchImpl, timeoutMs, headers: target.headers }));
    results[target.name] = { host, dns: resolved, ...summary(tries), tries };
  }));
  const ip = await timed(async () => {
    const r = await fetchImpl('https://api.ipify.org', { signal: AbortSignal.timeout(timeoutMs) });
    const text = (await r.text()).trim();
    return { address: /^[0-9a-f.:]{3,45}$/i.test(text) ? text : null };
  });
  return { at: new Date().toISOString(), rounds, publicIp: ip.address || null, results };
}

module.exports = { runNetworkCheck, TARGETS };

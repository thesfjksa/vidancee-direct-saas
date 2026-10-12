'use strict';

// Evidence for "the site went down" reports: was the process restarted, did
// the event loop stall, and which requests were slow. Everything is in memory
// except the boot history, which is stored so restarts survive the restart.
const { monitorEventLoopDelay } = require('node:perf_hooks');

const STALL_MS = 1000;
const SLOW_REQUEST_MS = 5000;
const KEEP = 20;

function routeLabel(method, path) {
  const clean = String(path || '/')
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n');
  return String(method || 'GET') + ' ' + clean.slice(0, 120);
}

class RuntimeDiagnostics {
  constructor({ now = () => Date.now(), sampleMs = 5000 } = {}) {
    this.now = now;
    this.startedAt = now();
    this.stalls = [];
    this.slowRequests = [];
    this.requests = 0;
    this.errors = 0;
    this.worstLagMs = 0;
    this.worstLagAt = null;
    this.recentLagMs = 0;
    this.histogram = null;
    this.timer = null;
    this.sampleMs = sampleMs;
  }

  start() {
    if (this.histogram) return this;
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.histogram?.disable();
    this.histogram = null;
  }

  sample() {
    if (!this.histogram) return;
    const maxMs = Math.round(this.histogram.max / 1e6);
    this.histogram.reset();
    this.recordLag(maxMs);
  }

  recordLag(maxMs) {
    this.recentLagMs = maxMs;
    if (maxMs > this.worstLagMs) {
      this.worstLagMs = maxMs;
      this.worstLagAt = new Date(this.now()).toISOString();
    }
    if (maxMs >= STALL_MS) {
      this.stalls.unshift({ at: new Date(this.now()).toISOString(), ms: maxMs });
      this.stalls.length = Math.min(this.stalls.length, KEEP);
      console.warn('[runtime] event loop stalled for', maxMs, 'ms');
    }
  }

  recordRequest(method, path, ms, status) {
    this.requests++;
    if (status >= 500) this.errors++;
    if (ms < SLOW_REQUEST_MS) return;
    this.slowRequests.unshift({ at: new Date(this.now()).toISOString(), route: routeLabel(method, path), ms: Math.round(ms), status });
    this.slowRequests.length = Math.min(this.slowRequests.length, KEEP);
  }

  // Public, non-sensitive summary for /health.
  summary() {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      eventLoopLagMs: this.recentLagMs,
      worstEventLoopLagMs: this.worstLagMs,
      stalls: this.stalls.length,
    };
  }

  // Full detail for the Admin console.
  details() {
    return {
      ...this.summary(),
      worstEventLoopLagAt: this.worstLagAt,
      requests: this.requests,
      serverErrors: this.errors,
      recentStalls: this.stalls,
      slowRequests: this.slowRequests,
    };
  }
}

async function recordBoot(db, service) {
  await db.execute(
    'INSERT INTO runtime_boots (service,pid,node_version,started_at) VALUES (?,?,?,UTC_TIMESTAMP())',
    [String(service).slice(0, 20), process.pid, process.version.slice(0, 20)],
  );
  // Keep the table small: the newest 200 boots per service are plenty.
  await db.execute(
    `DELETE FROM runtime_boots WHERE service=? AND id < (
       SELECT id FROM (SELECT id FROM runtime_boots WHERE service=? ORDER BY id DESC LIMIT 1 OFFSET 199) keep_floor
     )`,
    [String(service).slice(0, 20), String(service).slice(0, 20)],
  );
}

async function listBoots(db, limit = 15) {
  const [rows] = await db.query(
    'SELECT service,pid,node_version,started_at FROM runtime_boots ORDER BY id DESC LIMIT ?',
    [Math.max(1, Math.min(100, Number(limit) || 15))],
  );
  return rows.map(row => ({
    service: row.service,
    pid: Number(row.pid),
    node: row.node_version,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
  }));
}

module.exports = { RuntimeDiagnostics, recordBoot, listBoots, routeLabel, STALL_MS, SLOW_REQUEST_MS };

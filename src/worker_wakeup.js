// A standalone Hostinger app can be cold when only the customer app receives traffic.
// This health request wakes it without sharing customer data or provider credentials.
class WorkerWakeup {
  constructor({ url = '', fetchImpl = globalThis.fetch, now = Date.now, minIntervalMs = 15000, timeoutMs = 15000 } = {}) {
    this.url = String(url || '').trim();
    this.fetchImpl = fetchImpl; this.now = now;
    this.minIntervalMs = minIntervalMs; this.timeoutMs = timeoutMs;
    this.inflight = null; this.nextAllowedAt = 0; this.lastResult = null;
  }

  wake() {
    if (!this.url) return Promise.resolve({ ok: false, skipped: true });
    if (this.inflight) return this.inflight;
    if (this.now() < this.nextAllowedAt) return Promise.resolve({ ok: false, skipped: true });
    this.nextAllowedAt = this.now() + this.minIntervalMs;
    this.inflight = this.ping().then(result => {
      this.lastResult = { ...result, checkedAt: new Date(this.now()).toISOString() };
      return result;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async ping() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const target = new URL(this.url);
      if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) {
        return { ok: false, error: 'Worker wake URL must be a plain HTTPS health endpoint.' };
      }
      const response = await this.fetchImpl(target.toString(), {
        method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, error: 'Worker wake request failed (HTTP '+response.status+').' };
      }
      const health = await response.json();
      if (health.ok !== true || health.service !== 'mehroz-ai-worker') return { ok: false, error: 'Worker health response is invalid.' };
      if (health.workerEnabled === false) return { ok: false, error: 'Generation worker is disabled.' };
      return { ok: true };
    } catch {
      return { ok: false, error: controller.signal.aborted ? 'Worker wake request timed out.' : 'Worker wake request failed.' };
    } finally { clearTimeout(timer); }
  }

  status() { return { configured: Boolean(this.url), running: Boolean(this.inflight), lastResult: this.lastResult }; }
}

module.exports = { WorkerWakeup };

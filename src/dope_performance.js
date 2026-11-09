'use strict';

const { ORIGIN, SPECS, publicId } = require('./wxksai_models.js');
const { customerModelId } = require('./dope_brand.js');

const REFRESH_MS = 10 * 60 * 1000;
const modelIds = new Map(Object.keys(SPECS).map(id => [id, customerModelId(publicId(id))]));

function createDopePerformance({ fetchImpl = fetch, now = Date.now } = {}) {
  let snapshot = { updatedAt: null, stale: true, models: {} };
  let refreshAfter = 0;
  let pending;

  async function refresh() {
    try {
      const response = await fetchImpl(ORIGIN + '/api/perf-metrics/summary?hours=24', {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Dope performance request failed');
      const body = await response.json();
      if (body?.success !== true || !Array.isArray(body.data?.models)) {
        throw new Error('Invalid Dope performance response');
      }
      const models = {};
      for (const row of body.data.models) {
        const id = modelIds.get(row?.model_name);
        const successRate = row?.success_rate;
        const averageLatencyMs = row?.avg_latency_ms;
        if (!id || !Number.isFinite(successRate) || successRate < 0 || successRate > 100 ||
            !Number.isFinite(averageLatencyMs) || averageLatencyMs < 0) continue;
        models[id] = { successRate, averageLatencyMs };
      }
      snapshot = { updatedAt: new Date(now()).toISOString(), stale: false, models };
    } catch {
      snapshot = { ...snapshot, stale: true };
    }
    return snapshot;
  }

  return function getDopePerformance() {
    if (pending) return pending;
    if (now() < refreshAfter) return Promise.resolve(snapshot);
    refreshAfter = now() + REFRESH_MS;
    pending = refresh().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createDopePerformance };

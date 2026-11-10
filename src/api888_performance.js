'use strict';

const { Api888Client } = require('./provider/api888.js');

const REFRESH_MS = 10 * 60 * 1000;

function createApi888Performance({ clientForKey = apiKey => new Api888Client({ apiKey }), now = Date.now } = {}) {
  let current;
  const empty = () => ({ updatedAt: null, stale: true, models: {} });

  return async function getApi888Performance(apiKey) {
    if (!apiKey) {
      current = null;
      return empty();
    }
    if (current?.key !== apiKey) current = { key: apiKey, snapshot: empty(), refreshAfter: 0 };
    const state = current;
    if (state.pending) return state.pending;
    if (now() < state.refreshAfter) return state.snapshot;
    state.refreshAfter = now() + REFRESH_MS;
    state.pending = (async () => {
      try {
        const data = await clientForKey(apiKey).modelStatus();
        const models = {};
        for (const row of data.models) {
          if (!row?.on_sale || typeof row.model_name !== 'string' || !row.model_name || row.model_name.length >= 192) continue;
          const id = 'api888_' + row.model_name.replace(/[^a-zA-Z0-9]/g, '_');
          const successRate = Number.isFinite(row.success_rate) && row.success_rate >= 0 && row.success_rate <= 100 ? row.success_rate : null;
          const averageLatencyMs = Number.isFinite(row.avg_duration_ms) && row.avg_duration_ms >= 0 ? row.avg_duration_ms : null;
          if (successRate !== null || averageLatencyMs !== null) models[id] = { successRate, averageLatencyMs };
        }
        const updated = new Date(Number(data.updated_at) * 1000);
        const updatedAt = Number.isFinite(updated.getTime()) && updated.getTime() > 0 ? updated.toISOString() : null;
        state.snapshot = { updatedAt, stale: false, models };
      } catch (error) {
        state.refreshAfter = Math.max(state.refreshAfter, now() + (error.retryAfterMs || 0));
        state.snapshot = { ...state.snapshot, stale: true };
      }
      return state.snapshot;
    })().finally(() => { state.pending = null; });
    return state.pending;
  };
}

module.exports = { createApi888Performance, getApi888Performance: createApi888Performance() };

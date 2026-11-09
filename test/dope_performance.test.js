'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDopePerformance } = require('../src/dope_performance.js');

test('Dope metrics use a shared ten-minute cache and keep the last snapshot on errors', async () => {
  let now = 0;
  let requests = 0;
  const get = createDopePerformance({
    now: () => now,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.wxksai.com/api/perf-metrics/summary?hours=24');
      assert.equal(options.headers.authorization, undefined);
      requests++;
      if (requests === 2) return new Response(null, { status: 503 });
      return Response.json({ success: true, data: { models: requests === 3 ? [] : [
        { model_name: 'seedance-2.5-special2', success_rate: 0, avg_latency_ms: 3100000 },
        { model_name: 'sd 2.5掺水板', success_rate: 91.75, avg_latency_ms: 4283930 },
        { model_name: 'unrelated-model', success_rate: 100, avg_latency_ms: 100 },
        { model_name: 'wan3.0-video', success_rate: null, avg_latency_ms: 0 },
      ] } });
    },
  });

  const [first, second] = await Promise.all([get(), get()]);
  assert.equal(requests, 1);
  assert.equal(first, second);
  assert.deepEqual(first.models, {
    dope_seedance_2_5_special2: { successRate: 0, averageLatencyMs: 3100000 },
    dope_sd25_value: { successRate: 91.75, averageLatencyMs: 4283930 },
  });
  now = 599999;
  assert.equal(await get(), first);
  now = 600000;
  assert.deepEqual(await get(), { ...first, stale: true });
  assert.equal(requests, 2);
  now = 1200000;
  assert.deepEqual(await get(), {
    updatedAt: new Date(now).toISOString(), stale: false, models: {},
  });
  assert.equal(requests, 3);
});

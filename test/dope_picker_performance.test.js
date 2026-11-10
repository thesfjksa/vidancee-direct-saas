'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

test('picker sorts successful models by latency without changing their native indexes', async () => {
  const makeCard = (index, id) => {
    const metric = id && { dataset: { dopePerformance: id }, hasAttribute: () => true };
    return { metric, dataset: { index: String(index) }, matches: () => true, querySelector: () => metric };
  };
  const mini = makeCard(0, 'dope_mini');
  const zero = makeCard(2, 'dope_zero');
  const ready = makeCard(3, 'dope_ready');
  const fastest = makeCard(1, 'dope_fastest');
  const noStats = makeCard(4, null);
  const empty = { matches: () => false };
  const root = {
    children: [mini, fastest, zero, ready, noStats, empty],
    contains: () => false,
    insertBefore(node, anchor) {
      this.children.splice(this.children.indexOf(node), 1);
      this.children.splice(this.children.indexOf(anchor), 0, node);
    },
  };
  let finish;
  let nextRefresh;
  const window = {};
  const document = {
    querySelector: selector => selector.startsWith('#') ? root : mini.metric,
    querySelectorAll: () => [mini.metric, zero.metric, ready.metric, fastest.metric],
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/dope-performance.js'), 'utf8'), {
    window, document, clearTimeout() {}, setTimeout: callback => { nextRefresh = callback; },
    fetch: () => new Promise(resolve => {
      finish = models => resolve({ ok: true, json: async () => ({ models, stale: false }) });
    }),
  });
  assert.match(window.dopePerformanceMarkup('dope_mini', true), /Loading/);
  finish({
    dope_zero: { successRate: 0, averageLatencyMs: 500 },
    dope_ready: { successRate: 99, averageLatencyMs: 888000 },
    dope_fastest: { successRate: 70, averageLatencyMs: 1200 },
  });
  await new Promise(setImmediate);
  assert.deepEqual(root.children, [fastest, ready, zero, mini, noStats, empty]);
  assert.match(zero.metric.innerHTML, /0\.00%.*1s/);
  assert.match(mini.metric.innerHTML, /No data/);
  assert.match(window.dopePerformanceMarkup('wxksai_zero'), /0\.00% success/);
  nextRefresh();
  finish({
    dope_mini: { successRate: 99, averageLatencyMs: 1200 },
    dope_fastest: { successRate: 70, averageLatencyMs: 1200 },
  });
  await new Promise(setImmediate);
  assert.deepEqual(root.children, [mini, fastest, zero, ready, noStats, empty]);
});

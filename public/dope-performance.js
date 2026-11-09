(() => {
  'use strict';

  const refreshMs = 10 * 60 * 1000;
  const selector = '[data-dope-performance]';
  let snapshot;
  let refreshAfter = 0;
  let started = false;

  function describe(id) {
    if (!snapshot) return '24h performance · Loading…';
    const metrics = snapshot.models[id];
    if (!metrics) return snapshot.stale ? '24h performance · Unavailable' : '24h performance · No data';
    const seconds = Math.round(metrics.averageLatencyMs / 1000);
    const latency = seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
    return '24h · ' + metrics.successRate.toFixed(2) + '% success · ' + latency + ' avg latency' +
      (snapshot.stale ? ' · Last known' : '');
  }

  async function refresh() {
    if (Date.now() < refreshAfter) return;
    refreshAfter = Date.now() + refreshMs;
    try {
      const response = await fetch('/api/dope-performance', { cache: 'no-store' });
      if (!response.ok) throw new Error('Performance unavailable');
      const next = await response.json();
      if (!next?.models || typeof next.models !== 'object') throw new Error('Invalid performance response');
      snapshot = next;
    } catch {
      snapshot = { models: {}, ...snapshot, stale: true };
    }
    for (const node of document.querySelectorAll(selector)) {
      node.textContent = describe(node.dataset.dopePerformance);
      node.title = snapshot.updatedAt ? 'Dope metrics checked ' + new Date(snapshot.updatedAt).toLocaleString() : '';
    }
  }

  window.dopePerformanceMarkup = function (modelId) {
    const id = String(modelId || '').replace(/^wxksai_/, 'dope_');
    if (!/^dope_[a-z0-9_]+$/.test(id)) return '';
    if (!started) {
      started = true;
      setInterval(() => {
        if (document.querySelector(selector)) void refresh();
      }, refreshMs);
    }
    void refresh();
    return '<small class="muted" style="display:block" data-dope-performance="' + id + '">' + describe(id) + '</small>';
  };
})();

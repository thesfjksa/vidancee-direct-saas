(() => {
  'use strict';

  const refreshMs = 10 * 60 * 1000;
  const selector = '[data-dope-performance]';
  let snapshot;
  let refreshAfter = 0;
  let refreshTimer;
  let refreshing = false;

  function describe(id, card = false) {
    const heading = '24h performance';
    const metrics = snapshot?.models[id];
    if (!metrics) {
      const status = !snapshot ? 'Loading…' : snapshot.stale ? 'Unavailable' : 'No data';
      return card ? '<span class="model-picker-performance-heading">' + heading +
        '</span><span>' + status + '</span>' : heading + ' · ' + status;
    }
    const seconds = Math.round(metrics.averageLatencyMs / 1000);
    const latency = seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
    const success = metrics.successRate.toFixed(2) + '%';
    if (card) {
      return '<span class="model-picker-performance-heading">' + heading + '</span>' +
        '<span class="model-picker-metric">Success <strong>' + success + '</strong></span>' +
        '<span class="model-picker-metric">Avg latency <strong>' + latency + '</strong></span>' +
        (snapshot.stale ? '<span class="model-picker-performance-stale">Last known</span>' : '');
    }
    return '24h · ' + success + ' success · ' + latency + ' avg latency' +
      (snapshot.stale ? ' · Last known' : '');
  }

  function sortOptions(root) {
    if (!root) return;
    const items = [...root.children].filter(item => item.matches('.custom-select-option')).map(item => ({
      item,
      metrics: snapshot?.models[item.querySelector('[data-dope-performance-card]')?.dataset.dopePerformance],
    }));
    const tier = metrics => metrics?.successRate > 0 ? 0 : metrics ? 1 : 2;
    const latency = metrics => metrics?.averageLatencyMs ?? Infinity;
    items.sort((a, b) => tier(a.metrics) - tier(b.metrics) ||
      latency(a.metrics) - latency(b.metrics) ||
      (b.metrics?.successRate ?? -1) - (a.metrics?.successRate ?? -1) ||
      Number(a.item.dataset.index) - Number(b.item.dataset.index));
    const focused = document.activeElement;
    items.forEach(({ item }, index) => {
      if (root.children[index] !== item) root.insertBefore(item, root.children[index]);
    });
    if (root.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  async function refresh() {
    if (refreshing || Date.now() < refreshAfter) return;
    refreshing = true;
    clearTimeout(refreshTimer);
    try {
      const response = await fetch('/api/dope-performance', { cache: 'no-store' });
      if (!response.ok) throw new Error('Performance unavailable');
      const next = await response.json();
      if (!next?.models || typeof next.models !== 'object') throw new Error('Invalid performance response');
      snapshot = next;
    } catch {
      snapshot = { models: {}, ...snapshot, stale: true };
    } finally {
      refreshing = false;
      refreshAfter = Date.now() + refreshMs;
      refreshTimer = setTimeout(() => {
        refreshAfter = 0;
        if (document.querySelector(selector)) void refresh();
      }, refreshMs);
    }
    for (const node of document.querySelectorAll(selector)) {
      if (node.hasAttribute('data-dope-performance-card')) node.innerHTML = describe(node.dataset.dopePerformance, true);
      else node.textContent = describe(node.dataset.dopePerformance);
      node.title = snapshot.updatedAt ? 'Dope metrics checked ' + new Date(snapshot.updatedAt).toLocaleString() : '';
    }
    sortOptions(document.querySelector('#modelPicker .model-picker-options'));
  }

  window.sortDopePerformanceOptions = sortOptions;
  window.dopePerformanceMarkup = function (modelId, card = false) {
    const id = String(modelId || '').replace(/^wxksai_/, 'dope_');
    if (!/^dope_[a-z0-9_]+$/.test(id)) return '';
    void refresh();
    if (card) return '<span class="model-picker-performance" data-dope-performance-card data-dope-performance="' +
      id + '">' + describe(id, true) + '</span>';
    return '<small class="muted" style="display:block" data-dope-performance="' + id + '">' + describe(id) + '</small>';
  };
})();

(() => {
  'use strict';

  const sources = {
    dope: { refreshMs: 10 * 60 * 1000 },
    api888: { refreshMs: 10 * 60 * 1000 },
    puream: { refreshMs: 10 * 60 * 1000 },
  };
  const sourceName = id => id?.startsWith('puream_')?'puream':id?.startsWith('api888_')?'api888':'dope';
  const sourceFor = id => sources[sourceName(id)];
  const metricsFor = id => sourceFor(id).snapshot?.models[id];

  function describe(id, card = false) {
    const heading = sourceName(id)==='puream'?'24h CMMTools performance':'24h performance';
    const { snapshot } = sourceFor(id);
    const metrics = metricsFor(id);
    if (!metrics) {
      const status = !snapshot ? 'Loading…' : snapshot.stale ? 'Unavailable' : 'No data';
      return card ? '<span class="model-picker-performance-heading">' + heading +
        '</span><span>' + status + '</span>' : heading + ' · ' + status;
    }
    const seconds = Math.round(metrics.averageLatencyMs / 1000);
    const latency = metrics.averageLatencyMs === null ? '—' :
      seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
    const success = metrics.successRate === null ? '—' : metrics.successRate.toFixed(2) + '%';
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
    const children = [...root.children];
    // Keep section headers/disclosures in place and rank options only within
    // their original list. A Puream metric must never pull a card out of New.
    const positions = children.map((item,index) => item.matches('.custom-select-option') ? index : -1).filter(index=>index>=0);
    const items = positions.map(index => children[index]).map(item => ({
      item,
      metrics: metricsFor(item.querySelector('[data-dope-performance-card]')?.dataset.dopePerformance),
    }));
    // Fast failures must not outrank successful jobs.
    const tier = metrics => metrics?.successRate > 0 ? 0 : metrics ? 1 : 2;
    const latency = metrics => metrics?.averageLatencyMs ?? Infinity;
    items.sort((a, b) => tier(a.metrics) - tier(b.metrics) ||
      latency(a.metrics) - latency(b.metrics) ||
      (b.metrics?.successRate ?? -1) - (a.metrics?.successRate ?? -1) ||
      Number(a.item.dataset.index) - Number(b.item.dataset.index));
    const focused = document.activeElement;
    items.forEach(({ item }, index) => {
      if (root.children[positions[index]] !== item) root.insertBefore(item, root.children[positions[index]]);
    });
    if (focused && root.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
    for(const child of children){
      if(child.matches('.model-picker-new-group'))sortOptions(child.querySelector('.model-picker-group-options'));
    }
  }

  async function refresh(name) {
    const state = sources[name];
    if (state.refreshing || Date.now() < (state.refreshAfter || 0)) return;
    state.refreshing = true;
    clearTimeout(state.refreshTimer);
    const sourceSelector = '[data-dope-performance^="' + name + '_"]';
    try {
      const response = await fetch('/api/' + name + '-performance', { cache: 'no-store' });
      if (!response.ok) throw new Error('Performance unavailable');
      const next = await response.json();
      if (!next?.models || typeof next.models !== 'object') throw new Error('Invalid performance response');
      state.snapshot = next;
    } catch {
      state.snapshot = { models: {}, ...state.snapshot, stale: true };
    } finally {
      state.refreshing = false;
      state.refreshAfter = Date.now() + state.refreshMs;
      state.refreshTimer = setTimeout(() => {
        state.refreshAfter = 0;
        if (document.querySelector(sourceSelector)) void refresh(name);
      }, state.refreshMs);
    }
    for (const node of document.querySelectorAll(sourceSelector)) {
      if (node.hasAttribute('data-dope-performance-card')) node.innerHTML = describe(node.dataset.dopePerformance, true);
      else node.textContent = describe(node.dataset.dopePerformance);
      const updatedAt = state.snapshot.updatedAt;
      node.title = updatedAt ? 'Performance updated ' + new Date(updatedAt).toLocaleString() : '';
    }
    sortOptions(document.querySelector('#modelPicker .model-picker-options'));
    sortOptions(document.querySelector('#imageModelPicker .model-picker-options'));
  }

  window.sortDopePerformanceOptions = sortOptions;
  window.modelPerformanceMarkup = window.dopePerformanceMarkup = function (modelId, card = false) {
    const id = String(modelId || '').replace(/^wxksai_/, 'dope_');
    if (!/^(dope|api888|puream)_[a-zA-Z0-9_]+$/.test(id)) return '';
    void refresh(sourceName(id));
    if (card) return '<span class="model-picker-performance" data-dope-performance-card data-dope-performance="' +
      id + '">' + describe(id, true) + '</span>';
    return '<small class="muted" style="display:block" data-dope-performance="' + id + '">' + describe(id) + '</small>';
  };
})();

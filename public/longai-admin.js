'use strict';

(() => {
  const rows = new Map();
  const results = new Map();
  let catalog;
  let busy = false;

  function updateControls() {
    $('longAiVideoRefresh').disabled = busy;
    $('longAiVideoCheckAll').disabled = busy || !catalog?.keyConfigured || !catalog.models.some(model => model.sellers > 0);
    for (const row of rows.values()) row.querySelector('button').disabled = busy || !catalog.keyConfigured;
  }

  function showResult(id, result) {
    const cell = rows.get(id)?.cells[2];
    if (!cell) return;
    const status = {
      checking: 'Checking…',
      visible: 'Visible to saved key',
      not_visible: 'Model access not confirmed',
      key_rejected: 'Saved key rejected',
      error: 'Check failed',
    }[result?.status] || 'Not checked';
    const details = [
      result?.providerStatus && 'HTTP ' + result.providerStatus,
      result?.networkCode,
      Number.isFinite(result?.elapsedMs) && result.elapsedMs + ' ms',
    ].filter(Boolean);
    cell.textContent = [status, ...details].join(' · ');
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    updateControls();
    const progress = $('longAiVideoProgress');
    progress.textContent = 'Loading LONG AI video listings…';
    try {
      catalog = await api('/admin/longai/video-tests');
      $('longAiVideoSource').textContent = catalog.source === 'marketplace'
        ? 'Public marketplace retrieved ' + fmt(catalog.fetchedAt) + '.'
        : 'Marketplace refresh failed. Showing the ' + catalog.snapshotDate + ' snapshot. Seller counts may have changed.';
      rows.clear();
      const table = $('longAiVideoRows');
      table.replaceChildren();
      for (const model of catalog.models) {
        const row = table.insertRow();
        row.insertCell().textContent = model.id;
        row.insertCell().textContent = model.sellers ? String(model.sellers) : 'None listed';
        row.insertCell();
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Check key';
        button.setAttribute('aria-label', 'Check key for ' + model.id);
        button.addEventListener('click', () => check([model]));
        row.insertCell().append(button);
        rows.set(model.id, row);
        showResult(model.id, results.get(model.id));
      }
      const listed = catalog.models.filter(model => model.sellers > 0).length;
      progress.textContent = catalog.keyConfigured
        ? listed + ' of ' + catalog.models.length + ' video models have a listed seller.'
        : 'Save a LONG AI key in Provider to check model access.';
    } catch (error) {
      progress.textContent = error.message;
    } finally {
      busy = false;
      updateControls();
    }
  }

  async function check(models) {
    if (busy || !catalog?.keyConfigured || !models.length) return;
    busy = true;
    updateControls();
    const progress = $('longAiVideoProgress');
    let next = 0, checked = 0, visible = 0, keyRejected = false;
    progress.textContent = 'Checking 0 of ' + models.length + ' models…';
    async function checkNext() {
      while (!keyRejected && next < models.length) {
        const { id } = models[next++];
        showResult(id, { status: 'checking' });
        let result;
        try {
          result = await api('/admin/longai/video-tests/model?model=' + encodeURIComponent(id));
        } catch {
          result = { status: 'error' };
        }
        results.set(id, result);
        showResult(id, result);
        if (result.status === 'visible') visible++;
        if (result.status === 'key_rejected') keyRejected = true;
        progress.textContent = 'Checked ' + ++checked + ' of ' + models.length + ' models…';
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(3, models.length) }, checkNext));
      progress.textContent = checked + ' of ' + models.length + ' checked · ' + visible + ' visible to the saved key.' +
        (keyRejected ? ' LONG AI rejected the saved key.' : '');
    } finally {
      busy = false;
      updateControls();
    }
  }

  $('longAiVideoRefresh').addEventListener('click', refresh);
  $('longAiVideoCheckAll').addEventListener('click', () => check(catalog.models.filter(model => model.sellers > 0)));
  window.openLongAiVideoTests = () => { if (!catalog) refresh(); };
})();

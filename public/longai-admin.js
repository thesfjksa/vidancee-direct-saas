'use strict';

(() => {
  const rows = new Map();
  const results = new Map();
  const renderEndpoint = '/admin/longai/video-tests/renders';
  const activeStates = new Set(['queued', 'submitting', 'accepted']);
  let catalog;
  let busy = false;
  let renderTests = [];
  let paidEnabled = false;
  let startingRender = false;
  let renderRefresh;
  let renderTimer;

  function updateControls() {
    $('longAiVideoRefresh').disabled = busy;
    $('longAiVideoCheckAll').disabled = busy || !catalog?.keyConfigured || !catalog.models.some(model => model.sellers > 0);
    const activeRender = renderTests.some(test => activeStates.has(test.status));
    for (const model of catalog?.models || []) {
      const row = rows.get(model.id);
      if (!row) continue;
      row.querySelector('[data-key-check]').disabled = busy || !catalog.keyConfigured;
      row.querySelector('[data-render-test]').disabled = startingRender || activeRender || !paidEnabled ||
        catalog.source !== 'marketplace' || model.sellers < 1;
    }
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

  function showRenderResults() {
    for (const [model, row] of rows) {
      const test = renderTests.find(item => item.model === model);
      const status = {
        queued: 'Queued',
        submitting: 'Submitting once',
        accepted: 'Accepted · awaiting video',
        verified: 'Render verified',
        submit_failed: 'Submission failed',
        submission_unknown: 'Submission unconfirmed',
        render_failed: 'Render failed after acceptance',
        output_unverified: 'Output unverified',
        expired: 'Test expired',
      }[test?.status] || 'Not tested';
      row.cells[3].textContent = [
        status, test?.providerStatus && 'HTTP ' + test.providerStatus, test?.diagnostic,
        test?.taskId && 'Task ' + test.taskId, test?.providerRequestId && 'Request ' + test.providerRequestId,
        test?.createdAt && fmt(test.createdAt),
      ].filter(Boolean).join(' · ');
    }
    updateControls();
  }

  function refreshRenders() {
    clearTimeout(renderTimer);
    if (renderRefresh) return renderRefresh;
    renderRefresh = api(renderEndpoint).then(data => {
      renderTests = data.tests;
      paidEnabled = data.paidEnabled;
      const progress = $('longAiRenderProgress');
      const disabled = 'Paid tests require an enabled LONG AI connection and paid provider submissions.';
      if (!paidEnabled && !startingRender) progress.textContent = disabled;
      if (paidEnabled && progress.textContent === disabled) progress.textContent = '';
      showRenderResults();
    }).catch(error => {
      paidEnabled = false;
      updateControls();
      $('longAiRenderProgress').textContent = error.message;
    }).finally(() => {
      renderRefresh = null;
      if (renderTests.some(test => activeStates.has(test.status))) {
        renderTimer = setTimeout(() => {
          if ($('longAiVideoTests').classList.contains('active')) refreshRenders();
        }, 5000);
      }
    });
    return renderRefresh;
  }

  async function startRender(model) {
    if (startingRender || !paidEnabled || catalog.source !== 'marketplace' || model.sellers < 1 ||
        renderTests.some(test => activeStates.has(test.status))) return;
    const previous = renderTests.find(test => test.model === model.id);
    const confirmReconciled = previous?.status === 'submission_unknown';
    if (confirmReconciled && !confirm('The previous attempt was inconclusive. Continue only if you checked its status in LONG AI history.')) return;
    if (!confirm('Start one paid LONG AI render for ' + model.id +
      '? This uses provider defaults and can charge the saved LONG AI account.')) return;
    const id = crypto.randomUUID();
    const progress = $('longAiRenderProgress');
    startingRender = true;
    updateControls();
    try {
      const { test } = await api(renderEndpoint, {
        method: 'POST', body: JSON.stringify({ id, model: model.id, confirmPaid: true, confirmReconciled }),
      });
      renderTests = [test, ...renderTests.filter(item => item.id !== test.id)];
      progress.textContent = 'Queued one paid render for ' + model.id + '.';
      showRenderResults();
    } catch (error) {
      progress.textContent = error.message + ' Check the latest render result before starting another test.';
    } finally {
      await renderRefresh;
      await refreshRenders();
      startingRender = false;
      updateControls();
    }
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
        row.insertCell();
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Check key';
        button.dataset.keyCheck = '';
        button.setAttribute('aria-label', 'Check key for ' + model.id);
        button.addEventListener('click', () => check([model]));
        const renderButton = document.createElement('button');
        renderButton.type = 'button';
        renderButton.className = 'secondary';
        renderButton.dataset.renderTest = '';
        renderButton.textContent = 'Paid render test';
        renderButton.setAttribute('aria-label', 'Paid render test for ' + model.id);
        renderButton.addEventListener('click', () => startRender(model));
        row.insertCell().append(button, ' ', renderButton);
        rows.set(model.id, row);
        showResult(model.id, results.get(model.id));
      }
      showRenderResults();
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

  $('longAiVideoRefresh').addEventListener('click', () => { refresh(); refreshRenders(); });
  $('longAiVideoCheckAll').addEventListener('click', () => check(catalog.models.filter(model => model.sellers > 0)));
  window.openLongAiVideoTests = () => { if (!catalog) refresh(); refreshRenders(); };
})();

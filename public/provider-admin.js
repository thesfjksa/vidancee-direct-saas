'use strict';

// Navigation only changes visibility. Inputs stay mounted so switching
// providers or tabs never discards an unsaved key, name or price edit.
(() => {
  const el = id => document.getElementById(id);
  const loaded = new Set();
  const pages = new Map();
  const sources = {
    aivid: null, argolink: 'argo', api888: 'api888', higgsfield: 'higgsfield',
    longai: 'longai', sluice: 'sluice', vidancee: 'vidancee', vercel: 'vercel', smartaipi: 'smart',
    vgenv: 'vgenv', fal: 'fal', vibi: 'vibi', enhancer: 'enhancer',
  };
  let currentView = 'connections', currentCatalog = 'names', initialized = false;
  function selectTabs(prefix, current, keys) {
    keys.forEach(key => {
      const button = el(prefix + 'tab-' + key), panel = el(prefix + (prefix === 'provider-' ? 'view-' : '') + key);
      button.setAttribute('aria-selected', String(key === current));
      button.tabIndex = key === current ? 0 : -1;
      panel.hidden = key !== current;
    });
  }
  window.refreshProviderDirectory = () => {
    Object.entries(sources).forEach(([key, prefix]) => {
      const status = el('provider-nav-status-' + key);
      if (!status) return;
      if (key === 'aivid') {
        const text = el('aividConnectionBadge').textContent.toLowerCase();
        status.textContent = /verified|^connected$/.test(text) ? 'Connected' : /progress|verifying/.test(text) ? 'Signing in' : 'Setup';
        status.classList.toggle('is-on', status.textContent === 'Connected');
      } else {
        const enabled = el(prefix + 'Enabled')?.checked;
        const secret = el(prefix + 'SecretStatus')?.textContent || '';
        const configured = secret.includes('configured') && !secret.includes('not configured');
        status.textContent = !configured ? 'Needs setup' : enabled ? 'On' : 'Off';
        status.classList.toggle('is-on', configured && enabled);
      }
    });
  };
  window.selectProviderSource = key => {
    if (!Object.hasOwn(sources, key)) return;
    document.querySelectorAll('[data-provider-source]').forEach(card => { card.hidden = card.dataset.providerSource !== key; });
    document.querySelectorAll('[data-source-key]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sourceKey === key)));
    el('providerSourceSelect').value = key;
    el('providerSaveFooter').hidden = key === 'aivid';
    if (key === 'longai') loadLongAiPrices();
  };
  window.filterProviderSources = () => {
    const query = el('providerSourceSearch').value.trim().toLowerCase();
    let count = 0;
    document.querySelectorAll('[data-source-key]').forEach(button => {
      button.hidden = !button.dataset.search.includes(query);
      if (!button.hidden) count++;
    });
    el('providerSourceEmpty').hidden = count > 0;
  };
  window.showProviderCatalog = key => {
    if (!['names', 'argolink', 'vercel'].includes(key)) return;
    currentCatalog = key;
    selectTabs('provider-catalog-', key, ['names', 'argolink', 'vercel']);
    if (!loaded.has(key)) {
      loaded.add(key);
      ({ names: loadModelNames, argolink: loadArgoModels, vercel: loadVercelModels })[key]();
    }
  };
  window.showProviderView = key => {
    if (!['connections', 'models', 'usage', 'advanced'].includes(key)) return;
    currentView = key;
    selectTabs('provider-', key, ['connections', 'models', 'usage', 'advanced']);
    if (key === 'models') window.showProviderCatalog(currentCatalog);
    else if (key === 'usage' && !loaded.has('usage')) { loaded.add('usage'); loadProviderUsage(); }
    else if (key === 'advanced' && !loaded.has('advanced')) { loaded.add('advanced'); loadConnectorAdmin(); loadProviderConfig(); }
  };
  function keyboardTabs(list) {
    list.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...list.querySelectorAll('[role="tab"]')];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click(); buttons[next].focus();
    });
  }
  window.openProviderWorkspace = () => {
    if (!initialized) {
      initialized = true;
      document.querySelectorAll('#provider [role="tablist"]').forEach(keyboardTabs);
      new MutationObserver(window.refreshProviderDirectory).observe(el('providerSourceCards'), { childList: true, subtree: true });
      window.selectProviderSource('aivid');
      loadProviderSettings();
    }
    window.showProviderView(currentView);
    window.refreshProviderDirectory();
  };
  window.providerPageRows = (kind, rows, filterKey = '') => {
    let state = pages.get(kind);
    if (!state) { state = { page: 0, size: 10, filterKey }; pages.set(kind, state); }
    if (state.filterKey !== filterKey) { state.page = 0; state.filterKey = filterKey; }
    const pageCount = Math.max(1, Math.ceil(rows.length / state.size));
    state.page = Math.max(0, Math.min(state.page, pageCount - 1));
    const start = state.page * state.size, end = Math.min(start + state.size, rows.length);
    const footer = el('provider-pager-' + kind);
    footer.innerHTML = '<span>' + (rows.length ? (start + 1) + '–' + end + ' of ' + rows.length + ' models' : '0 models') + '</span>' +
      '<div class="provider-page-actions"><label>Rows <select aria-label="Rows per page" onchange="providerSetPageSize(\'' + kind + '\',this.value)">' + [10, 25, 50].map(n => '<option' + (state.size === n ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>' +
      '<button class="secondary" onclick="providerChangeModelPage(\'' + kind + '\',-1)" ' + (!state.page ? 'disabled' : '') + '>Previous</button><span>Page ' + (state.page + 1) + ' of ' + pageCount + '</span>' +
      '<button class="secondary" onclick="providerChangeModelPage(\'' + kind + '\',1)" ' + (state.page + 1 >= pageCount ? 'disabled' : '') + '>Next</button></div>';
    return rows.slice(start, end);
  };
  function renderPage(kind) {
    ({ names: renderModelNames, argolink: renderArgoModels, vercel: renderVercelModels })[kind]();
    el('provider-pager-' + kind).previousElementSibling.scrollTop = 0;
  }
  window.providerChangeModelPage = (kind, direction) => {
    const state = pages.get(kind); if (!state) return;
    state.page += direction; renderPage(kind);
  };
  window.providerSetPageSize = (kind, size) => {
    const state = pages.get(kind); if (!state || ![10, 25, 50].includes(Number(size))) return;
    state.size = Number(size); state.page = 0; renderPage(kind);
  };
})();

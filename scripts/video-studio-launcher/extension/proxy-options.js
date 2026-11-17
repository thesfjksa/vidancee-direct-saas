'use strict';
const proxyId = id => document.getElementById(id);
let proxyRows = [], proxyBusy = false;
function proxyRequest(type, extra = {}) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage({type, ...extra}, response => {
    const error = chrome.runtime.lastError;
    if (error || !response?.ok) reject(Error(error?.message || response?.error || 'Connection settings failed.'));
    else resolve(response.result);
  }));
}
function proxyNotice(message) { proxyId('proxyStatus').textContent = message; }
function proxyRow(server = {}) {
  if (proxyRows.length >= 5) { proxyNotice('Up to five servers are supported.'); return; }
  const node = document.createElement('div'); node.className = 'proxy-server';
  const row = {node, fields: {}};
  for (const [key, label, type] of [['label','Server name','text'], ['scheme','Protocol','select'], ['host','Hostname or IPv4 address','text'], ['port','Port','number'], ['username','Proxy username (optional)','text'], ['password','Proxy password (optional)','password']]) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    const field = document.createElement(type === 'select' ? 'select' : 'input');
    if (type === 'select') for (const value of ['http','https','socks5']) {
      const option = document.createElement('option'); option.value = value; option.textContent = value.toUpperCase(); field.appendChild(option);
    }
    else {field.type = type; field.autocomplete = 'off'; field.spellcheck = false;}
    if (key === 'port') {field.min = '1'; field.max = '65535';}
    field.value = server[key] ?? (key === 'scheme' ? 'http' : '');
    if (['username','password'].includes(key)) field.maxLength = key === 'password' ? 1024 : 256;
    row.fields[key] = field; wrapper.appendChild(field); node.appendChild(wrapper);
  }
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove server';
  remove.addEventListener('click', () => { if (proxyBusy) return; proxyRows = proxyRows.filter(r => r !== row); node.remove(); });
  node.appendChild(remove); proxyId('proxyServers').appendChild(node); proxyRows.push(row);
}
function showProxyConfig(config) {
  proxyRows = []; proxyId('proxyServers').replaceChildren();
  proxyId('proxyEnabled').checked = config.enabled;
  proxyId('proxyIncludeDirect').checked = config.includeDirect;
  proxyId('proxyDirectConfirmed').checked = config.directNetworkConfirmed;
  config.servers.forEach(proxyRow);
}
async function proxyAction(action) {
  if (proxyBusy) return;
  proxyBusy = true;
  for (const id of ['proxySave','proxyAdd','proxyForget','proxyDisconnect','webshareImport','webshareApiKey','webshareCountry']) proxyId(id).disabled = true;
  try { await action(); } catch (error) { proxyNotice(error.message); }
  finally {proxyBusy = false; for (const id of ['proxySave','proxyAdd','proxyForget','proxyDisconnect','webshareImport','webshareApiKey','webshareCountry']) proxyId(id).disabled = false;}
}
proxyId('proxyAdd').addEventListener('click', () => proxyRow());
proxyId('proxySave').addEventListener('click', () => {
  if (proxyBusy) return;
  // Request optional permissions directly in the user gesture before other awaits.
  const grant = proxyId('proxyEnabled').checked ? chrome.permissions.request({permissions: ['proxy','webRequest','webRequestAuthProvider']}) : Promise.resolve(true);
  void proxyAction(async () => {
    if (!await grant) throw Error('Proxy permission was not granted. Automatic connection remains unchanged.');
    const config = {enabled: proxyId('proxyEnabled').checked, includeDirect: proxyId('proxyIncludeDirect').checked,
      directNetworkConfirmed: proxyId('proxyDirectConfirmed').checked,
      servers: proxyRows.map(row => Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, key === 'port' ? Number(field.value) : field.value])))};
    await proxyRequest('CMMTOOLS_PROXY_SAVE', {config});
    proxyNotice('Saved. Click Open Video Studio to test and select a route. Close any existing Studio/AIVID tabs first.');
  });
});
proxyId('proxyForget').addEventListener('click', () => void proxyAction(async () => {
  await proxyRequest('CMMTOOLS_PROXY_SAVE', {config: {enabled: false, includeDirect: false, directNetworkConfirmed: false, servers: []}});
  showProxyConfig({enabled:false, includeDirect:false, directNetworkConfirmed:false, servers:[]}); proxyNotice('Proxy servers and credentials removed.');
}));
proxyId('proxyDisconnect').addEventListener('click', () => void proxyAction(async () => {
  await proxyRequest('CMMTOOLS_PROXY_DISCONNECT'); proxyNotice('Disconnected. Browser defaults restored. Close Studio and reopen to connect again.');
}));
proxyRequest('CMMTOOLS_PROXY_CONFIG').then(async config => {
  showProxyConfig(config);
  const state = await proxyRequest('CMMTOOLS_PROXY_STATUS');
  proxyNotice(state.label + (state.ms ? ' · ' + state.ms + ' ms at last test' : '') + '\n' + (state.samples || []).map(s => s.label + ': ' + (s.ms === null ? 'failed' : s.ms + ' ms')).join('\n'));
}).catch(error => proxyNotice(error.message));

proxyId('webshareImport').addEventListener('click', () => {
  if (proxyBusy) return;
  const apiKey = proxyId('webshareApiKey').value.trim();
  const country = proxyId('webshareCountry').value.trim();
  proxyId('webshareApiKey').value = '';
  if (!apiKey) {proxyNotice('Enter your Webshare API key first.'); return;}
  const grant = chrome.permissions.request({origins:['https://proxy.webshare.io/*']});
  void proxyAction(async () => {
    if (!await grant) throw Error('Webshare API access was not granted. Your saved servers are unchanged.');
    proxyNotice('Importing Webshare proxies…');
    const imported = await proxyRequest('CMMTOOLS_WEBSHARE_IMPORT', {apiKey, country});
    proxyRows = []; proxyId('proxyServers').replaceChildren();
    imported.servers.forEach(proxyRow);
    proxyNotice('Imported ' + imported.servers.length + ' Webshare proxies. Review them, enable automatic connection if wanted, then Save connection settings. Your API key was not saved.');
  });
});
window.addEventListener('pagehide', () => {proxyId('webshareApiKey').value = '';});

'use strict';
// A local status indicator, not a claim of device-wide encryption or anonymity.
const connectionBadge = document.createElement('button');
connectionBadge.type = 'button';
connectionBadge.textContent = 'Connection settings';
connectionBadge.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:2147483647;background:#0b253e;color:#edf5ff;border:1px solid #497288;border-radius:8px;padding:9px 12px;font:12px system-ui;max-width:300px;cursor:pointer';
connectionBadge.addEventListener('click', () => chrome.runtime.sendMessage({type:'CMMTOOLS_OPEN_SETTINGS'}));
function updateConnectionBadge() {
  if (!document.body) return;
  if (!connectionBadge.isConnected) document.body.appendChild(connectionBadge);
  chrome.runtime.sendMessage({type:'CMMTOOLS_PROXY_STATUS'}, response => {
    if (chrome.runtime.lastError || !response?.ok) return;
    const state = response.result;
    connectionBadge.textContent = state.phase === 'active' ? state.label + (state.ms ? ' · ' + state.ms + ' ms tested' : '') : state.label || 'Browser default';
    connectionBadge.title = 'AIVID domain route in this browser profile. Click for connection settings.';
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateConnectionBadge, {once:true});
else updateConnectionBadge();
const connectionTimer = setInterval(updateConnectionBadge, 10000);
window.addEventListener('pagehide', () => clearInterval(connectionTimer));

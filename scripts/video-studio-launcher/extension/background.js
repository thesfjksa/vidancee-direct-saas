'use strict';
importScripts('proxy-core.js', 'proxy-manager.js', 'managed-proxy.js');
const STUDIO_URL = 'https://aivid.dev/';
const START_PAGE = chrome.runtime.getURL('loading.html');
const OPTIONS_PAGE = chrome.runtime.getURL('options.html');
const ownPage = sender => [START_PAGE, OPTIONS_PAGE, chrome.runtime.getURL('launcher.html')].includes(sender.url);
const manager = new CMMProxyManager(chrome);
const managed = new CMMManagedProxy(chrome,manager);
const ready = manager.initialize();
// An initialization error blocks launch rather than leaking through a stale route.
ready.catch(() => {});
let pendingLaunch = null;

async function launchStudio() {
  if (pendingLaunch) return pendingLaunch;
  pendingLaunch = (async () => {
    await ready;
    const stored = await chrome.storage.session.get('studioWindowId');
    if (Number.isInteger(stored.studioWindowId)) {
      try {
        await chrome.windows.update(stored.studioWindowId, {focused: true});
        return {reused: true};
      } catch { /* Window no longer exists. */ }
    }
    const created = await chrome.windows.create({url: START_PAGE, type: 'popup', focused: true, incognito: false, width: 1350, height: 860});
    if (!created || !Number.isInteger(created.id)) throw Error('Browser could not create the Video Studio window.');
    await chrome.storage.session.set({studioWindowId: created.id});
    return {reused: false};
  })();
  try { return await pendingLaunch; } finally { pendingLaunch = null; }
}

chrome.windows.onRemoved.addListener(windowId => {
  managed.removed(windowId);
  void (async () => {
    await ready;
    const stored = await chrome.storage.session.get('studioWindowId');
    if (stored.studioWindowId === windowId) {
      await manager.disconnect();
      await chrome.storage.session.remove('studioWindowId');
    }
  })().catch(() => {});
});
chrome.permissions.onAdded.addListener(() => manager.registerAuth());
chrome.permissions.onRemoved.addListener(() => { void manager.disconnect().catch(() => {}); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const allowedStatus = ownPage(sender) || CMMProxyCore.isStudio(sender.url);
  let task;
  if (message?.type === 'CMMTOOLS_OPEN_STUDIO' && ownPage(sender)) task = launchStudio();
  if (message?.type === 'CMMTOOLS_PROXY_STATUS' && allowedStatus) task = ready.then(() => manager.status());
  if (message?.type === 'CMMTOOLS_OPEN_SETTINGS' && allowedStatus) task = chrome.runtime.openOptionsPage();
  // Proxy settings/credentials are accessible only to the packaged options page.
  if (sender.url === OPTIONS_PAGE) {
    if (message?.type === 'CMMTOOLS_MANAGED_SAVE') task = (async()=>{
      await ready;
      if(typeof message.enabled!=='boolean'||typeof message.consent!=='boolean'||(message.enabled&&!message.consent))throw Error('Confirm the connection preference and routing notice.');
      if(message.enabled&&!await manager.permitted())throw Error('Allow proxy permissions first.');
      await manager.save({enabled:false,includeDirect:false,directNetworkConfirmed:false,servers:[]});
      await chrome.storage.local.set({managedEnabled:message.enabled,managedConsent:message.consent});
      return {saved:true};
    })();
    if (message?.type === 'CMMTOOLS_PROXY_CONFIG') task = ready.then(() => manager.config());
    if (message?.type === 'CMMTOOLS_PROXY_SAVE') task = ready.then(() => manager.save(message.config)).then(() => ({saved: true}));
    if (message?.type === 'CMMTOOLS_PROXY_DISCONNECT') task = ready.then(() => manager.disconnect());
  }
  if (message?.type === 'CMMTOOLS_START_NAVIGATION' && sender.url === START_PAGE && sender.tab) {
    task = (async () => {
      await ready;
      const {studioWindowId} = await chrome.storage.session.get('studioWindowId');
      if (sender.tab.windowId !== studioWindowId || sender.tab.incognito) throw Error('Studio popup could not be verified.');
      await managed.refresh(studioWindowId);
      const route = await manager.prepare(studioWindowId);
      // A paused loading page or cancelled launch must never navigate after closure.
      const tab = await chrome.tabs.get(sender.tab.id);
      if (tab.windowId !== studioWindowId || tab.url !== START_PAGE) throw Error('Studio launch page changed. Close Studio and reopen.');
      if (route.phase === 'error') throw Error(route.label);
      await chrome.tabs.update(sender.tab.id, {url: STUDIO_URL});
      return {route};
    })();
  }
  if (!task) return false;
  Promise.resolve(task).then(result => sendResponse({ok: true, result}), error => sendResponse({ok: false, error: error.message || 'Connection failed.'}));
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if(message?.type==='CMMTOOLS_MANAGED_CONFIG'){
    ready.then(()=>managed.accept(message,sender)).then(ok=>sendResponse({ok}),()=>sendResponse({ok:false}));return true;
  }
  if (message?.type !== 'CMMTOOLS_OPEN_AIVID') return false;
  let trusted = false;
  try { trusted = ['https://cmmtools.site', 'https://www.cmmtools.site'].includes(new URL(sender.url).origin); } catch {}
  if (!trusted) { sendResponse({ok: false, error: 'Invalid calling page.'}); return false; }
  launchStudio().then(result => sendResponse({ok: true, ...result}), () => sendResponse({ok: false, error: 'Unable to open Studio. Check Extension options.'}));
  return true;
});

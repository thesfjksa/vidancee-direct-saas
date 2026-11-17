'use strict';
(function(root) {
  const core = typeof module !== 'undefined' ? require('./proxy-core.js') : root.CMMProxyCore;
  const DEFAULTS = {enabled: false, includeDirect: false, directNetworkConfirmed: false, servers: []};
  class ProxyManager {
    constructor(api, fetcher = fetch, clock = () => performance.now(), deadline = 8000) {
      this.api = api; this.fetcher = fetcher; this.clock = clock; this.deadline = deadline;
      this.operation = null; this.disconnecting = null; this.cancelled = false; this.abort = null;
      this.attempts = new Map(); this.authRegistered = false;
    }
    async config() { return (await this.api.storage.local.get('proxyConfig')).proxyConfig || {...DEFAULTS}; }
    async state() { return (await this.api.storage.local.get('proxyConnection')).proxyConnection || {phase: 'default', label: 'Browser default'}; }
    async setState(state) { await this.api.storage.local.set({proxyConnection: state}); }
    async permitted() { return this.api.permissions.contains({permissions: core.PERMISSIONS}); }
    registerAuth() {
      if (this.authRegistered || !this.api.webRequest?.onAuthRequired) return;
      try {
        this.api.webRequest.onAuthRequired.addListener((details, done) => {
          this.authenticate(details).then(done, () => done({cancel: true}));
        }, {urls: core.URLS}, ['asyncBlocking']);
        const cleanup = details => this.attempts.delete(details.requestId);
        this.api.webRequest.onCompleted.addListener(cleanup, {urls: core.URLS});
        this.api.webRequest.onErrorOccurred.addListener(cleanup, {urls: core.URLS});
        this.authRegistered = true;
      } catch { /* Optional auth permission has not been granted yet. */ }
    }
    async authenticate(details) {
      if (!details.isProxy || !core.isStudio(details.url)) return {};
      const state = await this.state(), config = await this.config();
      const server = config.servers.find(s => s.id === state.serverId);
      if (!['testing', 'active'].includes(state.phase) || !server ||
          String(details.challenger?.host || '').toLowerCase() !== server.host || Number(details.challenger?.port) !== server.port) return {};
      if (!core.authAllowed(details, server) || this.attempts.has(details.requestId) || this.attempts.size >= 512) return {cancel: true};
      this.attempts.set(details.requestId, true);
      return {authCredentials: {username: server.username, password: server.password}};
    }
    async initialize() {
      // Content scripts must never be able to read locally saved proxy passwords.
      await this.api.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
      this.registerAuth();
      const state = await this.state();
      const session = await this.api.storage.session.get('studioWindowId');
      let live = false;
      if (state.phase === 'active' && Number.isInteger(state.windowId) && session.studioWindowId === state.windowId) {
        try { live = !(await this.api.windows.get(state.windowId)).incognito; } catch {}
      }
      if (!live) await this.disconnect();
    }
    async save(raw) {
      if (this.operation || this.disconnecting) throw Error('Wait for the connection check to finish.');
      const state = await this.state();
      if (state.windowId) {
        try { await this.api.windows.get(state.windowId); throw Error('Close the Studio window before changing connection settings.'); }
        catch (e) { if (e.message.includes('Close the Studio')) throw e; }
      }
      const config = core.normalize(raw);
      if (config.enabled && !await this.permitted()) throw Error('Allow the optional proxy permissions first.');
      await this.disconnect();
      await this.api.storage.local.set({proxyConfig: config});
      return config;
    }
    async clearOwnSetting() {
      if (await this.api.permissions.contains({permissions: ['proxy']})) await this.api.proxy.settings.clear({scope: 'regular_only'});
      await this.setState({phase: 'default', label: 'Browser default'});
      this.attempts.clear();
    }
    async disconnect() {
      if (this.disconnecting) return this.disconnecting;
      this.cancelled = true; this.abort?.abort();
      const operation = this.operation;
      this.disconnecting = (async () => { if (operation) await operation.catch(() => {}); await this.clearOwnSetting(); })();
      try { await this.disconnecting; } finally { this.disconnecting = null; }
    }
    async apply(server, windowId, phase = 'testing', samples = []) {
      if (this.cancelled) throw Error('Connection check cancelled.');
      const current = await this.api.proxy.settings.get({incognito: false});
      if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(current.levelOfControl)) throw Error('Another extension or browser policy controls proxy settings.');
      const value = core.pac(server);
      await this.setState({phase, serverId: server?.id || null, label: server?.label || 'Direct connection', windowId, samples});
      await this.api.proxy.settings.set({value, scope: 'regular_only'});
      const actual = await this.api.proxy.settings.get({incognito: false});
      if (actual.levelOfControl !== 'controlled_by_this_extension' || actual.value?.pacScript?.data !== value.pacScript.data) throw Error('Chrome did not apply the requested route.');
    }
    async probe() {
      const controller = new AbortController(); this.abort = controller;
      const timer = setTimeout(() => controller.abort(), this.deadline);
      const start = this.clock();
      try {
        const response = await this.fetcher('https://aivid.dev/?cmm_connection_check=' + Date.now() + '-' + Math.random().toString(16).slice(2), {
          method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
        });
        const ms = Math.max(1, Math.round(this.clock() - start));
        if (response.body) void response.body.cancel().catch(() => {});
        if (!response.ok) throw Error('Connection check did not return a successful response.');
        return ms;
      } finally { clearTimeout(timer); if (this.abort === controller) this.abort = null; }
    }
    async prepare(windowId) {
      if (this.disconnecting) throw Error('Wait for disconnection to finish.');
      if (this.operation) return this.operation;
      this.cancelled = false;
      this.operation = this.select(windowId);
      try { return await this.operation; } finally { this.operation = null; }
    }
    async select(windowId) {
      const config = core.normalize(await this.config());
      if (!config.enabled) return {phase: 'default', label: 'Browser default'};
      if (!await this.permitted()) throw Error('Open Extension options and allow proxy permissions.');
      this.registerAuth();
      const state = await this.state();
      if (state.phase === 'active' && state.windowId === windowId) return this.status();
      const tabs = await this.api.tabs.query({url: core.URLS});
      if (tabs.some(tab => !tab.incognito)) throw Error('Close all AIVID tabs before testing routes. This avoids changing a connection in use.');
      const current = await this.api.proxy.settings.get({incognito: false});
      if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(current.levelOfControl) ||
          (!['direct', 'system'].includes(current.value?.mode) && !core.owns(current.value))) throw Error('An existing proxy or policy is configured. Use a separate Chrome profile with direct internet.');
      const candidates = config.includeDirect ? [null, ...config.servers] : config.servers;
      const samples = [];
      try {
        for (const server of candidates) {
          if (this.cancelled) throw Error('Connection check cancelled.');
          await this.apply(server, windowId, 'testing', samples);
          let ms = null;
          try { const first = await this.probe(); const second = await this.probe(); ms = Math.round((first + second) / 2); }
          catch { /* An unsuccessful route is excluded; no raw network errors or credentials are logged. */ }
          samples.push({serverId: server?.id || null, label: server?.label || 'Direct connection', ms});
        }
        if (this.cancelled) throw Error('Connection check cancelled.');
        const best = core.pick(samples);
        if (!best) throw Error('No configured route passed. Check your proxy account and servers. Studio has not opened; there is no automatic direct fallback.');
        const server = config.servers.find(s => s.id === best.serverId) || null;
        await this.apply(server, windowId, 'testing', samples);
        await this.probe(); // Recheck the selected route before any Studio navigation.
        const window = await this.api.windows.get(windowId);
        if (window.incognito || this.cancelled) throw Error('Connection check cancelled.');
        await this.setState({phase: 'active', serverId: best.serverId, label: best.label, ms: best.ms, windowId, samples});
        return this.status();
      } catch (error) { await this.clearOwnSetting(); throw error; }
    }
    async status() {
      const state = await this.state();
      if (['active', 'testing'].includes(state.phase)) {
        const actual = await this.api.proxy.settings.get({incognito: false});
        const config = await this.config();
        const server = config.servers.find(s => s.id === state.serverId) || null;
        if (actual.levelOfControl !== 'controlled_by_this_extension' || actual.value?.pacScript?.data !== core.pac(server).pacScript.data) return {phase: 'error', label: 'Route changed outside CMMTools. Close Studio and reconnect.'};
      }
      return state; // Contains labels, endpoint IDs and timings, never auth credentials.
    }
  }
  if (typeof module !== 'undefined') module.exports = {ProxyManager, DEFAULTS};
  else root.CMMProxyManager = ProxyManager;
})(globalThis);

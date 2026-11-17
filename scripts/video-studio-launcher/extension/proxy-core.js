'use strict';
(function(root) {
  const PERMISSIONS = ['proxy', 'webRequest', 'webRequestAuthProvider'];
  const URLS = ['https://aivid.dev/*', 'https://*.aivid.dev/*'];
  const MARKER = '// CMMTOOLS_ROUTE_V1\n';
  function isStudio(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'aivid.dev' || u.hostname.endsWith('.aivid.dev')); }
    catch { return false; }
  }
  function normalize(raw = {}) {
    if (typeof raw.enabled !== 'boolean' || typeof raw.includeDirect !== 'boolean' || typeof raw.directNetworkConfirmed !== 'boolean') throw Error('Choose the connection options before saving.');
    if (!Array.isArray(raw.servers) || raw.servers.length > 5) throw Error('Add up to five proxy servers.');
    const endpoints = new Set();
    const servers = raw.servers.map((s, i) => {
      if (!s || !['http', 'https', 'socks5'].includes(s.scheme)) throw Error('Use HTTP, HTTPS or unauthenticated SOCKS5.');
      const host = String(s.host || '').trim().toLowerCase();
      if (!host || host.length > 253 || !host.split('.').every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) throw Error('Enter a proxy hostname or IPv4 address, without a URL or port.');
      const port = Number(s.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Proxy port must be between 1 and 65535.');
      const username = String(s.username || ''), password = String(s.password || '');
      if (username.length > 256 || password.length > 1024 || /[\r\n\x00]/.test(username + password)) throw Error('Proxy credentials are invalid.');
      if ((!username && password) || (s.scheme === 'socks5' && (username || password))) throw Error('SOCKS5 must use IP authorization; username/password auth is supported for HTTP(S) proxies only.');
      const id = s.scheme + '://' + host + ':' + port;
      if (endpoints.has(id)) throw Error('Remove duplicate proxy endpoints.');
      endpoints.add(id);
      return {id, scheme: s.scheme, host, port, username, password, label: String(s.label || 'Server ' + (i + 1)).trim().slice(0, 60) || 'Server ' + (i + 1)};
    });
    if (raw.enabled && !servers.length) throw Error('Add your proxy servers before enabling automatic connection.');
    if (raw.enabled && !raw.directNetworkConfirmed) throw Error('Confirm that this profile uses direct internet with no existing system proxy.');
    return {enabled: raw.enabled, includeDirect: raw.includeDirect, directNetworkConfirmed: raw.directNetworkConfirmed, servers};
  }
  function pac(server) {
    const route = server ? ({http: 'PROXY', https: 'HTTPS', socks5: 'SOCKS5'}[server.scheme] + ' ' + server.host + ':' + server.port) : 'DIRECT';
    return {mode: 'pac_script', pacScript: {mandatory: true, data: MARKER +
      'function FindProxyForURL(url, host) {\n' +
      'host = host.toLowerCase();\n' +
      'if (host === "aivid.dev" || dnsDomainIs(host, ".aivid.dev")) return ' + JSON.stringify(route) + ';\n' +
      'return "DIRECT";\n}'}};
  }
  function owns(value) { return value?.mode === 'pac_script' && value.pacScript?.data?.startsWith(MARKER); }
  function pick(samples) { return samples.filter(s => Number.isFinite(s.ms)).sort((a, b) => a.ms - b.ms)[0] || null; }
  function authAllowed(details, server) {
    return Boolean(server?.username && details.isProxy && isStudio(details.url) &&
      String(details.challenger?.host || '').toLowerCase() === server.host && Number(details.challenger?.port) === server.port);
  }
  const api = {PERMISSIONS, URLS, normalize, pac, owns, pick, isStudio, authAllowed};
  if (typeof module !== 'undefined') module.exports = api;
  else root.CMMProxyCore = api;
})(globalThis);

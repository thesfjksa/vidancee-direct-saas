'use strict';
(function(root) {
  const core = typeof module !== 'undefined' ? require('./proxy-core.js') : root.CMMProxyCore;
  const ORIGIN = 'https://proxy.webshare.io/*';
  const ENDPOINT = 'https://proxy.webshare.io/api/v2/proxy/list/';
  class WebshareError extends Error {}
  function proxiesFromResponse(data) {
    if (!data || !Array.isArray(data.results)) throw new WebshareError('Webshare returned an invalid proxy list.');
    const servers = [], seen = new Set();
    for (const proxy of data.results.slice(0, 100)) {
      if (!proxy || proxy.valid !== true || !proxy.proxy_address || typeof proxy.username !== 'string' || typeof proxy.password !== 'string') continue;
      try {
        const country = /^[A-Z]{2}$/.test(proxy.country_code) ? proxy.country_code : '';
        const server = core.normalize({enabled:false, includeDirect:false, directNetworkConfirmed:false, servers:[{
          label: 'Webshare' + (country ? ' ' + country : '') + ' · ' + (servers.length + 1),
          scheme:'http', host:proxy.proxy_address, port:proxy.port, username:proxy.username, password:proxy.password
        }]}).servers[0];
        if (seen.has(server.id)) continue;
        seen.add(server.id); servers.push(server);
        if (servers.length === 5) break;
      } catch { /* Ignore malformed endpoints; never display their credentials. */ }
    }
    if (!servers.length) throw new WebshareError('No usable direct proxies were returned. Check your Webshare Proxy Server plan, country filter and proxy status. Rotating Residential/backbone plans are not imported by this version.');
    return servers;
  }
  async function readJson(response) {
    const limit = 128 * 1024;
    if (Number(response.headers.get('content-length')) > limit) throw new WebshareError('Webshare proxy list exceeds the import size limit.');
    const reader = response.body?.getReader();
    if (!reader) throw new WebshareError('Webshare returned an empty proxy list.');
    const chunks = []; let size = 0;
    try {
      while (true) {
        const {done,value} = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > limit) throw new WebshareError('Webshare proxy list exceeds the import size limit.');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk,offset); offset += chunk.byteLength;}
      try {return JSON.parse(new TextDecoder().decode(bytes));} catch {throw new WebshareError('Webshare returned an invalid proxy list.');}
    } finally {void reader.cancel().catch(() => {}); reader.releaseLock();}
  }
  async function importProxies(api, input, fetcher = fetch, deadline = 12000) {
    const key = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!key || key.length > 512 || !/^[A-Za-z0-9._-]+$/.test(key)) throw new WebshareError('Enter your Webshare API key in Extension options.');
    const country = String(input.country || '').trim().toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) throw new WebshareError('Use a two-letter country code, or leave it blank.');
    if (!await api.permissions.contains({origins:[ORIGIN]})) throw new WebshareError('Allow access to the Webshare API to import your proxies.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), deadline);
    try {
      const query = new URLSearchParams({mode:'direct',page:'1',page_size:'100',valid:'true'});
      if (country) query.set('country_code__in', country);
      const response = await fetcher(ENDPOINT + '?' + query, {
        method:'GET', headers:{Authorization:'Token ' + key}, credentials:'omit', cache:'no-store', redirect:'error', signal:controller.signal
      });
      if ([401,403].includes(response.status)) throw new WebshareError('Webshare rejected this API key or its permissions. Check the key in your Webshare account.');
      if (response.status === 429) throw new WebshareError('Webshare rate limit reached. Wait before importing again.');
      if (!response.ok) throw new WebshareError('Webshare proxy import is temporarily unavailable. Try again later.');
      return {servers:proxiesFromResponse(await readJson(response))};
    } catch (error) {
      if (error instanceof WebshareError) throw error;
      throw new WebshareError('Could not read Webshare proxies within the connection deadline. Check your connection and API key.');
    } finally {clearTimeout(timer); controller.abort();}
  }
  const api = {ORIGIN, ENDPOINT, importProxies, proxiesFromResponse};
  if (typeof module !== 'undefined') module.exports = api;
  else root.CMMWebshare = api;
})(globalThis);

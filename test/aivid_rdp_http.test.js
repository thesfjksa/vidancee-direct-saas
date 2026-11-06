'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { handle } = require('../src/aivid_rdp_http.js');
test('agent routes require dedicated authentication and do not expose infrastructure errors', async t => {
  let writes = 0;
  const api = {
    pair: async () => { throw Object.assign(new Error('Invalid or expired pairing code.'), { aividSafe: true, statusCode: 401 }); },
    authorize: async header => {
      if (header !== 'Bearer fixture-agent') throw Object.assign(new Error('RDP agent authentication required.'), { aividSafe: true, statusCode: 401 });
      return { deviceId: 'fixture-device' };
    },
    poll: async () => { throw new Error('private mysql credentials and bearer token'); },
    command: async () => ({ kind: 'collect', state: 'running' }),
    store: { chunk: async () => { writes++; } },
  };
  const readJson = async req => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); };
  const server = http.createServer(async (req, res) => {
    if (!await handle(req, res, new URL(req.url, 'http://localhost').pathname, { instance: api, readJson, requireDatabase() {} })) { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base+'/api/aivid-rdp/runtime')).status,401);
  const manifestResponse=await fetch(base+'/api/aivid-rdp/runtime',{headers:{authorization:'Bearer fixture-agent'}});
  assert.equal(manifestResponse.status,200);const manifest=await manifestResponse.json();assert.equal(manifest.protocol,1);
  const file=manifest.files[0];const content=await fetch(base+'/api/aivid-rdp/runtime/file?version='+manifest.version+'&path='+encodeURIComponent(file.path),{headers:{authorization:'Bearer fixture-agent'}});
  assert.equal(content.status,200);assert.equal((await content.arrayBuffer()).byteLength,file.bytes);
  assert.equal((await fetch(base+'/api/aivid-rdp/runtime/file?version=wrong&path=agent.cjs',{headers:{authorization:'Bearer fixture-agent'}})).status,409);
  for (const route of ['/runtime','/runtime/file','/poll', '/commands/12345678-1234-4234-9234-123456789012/result', '/commands/12345678-1234-4234-9234-123456789012/chunks/0']) {
    assert.equal((await fetch(base + '/api/aivid-rdp' + route, { method: 'POST', body: '{}' })).status, 401);
  }
  assert.equal(writes, 0);
  const pair = await fetch(base + '/api/aivid-rdp/pair', { method: 'POST', body: '{}' }); assert.equal(pair.status, 401);
  const response = await fetch(base + '/api/aivid-rdp/poll', { method: 'POST', headers: { authorization: 'Bearer fixture-agent' }, body: '{}' });
  assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /private mysql|bearer token/);
});

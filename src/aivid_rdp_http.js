'use strict';
const { AividRdpService, CHUNK, failure } = require('./aivid_rdp.js');
let singleton;
function service() { return singleton ||= new AividRdpService(); }
function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function handle(req, res, path, { readJson, requireDatabase, instance = null } = {}) {
  if (!path.startsWith('/api/aivid-rdp/')) return false;
  try {
    requireDatabase();
    const api = instance || service();
    if (path === '/api/aivid-rdp/pair' && req.method === 'POST') {
      const input = await readJson(req);
      json(res, 200, { ok: true, ...await api.pair(input.code) }); return true;
    }
    const device = await api.authorize(req.headers.authorization);
    if (path === '/api/aivid-rdp/browser' && req.method === 'GET') {
      const config = await api.getConfig();
      json(res, 200, { browser: config.rdpBrowser === 'edge' ? 'edge' : 'chrome' }); return true;
    }
    if (path === '/api/aivid-rdp/poll' && req.method === 'POST') {
      const input = await readJson(req);
      const result = await api.poll(device, input.status);
      const config = await api.getConfig();
      json(res, 200, { ok: true, ...result, browser: config.rdpBrowser === 'edge' ? 'edge' : 'chrome' }); return true;
    }
    if(req.method==='GET'&&(path==='/api/aivid-rdp/runtime'||path==='/api/aivid-rdp/runtime/file')){
      const {manifest,files}=require('./aivid_runtime.js').runtime();
      if(path.endsWith('/file')){
        const u=new URL(req.url,'https://cmmtools.invalid');
        if(u.searchParams.get('version')!==manifest.version)throw failure('Worker release changed. Restart update.',409);
        const data=files.get(u.searchParams.get('path'));if(!data)throw failure('Worker file not found.',404);
        res.writeHead(200,{'content-type':'application/octet-stream','content-length':data.length,'cache-control':'no-store'});res.end(data);
      }else json(res,200,manifest);
      return true;
    }
    const match = path.match(/^\/api\/aivid-rdp\/commands\/([0-9a-f-]{36})(?:\/(reserve|result|references|chunks)(?:\/(\d+))?)?$/i);
    if (!match) throw failure('RDP route not found.', 404);
    const [, id, action, position] = match;
    if (!action && req.method === 'GET') {
      const command = await api.command(device, id); json(res, 200, { ok: true, state: command.state }); return true;
    }
    if (action === 'reserve' && req.method === 'POST') {
      const input = await readJson(req); json(res, 200, { ok: true, ...await api.reserve(device, id, input.price) }); return true;
    }
    if (action === 'result' && req.method === 'POST') {
      json(res, 200, { ok: true, ...await api.result(device, id, await readJson(req)) }); return true;
    }
    if (action === 'references' && req.method === 'GET' && position !== undefined) {
      const file = await api.reference(device, id, Number(position));
      res.writeHead(200, { 'content-type': file.mimeType, 'content-length': file.data.length, 'cache-control': 'no-store' }); res.end(file.data); return true;
    }
    if (action === 'chunks' && req.method === 'POST' && position !== undefined) {
      const command = await api.command(device, id), index = Number(position);
      if (command.kind !== 'collect' || command.state !== 'running' || !Number.isSafeInteger(index) || index < 0 || index >= 100) throw failure('Invalid MP4 transfer.', 409);
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > CHUNK) throw failure('Output chunk is too large.', 413); chunks.push(chunk); }
      if (!size) throw failure('Output chunk is empty.');
      await api.store.chunk(id, index, Buffer.concat(chunks, size)); json(res, 200, { ok: true, saved: true }); return true;
    }
    throw failure('Method not allowed.', 405);
  } catch (error) {
    json(res, error?.aividSafe ? error.statusCode : 503, { ok: false,
      error: error?.aividSafe ? error.message : 'The RDP service is unavailable. Check the CMMTools database connection.' });
    return true;
  }
}
module.exports = { handle, service };

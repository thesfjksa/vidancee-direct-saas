'use strict';
const store = require('./customer_api_store.js');
const { hideVendors } = require('./vendor_names.js');
const { customerNewModelId } = require('./new_brand.js');
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const FIELDS = new Set(['model','prompt','duration','resolution','aspectRatio','generateAudio','generationMode','quality','imageSize',
  'images','videos','audios','referenceOrder','videoRoles','audioRoles','reuseGenerationId','reuseImageIds']);
function normalizeInput(value, mediaType = 'video') {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, 'Send a JSON object or multipart form.');
  const body = { ...value };
  for (const [from,to] of [['seconds','duration'],['aspect_ratio','aspectRatio'],['ratio','aspectRatio'],['video_roles','videoRoles'],['audio_roles','audioRoles'],['reference_order','referenceOrder']]) {
    if (body[from] !== undefined) { if (body[to] !== undefined && String(body[to]) !== String(body[from])) fail(400, 'Conflicting fields: ' + from + ' and ' + to); body[to] = body[from]; delete body[from]; }
  }
  for (const key of Object.keys(body)) if (!FIELDS.has(key)) fail(400, 'Unsupported field: ' + key);
  if (typeof body.model !== 'string' || !body.model.trim()) fail(400, 'model is required. Use an ID from GET /v1/models.');
  body.model = customerNewModelId(body.model.trim());
  if (body.duration !== undefined) { body.duration = Number(body.duration); if (!Number.isFinite(body.duration) || body.duration <= 0) fail(400, 'duration must be a positive number of seconds.'); }
  if (body.generateAudio !== undefined) {
    if (![true,false,'true','false','1','0'].includes(body.generateAudio)) fail(400, 'generateAudio must be true or false.');
    body.generateAudio = [true,'true','1'].includes(body.generateAudio);
  }
  for (const field of ['images','videos','audios']) {
    if (body[field] === undefined) continue;
    if (!Array.isArray(body[field]) || body[field].some(file => !file || !Buffer.isBuffer(file.data) || typeof file.mimeType !== 'string' || typeof file.filename !== 'string')) {
      fail(400, 'Upload ' + field + ' as multipart files; JSON URLs and file objects are not accepted.');
    }
  }
  if (mediaType === 'image' && (body.videos?.length || body.audios?.length)) fail(400, 'Image generation accepts image references only.');
  return body;
}
function publicJob(row, mediaType) {
  const image = mediaType === 'image';
  const base = image ? '/v1/images/generations/' : '/v1/videos/';
  return { id: row.id, object: image ? 'image.generation' : 'video', model: customerNewModelId(row.model), status: row.status,
    prompt: row.prompt, ...(image ? {} : { duration: Number(row.duration), resolution: row.resolution || null }),
    aspect_ratio: row.aspect_ratio, credits_cost: Number(row.credits_cost),
    refunded_at: row.refunded_at || null, error: row.error_message ? hideVendors(row.error_message) : null,
    created_at: row.created_at, completed_at: row.completed_at || null,
    status_url: base + row.id,
    content_url: (row.output_url || row.has_video || row.has_image) ? base + row.id + '/content' : null };
}
function createCustomerApi(deps) {
  const { getPool, requireDatabase, requireUser, readJson, readGenerationRequest, sendJson } = deps;
  const balance = async userId => {
    const [[row]] = await getPool().execute('SELECT credits FROM users WHERE id=?', [userId]);
    return Number(row?.credits || 0);
  };
  async function handle(req, res, url, routePath) {
    const api = routePath === '/v1' || routePath.startsWith('/v1/');
    const management = routePath === '/api/developer' || routePath.startsWith('/api/developer/');
    if (!api && !management) return false;
    res.setHeader('cache-control', 'no-store');
    try {
      requireDatabase();
      if (management) {
        const user = await requireUser(req);
        if (req.method !== 'GET') {
          // Custom header cannot be submitted by a cross-site HTML form.
          if (req.headers['x-cmmtools-key-management'] !== '1') fail(403, 'Key management requires the CMM Tools developer page.');
          if (req.headers.origin && req.headers.origin !== deps.publicOrigin(req)) fail(403, 'Cross-origin key management is not allowed.');
        }
        if (req.method === 'GET' && routePath === '/api/developer') {
          const [keys, credits, usage] = await Promise.all([store.listKeys(getPool(), user.id), balance(user.id), store.usage(getPool(), user.id)]);
          sendJson(res, 200, { ok: true, keys, credits, usage, rate_limit_per_minute: store.RATE_LIMIT });
        } else if (req.method === 'POST' && routePath === '/api/developer/keys') {
          sendJson(res, 201, { ok: true, ...await store.createKey(getPool(), user.id, await readJson(req)) });
        } else if (req.method === 'DELETE' && /^\/api\/developer\/keys\/[0-9a-f-]{36}$/i.test(routePath)) {
          await store.revokeKey(getPool(), user.id, routePath.split('/').pop());
          sendJson(res, 200, { ok: true, revoked: true });
        } else fail(404, 'Developer endpoint not found.');
        return true;
      }
      const auth = await store.authenticate(getPool(), req);
      const { user, keyId } = auth;
      if (req.method === 'GET' && routePath === '/v1/balance') {
        sendJson(res, 200, { object: 'balance', credits: await balance(user.id), unit: 'credits' });
      } else if (req.method === 'GET' && routePath === '/v1/usage') {
        sendJson(res, 200, { object: 'list', data: await store.usage(getPool(), user.id) });
      } else if (req.method === 'GET' && routePath === '/v1/models') {
        const catalog = await deps.catalog(user.id);
        sendJson(res, 200, { object: 'list', data: ['video','image'].flatMap(type => (catalog[type] || []).map(model => ({ ...model, object: 'model', media_type: type }))) });
      } else if (req.method === 'POST' && routePath === '/v1/quotes') {
        const input = await readJson(req);
        const mediaType = input?.mediaType === 'image' ? 'image' : 'video';
        const { mediaType: ignored, ...rest } = input || {};
        const body = normalizeInput(rest, mediaType);
        const catalog = await deps.catalog(user.id);
        if (!(catalog[mediaType] || []).some(m => m.id === body.model)) fail(403, 'Model is unavailable for this account.');
        const quote = await deps.quote(user.id, { ...body, mediaType });
        sendJson(res, 200, { object: 'quote', model: body.model, credits: quote.cost, is_estimate: quote.isEstimate === true, unit: 'credits' });
      } else {
        const mediaType = routePath.startsWith('/v1/images/generations') ? 'image' : 'video';
        const base = mediaType === 'image' ? '/v1/images/generations' : '/v1/videos';
        if (routePath === base && req.method === 'POST') {
          const body = normalizeInput(await readGenerationRequest(req), mediaType);
          const context = store.requestContext(keyId, req.headers['idempotency-key'], body, mediaType);
          // Replay before catalog/credit checks: maintenance or a spent balance
          // must not turn a successful retry into another paid request.
          const replay = await store.findReplay(getPool(), user.id, context);
          if (replay) {
            res.setHeader('idempotency-replayed', 'true');
            sendJson(res, 200, publicJob(replay, mediaType));
          } else {
            const catalog = await deps.catalog(user.id);
            if (!(catalog[mediaType] || []).some(m => m.id === body.model)) fail(403, 'Model is unavailable for this account.');
            const generation = await (mediaType === 'image' ? deps.submitImage : deps.submitVideo)(user, body, req, context);
            sendJson(res, 202, publicJob(generation, mediaType));
          }
        } else if (routePath === base && req.method === 'GET') {
          const list = mediaType === 'image' ? deps.listImages : deps.listVideos;
          const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 25)));
          sendJson(res, 200, { object: 'list', data: (await list(user.id, limit)).map(row => publicJob(row, mediaType)) });
        } else {
          const match = routePath.slice(base.length).match(/^\/([0-9a-f-]{36})(\/content)?$/i);
          if (!routePath.startsWith(base) || !match || req.method !== 'GET') fail(404, 'API endpoint not found.');
          const row = await (mediaType === 'image' ? deps.getImage : deps.getVideo)(user.id, match[1]);
          if (!row) fail(404, 'Generation not found.');
          if (match[2]) {
            if (!row.output_url) fail(409, 'Generation output is not ready.');
            await deps.serveMedia(row, req, res);
          } else sendJson(res, 200, publicJob(row, mediaType));
        }
      }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      const status = Number(error.statusCode) || 500;
      if (status === 401 && api) res.setHeader('www-authenticate', 'Bearer realm="CMM Tools API"');
      if (status === 429) res.setHeader('retry-after', '60');
      sendJson(res, status, { error: { message: status >= 500 ? 'Service temporarily unavailable. Retry status queries; reuse the same Idempotency-Key for generation retries.' : hideVendors(error.message),
        type: status === 401 ? 'authentication_error' : status === 402 ? 'insufficient_credits' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error' } });
    }
    return true;
  }
  return { handle };
}
module.exports = { createCustomerApi, normalizeInput, publicJob };

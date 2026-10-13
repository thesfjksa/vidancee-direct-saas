'use strict';

// HTTP side of the Claude connector: OAuth discovery and endpoints, the
// consent page, the MCP endpoint at /mcp, signed download links for finished
// jobs, photo upload links, and the customer's list of connected apps.
// server.js passes in the functions the website itself uses, so the connector
// creates jobs with the same checks, prices and credit rules.
const crypto = require('node:crypto');
const oauth = require('./mcp_oauth.js');
const mcp = require('./mcp_server.js');
const pages = require('./mcp_pages.js');
const { fetchPublicImage, imageType, MAX_IMAGE_BYTES } = require('./remote_image.js');
const { getPlanProfile } = require('./plans.js');
const { serializeGeneration } = require('./generations.js');
const { serializeImageGeneration } = require('./image_generations.js');

const ENABLED_SETTING = 'claude_connector_enabled';
const SHARE_DAYS = 7, UPLOAD_LINK_MINUTES = 60, UPLOAD_KEEP_DAYS = 7;
const MCP_BODY_LIMIT = 1024 * 1024;

function createConnector(deps) {
  const { getPool, sendJson, sendHtml, readJson, publicOrigin, userFromRequest, sessionTokenHash, logActivity, getSettingValue, setSettingValue } = deps;

  function secret() {
    const value = String(process.env.PROVIDER_ASSET_SECRET || process.env.ADMIN_TOKEN || '');
    if (!value) throw Object.assign(new Error('The connector is not configured (PROVIDER_ASSET_SECRET or ADMIN_TOKEN is missing).'), { statusCode: 503 });
    return value;
  }
  const sign = (purpose, id, exp) => crypto.createHmac('sha256', secret()).update(purpose + ':' + id + ':' + exp).digest('hex');
  function verifySigned(purpose, id, exp, sig) {
    if (!/^\d+$/.test(String(exp)) || Number(exp) < Date.now() / 1000) return false;
    const a = Buffer.from(sign(purpose, id, exp)), b = Buffer.from(String(sig || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const consentSecret = () => crypto.createHmac('sha256', secret()).update('claude-connector-consent').digest();

  // Open registration is limited per address so a script cannot fill the table.
  const registrations = new Map();
  function registrationAllowed(req) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const now = Date.now(), recent = (registrations.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (recent.length >= 20) return false;
    recent.push(now); registrations.set(ip, recent);
    if (registrations.size > 5000) registrations.delete(registrations.keys().next().value);
    return true;
  }

  async function enabled() { return (await getSettingValue(ENABLED_SETTING, '1')) !== '0'; }
  const log = (event, message, details, { userId = null, generationId = null, level = 'info' } = {}) =>
    logActivity({ level, category: 'connector', event, userId, generationId, message, details });

  function allowCors(res, origin = '*') {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id');
    res.setHeader('access-control-expose-headers', 'www-authenticate, mcp-session-id');
    res.setHeader('access-control-max-age', '600');
    if (origin !== '*') res.setHeader('vary', 'origin');
  }
  function sendOAuthError(res, error) {
    res.setHeader('pragma', 'no-cache');
    if (error.status === 401) res.setHeader('www-authenticate', 'Basic realm="CMM Tools"');
    return sendJson(res, error.status || 400, error.body());
  }

  async function readRaw(req, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
  async function readParams(req) {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    const raw = (await readRaw(req, 64 * 1024)).toString('utf8');
    if (type.startsWith('application/json')) { try { return JSON.parse(raw || '{}') || {}; } catch { return {}; } }
    return Object.fromEntries(new URLSearchParams(raw));
  }

  // Origins a browser-based MCP client may call /mcp from (DNS-rebinding guard).
  function originAllowed(origin, base) {
    if (!origin) return true;
    if ([base, 'https://claude.ai', 'https://claude.com'].includes(origin)) return true;
    try { const u = new URL(origin); return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); } catch { return false; }
  }

  // ---------- Services for the MCP tools ----------
  async function loadUser(userId) {
    const [[user]] = await getPool().execute("SELECT id,email,credits,status,role,plan_code FROM users WHERE id=? AND status='active'", [userId]);
    return user || null;
  }
  async function creditsOf(userId) {
    const [[row]] = await getPool().execute('SELECT credits FROM users WHERE id=?', [userId]);
    return Number(row?.credits || 0);
  }
  function shareUrl(base, id) {
    const exp = Math.floor(Date.now() / 1000) + SHARE_DAYS * 86400;
    return base + '/media-share/' + encodeURIComponent(id) + '?exp=' + exp + '&sig=' + sign('share', id, exp);
  }
  function viewOf(row) {
    return row.media_type === 'image' ? { ...serializeImageGeneration(row), media_type: 'image' } : { ...serializeGeneration(row), media_type: 'video' };
  }

  async function loadReference(user, ref) {
    const db = getPool();
    if (ref.upload_id) {
      const [[row]] = await db.execute(`SELECT filename,mime_type,image_data FROM connector_uploads WHERE id=? AND user_id=? AND uploaded_at IS NOT NULL
        AND created_at>UTC_TIMESTAMP()-INTERVAL ? DAY`, [ref.upload_id, user.id, UPLOAD_KEEP_DAYS]);
      if (!row) throw Object.assign(new Error('Upload ' + ref.upload_id + ' has no photo yet. The customer needs to open the upload link and upload it first.'), { statusCode: 400 });
      return { filename: row.filename, mimeType: row.mime_type, data: row.image_data };
    }
    if (ref.image_job_id) {
      const [[row]] = await db.execute("SELECT id,output_url FROM generations WHERE id=? AND user_id=? AND media_type='image' AND status='completed' LIMIT 1", [ref.image_job_id, user.id]);
      if (!row) throw Object.assign(new Error('No finished image ' + ref.image_job_id + ' on this account.'), { statusCode: 400 });
      const [[output]] = await db.execute('SELECT mime_type,image_data FROM generation_image_outputs WHERE generation_id=?', [row.id]);
      if (!output) throw Object.assign(new Error('Image ' + ref.image_job_id + ' is not stored on CMM Tools any more.'), { statusCode: 400 });
      return { filename: 'cmm-image-' + row.id.slice(0, 8), mimeType: output.mime_type, data: output.image_data };
    }
    return fetchPublicImage(ref.url);
  }

  function services(base) {
    return {
      async account(user) {
        const fresh = await loadUser(user.id) || user;
        const plan = getPlanProfile(fresh.plan_code);
        const [[active]] = await getPool().execute("SELECT COUNT(*) AS total FROM generations WHERE user_id=? AND status IN ('queued','submitting','submitted','processing')", [user.id]);
        return { email: fresh.email, credits: Number(fresh.credits), plan: plan.code ? plan.name : 'No plan', max_parallel_jobs: plan.concurrency, running_jobs: Number(active.total) };
      },
      async catalog(user) { return deps.catalog(user.id); },
      quote: (user, body) => deps.quote(user.id, body),
      async submitVideo(user, body) {
        const generation = await deps.submitVideo(user, body);
        return { generation: { ...generation, media_type: 'video' }, credits: await creditsOf(user.id) };
      },
      async submitImage(user, body) {
        const generation = await deps.submitImage(user, body);
        return { generation: { ...generation, media_type: 'image' }, credits: await creditsOf(user.id) };
      },
      async submitUpscale(user, { generationId, resolution }) {
        const row = await deps.submitUpscale(user, { resolution, source: { generationId } });
        return { generation: { ...serializeGeneration(row), media_type: 'video' }, credits: await creditsOf(user.id) };
      },
      async getJob(user, id) {
        const [[row]] = await getPool().execute('SELECT * FROM generations WHERE id=? AND user_id=? AND media_type IN (\'video\',\'image\') LIMIT 1', [id, user.id]);
        return row ? viewOf(row) : null;
      },
      async listJobs(user, { mediaType, limit }) {
        const types = mediaType ? [mediaType] : ['video', 'image'];
        const [rows] = await getPool().query(`SELECT * FROM generations WHERE user_id=? AND media_type IN (${types.map(() => '?').join(',')})
          ORDER BY created_at DESC LIMIT ${Math.min(20, Math.max(1, Number(limit) || 10))}`, [user.id, ...types]);
        return rows.map(viewOf);
      },
      loadReference,
      async createUpload(user) {
        const id = crypto.randomUUID();
        await getPool().execute("INSERT INTO connector_uploads (id,user_id,filename) VALUES (?,?,'upload')", [id, user.id]);
        const exp = Math.floor(Date.now() / 1000) + UPLOAD_LINK_MINUTES * 60;
        return { id, url: base + '/connector-upload/' + id + '?exp=' + exp + '&sig=' + sign('upload', id, exp) };
      },
      async listUploads(user) {
        const [rows] = await getPool().execute(`SELECT id,filename,mime_type,LENGTH(image_data) AS bytes,created_at,uploaded_at FROM connector_uploads
          WHERE user_id=? AND created_at>UTC_TIMESTAMP()-INTERVAL ? DAY ORDER BY created_at DESC LIMIT 20`, [user.id, UPLOAD_KEEP_DAYS]);
        return rows.map(r => ({ upload_id: r.id, ready: Boolean(r.uploaded_at), ...(r.uploaded_at ? { filename: r.filename, bytes: Number(r.bytes), uploaded_at: r.uploaded_at } : {}), created_at: r.created_at }));
      },
      shareUrl: id => shareUrl(base, id),
      wake: () => deps.wake(),
    };
  }

  // ---------- Routes ----------
  async function handleMcp(req, res, base) {
    const origin = String(req.headers.origin || '');
    if (!originAllowed(origin, base)) return sendJson(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed.' } });
    allowCors(res, origin || '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!(await enabled())) return sendJson(res, 503, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'The CMM Tools connector is turned off.' } });

    const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    const grant = match ? await oauth.verifyAccessToken(getPool(), match[1]) : null;
    const user = grant ? await loadUser(grant.userId) : null;
    if (!user) {
      const metadata = base + '/.well-known/oauth-protected-resource/mcp';
      res.setHeader('www-authenticate', 'Bearer resource_metadata="' + metadata + '", scope="' + oauth.SCOPE + '"' + (match ? ', error="invalid_token", error_description="The access token is invalid or expired."' : ''));
      return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Sign in to CMM Tools to use this connector.' } });
    }
    req.activityUserId = user.id;
    if (req.method !== 'POST') { res.setHeader('allow', 'POST, OPTIONS'); return sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST.' } }); }

    const raw = (await readRaw(req, MCP_BODY_LIMIT)).toString('utf8');
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const ctx = {
      user, services: services(base), signal: controller.signal,
      protocolHeader: req.headers['mcp-protocol-version'] ? String(req.headers['mcp-protocol-version']) : null,
      log: (event, message, details, generationId = null, level = 'info') => log(event, message, details, { userId: user.id, generationId, level }),
    };
    const out = await mcp.handleBody(raw, ctx);
    if (!out.body) { res.writeHead(out.status); return res.end(); }
    return sendJson(res, out.status, out.body);
  }

  function consentFields(request) {
    return { client_id: request.client.clientId, redirect_uri: request.redirectUri, state: request.state, code_challenge: request.codeChallenge,
      code_challenge_method: 'S256', response_type: 'code', scope: request.scope };
  }

  async function handleAuthorize(req, res, url, base) {
    const params = req.method === 'POST' ? await readParams(req) : Object.fromEntries(url.searchParams);
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "frame-ancestors 'none'");
    if (!(await enabled())) return sendHtml(res, 503, pages.errorPage('Connector turned off', 'The CMM Tools connector for Claude is turned off right now.'));
    let request;
    try { request = await oauth.validateAuthorizationRequest(getPool(), params, { base }); }
    catch (error) {
      if (error.redirect) { res.writeHead(302, { location: oauth.redirectWith(error.redirect, { error: error.code, error_description: error.message, state: error.state, iss: base }) }); return res.end(); }
      return sendHtml(res, 400, pages.errorPage('Can’t connect', error.message || 'This connection request is invalid.'));
    }
    const appName = request.client.clientName;
    const user = await userFromRequest(req);
    if (!user) return sendHtml(res, 200, pages.loginPage({ appName }));
    const sessionHash = sessionTokenHash(req);

    if (req.method === 'POST') {
      if (!oauth.verifyConsentToken(consentSecret(), sessionHash, request, params.consent)) {
        return sendHtml(res, 400, pages.errorPage('Please try again', 'This page expired. Go back to Claude and connect again.'));
      }
      if (params.decision !== 'allow') {
        log('connector.denied', 'Declined connecting ' + appName, null, { userId: user.id });
        res.writeHead(302, { location: oauth.redirectWith(request.redirectUri, { error: 'access_denied', state: request.state, iss: base }) });
        return res.end();
      }
      const code = await oauth.issueCode(getPool(), { client: request.client, userId: user.id, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, scope: request.scope });
      log('connector.authorized', 'Allowed ' + appName + ' to use the account', { client: request.client.kind, redirectHost: new URL(request.redirectUri).host }, { userId: user.id });
      res.writeHead(302, { location: oauth.redirectWith(request.redirectUri, { code, state: request.state, iss: base }) });
      return res.end();
    }
    const fields = { ...consentFields(request), consent: oauth.consentToken(consentSecret(), sessionHash, request) };
    return sendHtml(res, 200, pages.consentPage({ appName, redirectUri: request.redirectUri, email: user.email, fields, loopback: oauth.isLoopback(oauth.parseUrl(request.redirectUri)) }));
  }

  async function handleMediaShare(req, res, url, id) {
    if (!verifySigned('share', id, url.searchParams.get('exp'), url.searchParams.get('sig'))) return sendJson(res, 403, { ok: false, error: 'This download link is invalid or has expired.' });
    const [[row]] = await getPool().execute("SELECT * FROM generations WHERE id=? AND status='completed' LIMIT 1", [id]);
    if (!row || !row.output_url) return sendJson(res, 404, { ok: false, error: 'This file is no longer available.' });
    if (row.media_type === 'image') {
      if (row.output_url !== 'db:image') return deps.proxyMedia(req, res, row, 'video');
      const [[output]] = await getPool().execute('SELECT mime_type,image_data FROM generation_image_outputs WHERE generation_id=?', [id]);
      if (!output) return sendJson(res, 404, { ok: false, error: 'This file is no longer available.' });
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[output.mime_type] || 'png';
      res.writeHead(200, { 'content-type': output.mime_type, 'content-length': output.image_data.length, 'cache-control': 'private, max-age=3600',
        'content-disposition': 'inline; filename="cmm-tools-' + id.slice(0, 8) + '.' + ext + '"', 'x-content-type-options': 'nosniff' });
      return res.end(output.image_data);
    }
    const [[stored]] = await getPool().execute('SELECT generation_id FROM generation_video_outputs WHERE generation_id=?', [id]);
    if (stored) return deps.serveVideoOutput(getPool(), req, res, id);
    return deps.proxyMedia(req, res, row, 'video');
  }

  async function handleUpload(req, res, url, id) {
    const exp = url.searchParams.get('exp'), sig = url.searchParams.get('sig');
    res.setHeader('x-frame-options', 'DENY');
    if (!verifySigned('upload', id, exp, sig)) {
      if (req.method === 'POST') return sendJson(res, 403, { ok: false, error: 'This upload link has expired. Ask Claude for a new one.' });
      return sendHtml(res, 403, pages.uploadPage({ expired: true }));
    }
    const [[row]] = await getPool().execute('SELECT id,user_id,uploaded_at FROM connector_uploads WHERE id=?', [id]);
    if (!row) return sendHtml(res, 404, pages.uploadPage({ expired: true }));
    if (req.method === 'GET') return sendHtml(res, 200, pages.uploadPage({ state: row.uploaded_at ? 'uploaded' : 'waiting' }));
    const data = await readRaw(req, MAX_IMAGE_BYTES).catch(() => null);
    if (!data) return sendJson(res, 413, { ok: false, error: 'The photo must be 15 MB or smaller.' });
    const mimeType = imageType(data);
    if (!mimeType) return sendJson(res, 400, { ok: false, error: 'Upload a JPEG, PNG or WebP image.' });
    const filename = 'photo.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mimeType]);
    await getPool().execute('UPDATE connector_uploads SET filename=?,mime_type=?,image_data=?,uploaded_at=UTC_TIMESTAMP() WHERE id=?', [filename, mimeType, data, id]);
    log('connector.upload', 'Photo uploaded for Claude (' + Math.round(data.length / 1024) + ' KB)', { uploadId: id }, { userId: row.user_id });
    return sendJson(res, 200, { ok: true });
  }

  // Returns true when the request belonged to the connector.
  async function handle(req, res, url, routePath) {
    const isOAuth = routePath.startsWith('/oauth/') || routePath.startsWith('/.well-known/oauth-');
    if (!isOAuth && routePath !== '/mcp' && !routePath.startsWith('/media-share/') && !routePath.startsWith('/connector-upload/') && !routePath.startsWith('/api/connector') && routePath !== '/admin/connector') return false;
    deps.requireDatabase();
    const base = publicOrigin(req).replace(/\/$/, '');

    if (routePath === '/mcp') { await handleMcp(req, res, base); return true; }

    if (isOAuth && req.method === 'OPTIONS' && routePath !== '/oauth/authorize') { allowCors(res); res.writeHead(204); res.end(); return true; }
    if (req.method === 'GET' && (routePath === '/.well-known/oauth-protected-resource' || routePath === '/.well-known/oauth-protected-resource/mcp')) {
      allowCors(res); res.setHeader('cache-control', 'public, max-age=300');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(oauth.protectedResourceMetadata(base))); return true;
    }
    if (req.method === 'GET' && routePath === '/.well-known/oauth-authorization-server') {
      allowCors(res); res.setHeader('cache-control', 'public, max-age=300');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(oauth.authorizationServerMetadata(base))); return true;
    }
    if (req.method === 'POST' && routePath === '/oauth/register') {
      allowCors(res);
      if (!(await enabled())) { sendJson(res, 503, { error: 'temporarily_unavailable', error_description: 'The CMM Tools connector is turned off.' }); return true; }
      if (!registrationAllowed(req)) { res.setHeader('retry-after', '3600'); sendJson(res, 429, { error: 'temporarily_unavailable', error_description: 'Too many registrations. Try again later.' }); return true; }
      try {
        const client = await oauth.registerClient(getPool(), await readJson(req));
        log('connector.registered', 'Registered app ' + client.client_name, { redirectUris: client.redirect_uris });
        sendJson(res, 201, client);
      } catch (error) {
        if (error instanceof oauth.OAuthError) sendJson(res, 400, error.body()); else throw error;
      }
      return true;
    }
    if ((req.method === 'GET' || req.method === 'POST') && routePath === '/oauth/authorize') { await handleAuthorize(req, res, url, base); return true; }
    if (req.method === 'POST' && routePath === '/oauth/token') {
      allowCors(res);
      try {
        const { grant, tokens } = await oauth.exchangeToken(getPool(), await readParams(req), req.headers.authorization);
        res.setHeader('pragma', 'no-cache');
        sendJson(res, 200, tokens);
        if (!grant.refreshHash) log('connector.connected', grant.clientName + ' connected', { grantId: grant.id }, { userId: grant.userId });
      } catch (error) {
        if (error instanceof oauth.OAuthError) {
          log('connector.token_error', error.code + ': ' + error.message, null, { level: 'warn' });
          sendOAuthError(res, error);
        } else throw error;
      }
      return true;
    }
    if (req.method === 'POST' && routePath === '/oauth/revoke') {
      allowCors(res);
      const params = await readParams(req);
      if (await oauth.revokeToken(getPool(), params.token)) log('connector.revoked', 'An app disconnected itself', null);
      res.writeHead(200, { 'cache-control': 'no-store' }); res.end(); return true;
    }

    const shareMatch = routePath.match(/^\/media-share\/([0-9a-f-]{36})$/i);
    if (req.method === 'GET' && shareMatch) { await handleMediaShare(req, res, url, shareMatch[1]); return true; }
    const uploadMatch = routePath.match(/^\/connector-upload\/([0-9a-f-]{36})$/i);
    if ((req.method === 'GET' || req.method === 'POST') && uploadMatch) { await handleUpload(req, res, url, uploadMatch[1]); return true; }

    if (req.method === 'GET' && routePath === '/api/connector') {
      const user = await deps.requireUser(req);
      sendJson(res, 200, { ok: true, enabled: await enabled(), url: base + '/mcp', connections: await oauth.listConnections(getPool(), user.id) });
      return true;
    }
    if (req.method === 'POST' && routePath === '/api/connector/disconnect') {
      const user = await deps.requireUser(req);
      const body = await readJson(req);
      const done = await oauth.revokeConnection(getPool(), user.id, body.id);
      if (done) log('connector.disconnected', 'Disconnected an app from CMM Tools', { grantId: body.id }, { userId: user.id });
      sendJson(res, done ? 200 : 404, done ? { ok: true } : { ok: false, error: 'This connection was not found.' });
      return true;
    }
    if (routePath === '/admin/connector') {
      if (!deps.adminAuthorized(req)) { sendJson(res, 401, { ok: false, error: 'Admin token required.' }); return true; }
      if (req.method === 'POST') {
        const body = await readJson(req);
        await setSettingValue(ENABLED_SETTING, body.enabled ? '1' : '0');
        log('connector.switch', 'Claude connector turned ' + (body.enabled ? 'on' : 'off'), null, { level: 'warn' });
      }
      const [[count]] = await getPool().execute('SELECT COUNT(*) AS total, COUNT(DISTINCT user_id) AS users FROM oauth_grants WHERE revoked_at IS NULL AND refresh_expires_at>UTC_TIMESTAMP()');
      sendJson(res, 200, { ok: true, enabled: await enabled(), url: base + '/mcp', connections: Number(count.total), customers: Number(count.users) });
      return true;
    }
    return false;
  }

  async function prune() {
    await oauth.pruneOAuth(getPool());
    await getPool().execute('DELETE FROM connector_uploads WHERE created_at<UTC_TIMESTAMP()-INTERVAL ? DAY', [UPLOAD_KEEP_DAYS]).catch(() => {});
  }

  return { handle, prune, services, enabled };
}

module.exports = { createConnector, ENABLED_SETTING };

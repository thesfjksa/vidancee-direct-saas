'use strict';

// Sign-in for the Claude connector (MCP). CMM Tools is its own OAuth 2.1
// authorization server: Claude identifies itself with its published Client ID
// Metadata Document (CIMD) or registers through Dynamic Client Registration
// (DCR), and every flow uses PKCE S256. Codes and tokens are random strings
// stored only as SHA-256 hashes. One grant is one connected app; refresh
// tokens rotate on every use.
const crypto = require('node:crypto');
const { readBounded } = require('./provider/vercel.js');

const SCOPE = 'cmm';
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_DAYS = 90;
const CODE_TTL_SECONDS = 600;
// Only Claude's own client metadata documents are fetched.
const CIMD_HOSTS = ['claude.ai', 'claude.com'];
// Redirects a registered (DCR) client may use: Claude's hosted callback and
// loopback addresses for Claude Code.
const HOSTED_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = (prefix, bytes = 32) => prefix + crypto.randomBytes(bytes).toString('base64url');

class OAuthError extends Error {
  constructor(code, description, status = 400) { super(description); this.code = code; this.status = status; }
  body() { return { error: this.code, error_description: this.message }; }
}

function parseUrl(value) { try { return new URL(String(value)); } catch { return null; } }
function isLoopback(url) { return url?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }

// Exact match, except loopback redirects, which match with the port ignored
// (RFC 8252 section 7.3; Claude Code picks a new port every session).
function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  const a = parseUrl(registered), b = parseUrl(requested);
  if (!isLoopback(a) || !isLoopback(b)) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

function allowedRegisteredRedirect(uri) {
  const url = parseUrl(uri);
  if (!url || url.hash || url.username || url.password) return false;
  return HOSTED_REDIRECTS.includes(String(uri)) || isLoopback(url);
}

function protectedResourceMetadata(base) {
  return {
    resource: base + '/mcp',
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'CMM Tools',
    resource_documentation: base + '/',
  };
}

function authorizationServerMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: base + '/oauth/authorize',
    token_endpoint: base + '/oauth/token',
    registration_endpoint: base + '/oauth/register',
    revocation_endpoint: base + '/oauth/revoke',
    scopes_supported: [SCOPE, 'offline_access'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: base + '/',
  };
}

// ---------- Clients ----------
const cimdCache = new Map();
async function fetchClientMetadata(clientId, fetchImpl = fetch) {
  const url = parseUrl(clientId);
  if (!url || url.protocol !== 'https:' || !CIMD_HOSTS.includes(url.hostname) || url.username || url.password || url.hash || url.pathname === '/') {
    throw new OAuthError('invalid_client', 'This app cannot connect to CMM Tools.');
  }
  const cached = cimdCache.get(clientId);
  if (cached && cached.expires > Date.now()) return cached.client;
  let doc;
  try {
    const response = await fetchImpl(clientId, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    doc = JSON.parse((await readBounded(response, 64 * 1024)).toString('utf8'));
  } catch {
    throw new OAuthError('invalid_client', 'The app’s client information could not be loaded. Try connecting again.');
  }
  const redirectUris = Array.isArray(doc?.redirect_uris) ? doc.redirect_uris.map(String).slice(0, 20) : [];
  if (doc?.client_id !== clientId || !redirectUris.length || (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none')) {
    throw new OAuthError('invalid_client', 'The app’s client information is invalid.');
  }
  const client = { clientId, clientName: String(doc.client_name || url.hostname).slice(0, 120), redirectUris, kind: 'cimd', authMethod: 'none' };
  cimdCache.set(clientId, { client, expires: Date.now() + 3600 * 1000 });
  if (cimdCache.size > 50) cimdCache.delete(cimdCache.keys().next().value);
  return client;
}

async function resolveClient(db, clientId, fetchImpl) {
  const id = String(clientId || '');
  if (!id) throw new OAuthError('invalid_request', 'client_id is required.');
  if (/^https:\/\//i.test(id)) return fetchClientMetadata(id, fetchImpl);
  const [[row]] = await db.execute('SELECT client_id,client_secret_hash,client_name,redirect_uris,auth_method FROM oauth_clients WHERE client_id=? LIMIT 1', [id.slice(0, 64)]);
  if (!row) throw new OAuthError('invalid_client', 'This app is not registered. Remove the connector in Claude and add it again.', 401);
  let redirectUris = [];
  try { redirectUris = JSON.parse(row.redirect_uris); } catch {}
  return { clientId: row.client_id, clientName: row.client_name, redirectUris, kind: 'dcr', authMethod: row.auth_method, secretHash: row.client_secret_hash };
}

// RFC 7591 registration. Only Claude's redirect URIs are accepted.
async function registerClient(db, body = {}) {
  const fail = (code, message) => { throw new OAuthError(code, message); };
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10) fail('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs.');
  if (uris.some(uri => !allowedRegisteredRedirect(uri))) {
    fail('invalid_redirect_uri', 'Only Claude can connect: use https://claude.ai/api/mcp/auth_callback or a loopback address.');
  }
  const method = String(body.token_endpoint_auth_method || 'none');
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) fail('invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
  const grants = body.grant_types == null ? ['authorization_code', 'refresh_token'] : body.grant_types;
  if (!Array.isArray(grants) || grants.some(g => !['authorization_code', 'refresh_token'].includes(g))) fail('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
  const responses = body.response_types == null ? ['code'] : body.response_types;
  if (!Array.isArray(responses) || responses.some(r => r !== 'code')) fail('invalid_client_metadata', 'Only the code response type is supported.');
  const clientName = String(body.client_name || 'Claude').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || 'Claude';
  const clientId = randomToken('cmmc_', 18);
  const secret = method === 'none' ? null : randomToken('cmms_', 32);
  await db.execute('INSERT INTO oauth_clients (client_id,client_secret_hash,client_name,redirect_uris,auth_method) VALUES (?,?,?,?,?)',
    [clientId, secret ? sha256(secret) : null, clientName, JSON.stringify(uris), method]);
  return {
    client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: clientName, redirect_uris: uris,
    token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  };
}

// ---------- Authorization ----------
function normalizeScope() { return SCOPE; }

// Checks an authorization request. Errors before the redirect URI is trusted
// are shown on the page (redirect: null); later ones go back to the app.
async function validateAuthorizationRequest(db, params, { base, fetchImpl } = {}) {
  const get = name => (params[name] == null ? '' : String(params[name]));
  let client;
  try { client = await resolveClient(db, get('client_id'), fetchImpl); }
  catch (error) { throw Object.assign(error instanceof OAuthError ? error : new OAuthError('server_error', 'The app could not be checked.'), { redirect: null }); }
  const redirectUri = get('redirect_uri');
  if (!redirectUri || !client.redirectUris.some(uri => redirectMatches(uri, redirectUri))) {
    throw Object.assign(new OAuthError('invalid_request', 'The app’s return address is not allowed.'), { redirect: null });
  }
  const back = (code, message) => Object.assign(new OAuthError(code, message), { redirect: redirectUri, state: get('state') });
  if (get('response_type') !== 'code') throw back('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = get('code_challenge');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || get('code_challenge_method') !== 'S256') throw back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  const resource = get('resource').replace(/\/$/, '');
  if (resource && resource !== base + '/mcp') throw back('invalid_target', 'Unknown resource.');
  return { client, redirectUri, state: get('state'), codeChallenge: challenge, scope: normalizeScope(get('scope')) };
}

async function issueCode(db, { client, userId, redirectUri, codeChallenge, scope }) {
  const code = randomToken('cmm_code_');
  await db.execute(`INSERT INTO oauth_codes (code_hash,client_id,client_name,user_id,redirect_uri,code_challenge,scope,expires_at)
    VALUES (?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))`,
  [sha256(code), client.clientId, client.clientName, userId, redirectUri, codeChallenge, scope, CODE_TTL_SECONDS]);
  return code;
}

function redirectWith(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(key, value);
  return url.toString();
}

// The consent form carries an HMAC of the signed-in session and the request,
// so another site cannot submit it for the customer.
function consentToken(secret, sessionHash, request, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  const payload = [sessionHash, request.client.clientId, request.redirectUri, request.codeChallenge, request.state, ts].join('\n');
  return ts + '.' + crypto.createHmac('sha256', secret).update('consent\n' + payload).digest('base64url');
}
function verifyConsentToken(secret, sessionHash, request, token, now = Date.now()) {
  const [ts] = String(token || '').split('.');
  if (!/^\d+$/.test(ts) || now / 1000 - Number(ts) > 1800 || Number(ts) - now / 1000 > 60) return false;
  const expected = consentToken(secret, sessionHash, request, Number(ts) * 1000);
  const a = Buffer.from(expected), b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Tokens ----------
function clientCredentials(params, authorization) {
  let clientId = params.client_id ? String(params.client_id) : '', secret = params.client_secret ? String(params.client_secret) : '';
  const match = /^Basic\s+(.+)$/i.exec(String(authorization || ''));
  if (match) {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) { clientId = decodeURIComponent(decoded.slice(0, i)); secret = decodeURIComponent(decoded.slice(i + 1)); }
  }
  return { clientId, secret };
}

async function authenticateClient(db, params, authorization, fetchImpl) {
  const { clientId, secret } = clientCredentials(params, authorization);
  const client = await resolveClient(db, clientId, fetchImpl).catch(error => { throw new OAuthError('invalid_client', error.message, 401); });
  if (client.authMethod !== 'none') {
    const a = Buffer.from(sha256(secret)), b = Buffer.from(String(client.secretHash || ''));
    if (!secret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
  }
  return client;
}

async function storeTokens(db, grant, { create }) {
  const access = randomToken('cmm_at_'), refresh = randomToken('cmm_rt_');
  if (create) {
    await db.execute(`INSERT INTO oauth_grants (id,user_id,client_id,client_name,scope,access_hash,access_expires_at,refresh_hash,refresh_expires_at,last_used_at)
      VALUES (?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY),UTC_TIMESTAMP())`,
    [grant.id, grant.userId, grant.clientId, grant.clientName, grant.scope, sha256(access), ACCESS_TTL_SECONDS, sha256(refresh), REFRESH_TTL_DAYS]);
  } else {
    // Only the request still holding the current refresh token wins.
    const [result] = await db.execute(`UPDATE oauth_grants SET access_hash=?,access_expires_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
      refresh_hash=?,refresh_expires_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY),last_used_at=UTC_TIMESTAMP()
      WHERE id=? AND refresh_hash=? AND revoked_at IS NULL`,
    [sha256(access), ACCESS_TTL_SECONDS, sha256(refresh), REFRESH_TTL_DAYS, grant.id, grant.refreshHash]);
    if (result.affectedRows !== 1) throw new OAuthError('invalid_grant', 'The refresh token is no longer valid.');
  }
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: grant.scope };
}

function verifyPkce(verifier, challenge) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(String(verifier || ''))) return false;
  const computed = crypto.createHash('sha256').update(String(verifier)).digest('base64url');
  const a = Buffer.from(computed), b = Buffer.from(String(challenge));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns {grant, tokens}; throws OAuthError with RFC 6749 codes.
async function exchangeToken(db, params, authorization, { fetchImpl } = {}) {
  const grantType = String(params.grant_type || '');
  if (grantType === 'authorization_code') {
    const client = await authenticateClient(db, params, authorization, fetchImpl);
    const codeHash = sha256(String(params.code || ''));
    const [used] = await db.execute('UPDATE oauth_codes SET used_at=UTC_TIMESTAMP() WHERE code_hash=? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP()', [codeHash]);
    if (used.affectedRows !== 1) throw new OAuthError('invalid_grant', 'The authorization code is invalid or expired.');
    const [[code]] = await db.execute('SELECT client_id,client_name,user_id,redirect_uri,code_challenge,scope FROM oauth_codes WHERE code_hash=?', [codeHash]);
    if (!code || code.client_id !== client.clientId) throw new OAuthError('invalid_grant', 'The authorization code was issued to another app.');
    if (String(params.redirect_uri || '') !== code.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
    if (!verifyPkce(params.code_verifier, code.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed.');
    const [[user]] = await db.execute("SELECT id FROM users WHERE id=? AND status='active'", [code.user_id]);
    if (!user) throw new OAuthError('invalid_grant', 'The CMM Tools account is unavailable.');
    const grant = { id: crypto.randomUUID(), userId: Number(code.user_id), clientId: client.clientId, clientName: code.client_name, scope: code.scope };
    return { grant, tokens: await storeTokens(db, grant, { create: true }) };
  }
  if (grantType === 'refresh_token') {
    const client = await authenticateClient(db, params, authorization, fetchImpl);
    const refreshHash = sha256(String(params.refresh_token || ''));
    const [[row]] = await db.execute(`SELECT g.id,g.user_id,g.client_id,g.client_name,g.scope FROM oauth_grants g JOIN users u ON u.id=g.user_id
      WHERE g.refresh_hash=? AND g.revoked_at IS NULL AND g.refresh_expires_at>UTC_TIMESTAMP() AND u.status='active' LIMIT 1`, [refreshHash]);
    if (!row || row.client_id !== client.clientId) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired.');
    const grant = { id: row.id, userId: Number(row.user_id), clientId: row.client_id, clientName: row.client_name, scope: row.scope, refreshHash };
    return { grant, tokens: await storeTokens(db, grant, { create: false }) };
  }
  throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

// The signed-in customer behind a bearer token, or null.
async function verifyAccessToken(db, token) {
  const value = String(token || '');
  if (!/^cmm_at_[A-Za-z0-9_-]{20,}$/.test(value)) return null;
  const [[row]] = await db.execute(`SELECT g.id,g.user_id,g.client_name,g.scope,g.last_used_at<UTC_TIMESTAMP()-INTERVAL 1 MINUTE AS stale
    FROM oauth_grants g JOIN users u ON u.id=g.user_id
    WHERE g.access_hash=? AND g.access_expires_at>UTC_TIMESTAMP() AND g.revoked_at IS NULL AND u.status='active' LIMIT 1`, [sha256(value)]);
  if (!row) return null;
  if (Number(row.stale)) db.execute('UPDATE oauth_grants SET last_used_at=UTC_TIMESTAMP() WHERE id=?', [row.id]).catch(() => {});
  return { grantId: row.id, userId: Number(row.user_id), clientName: row.client_name, scope: row.scope };
}

// RFC 7009: revoking either token ends the whole connection.
async function revokeToken(db, token) {
  const hash = sha256(String(token || ''));
  const [result] = await db.execute('UPDATE oauth_grants SET revoked_at=UTC_TIMESTAMP(),access_hash=NULL,refresh_hash=NULL WHERE (access_hash=? OR refresh_hash=?) AND revoked_at IS NULL', [hash, hash]);
  return result.affectedRows > 0;
}

async function listConnections(db, userId) {
  const [rows] = await db.execute(`SELECT id,client_name,client_id,created_at,last_used_at FROM oauth_grants
    WHERE user_id=? AND revoked_at IS NULL AND refresh_expires_at>UTC_TIMESTAMP() ORDER BY created_at DESC LIMIT 50`, [userId]);
  return rows.map(r => ({ id: r.id, name: r.client_name, app: /^https:\/\/claude\.(ai|com)\/oauth\/claude-code/.test(r.client_id) ? 'Claude Code' : r.client_name,
    connectedAt: r.created_at, lastUsedAt: r.last_used_at }));
}

async function revokeConnection(db, userId, grantId) {
  const [result] = await db.execute('UPDATE oauth_grants SET revoked_at=UTC_TIMESTAMP(),access_hash=NULL,refresh_hash=NULL WHERE id=? AND user_id=? AND revoked_at IS NULL', [String(grantId || ''), userId]);
  return result.affectedRows > 0;
}

async function pruneOAuth(db) {
  await db.execute('DELETE FROM oauth_codes WHERE expires_at<UTC_TIMESTAMP()-INTERVAL 1 DAY').catch(() => {});
  await db.execute('DELETE FROM oauth_grants WHERE (revoked_at IS NOT NULL OR refresh_expires_at<UTC_TIMESTAMP()) AND created_at<UTC_TIMESTAMP()-INTERVAL 30 DAY').catch(() => {});
  await db.execute(`DELETE FROM oauth_clients WHERE created_at<UTC_TIMESTAMP()-INTERVAL 30 DAY
    AND client_id NOT IN (SELECT client_id FROM oauth_grants WHERE revoked_at IS NULL)`).catch(() => {});
}

module.exports = {
  SCOPE, ACCESS_TTL_SECONDS, HOSTED_REDIRECTS, OAuthError, sha256,
  redirectMatches, allowedRegisteredRedirect, protectedResourceMetadata, authorizationServerMetadata,
  fetchClientMetadata, resolveClient, registerClient, validateAuthorizationRequest, issueCode, redirectWith,
  consentToken, verifyConsentToken, exchangeToken, verifyPkce, verifyAccessToken, revokeToken,
  listConnections, revokeConnection, pruneOAuth, isLoopback, parseUrl,
};

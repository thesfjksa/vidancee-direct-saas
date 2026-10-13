const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth = require('../src/mcp_oauth.js');
const mcp = require('../src/mcp_server.js');
const { isPublicAddress, fetchPublicImage } = require('../src/remote_image.js');

const BASE = 'https://cmmtools.site';

test('sign-in metadata lets Claude use its published client identity, PKCE and refresh tokens', () => {
  const resource = oauth.protectedResourceMetadata(BASE);
  assert.equal(resource.resource, BASE + '/mcp');
  assert.deepEqual(resource.authorization_servers, [BASE]);
  const server = oauth.authorizationServerMetadata(BASE);
  assert.equal(server.client_id_metadata_document_supported, true);
  assert.ok(server.token_endpoint_auth_methods_supported.includes('none'));
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.ok(server.scopes_supported.includes('offline_access'));
  assert.equal(server.registration_endpoint, BASE + '/oauth/register');
});

test('redirects: Claude callback exactly, loopback with any port, nothing else', () => {
  assert.ok(oauth.redirectMatches('http://localhost/callback', 'http://localhost:51873/callback'));
  assert.ok(oauth.redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:4000/callback'));
  assert.ok(!oauth.redirectMatches('http://localhost/callback', 'http://127.0.0.1:4000/callback'));
  assert.ok(!oauth.redirectMatches('http://localhost/callback', 'http://localhost:4000/other'));
  assert.ok(!oauth.redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/x'));
  assert.ok(oauth.allowedRegisteredRedirect('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(oauth.allowedRegisteredRedirect('http://localhost:6274/oauth/callback'));
  assert.ok(!oauth.allowedRegisteredRedirect('https://evil.example/cb'));
  assert.ok(!oauth.allowedRegisteredRedirect('https://claude.ai.evil.example/api/mcp/auth_callback'));
});

test('registration accepts Claude and refuses other redirect addresses', async () => {
  const rows = [];
  const db = { async execute(sql, args) { rows.push(args); return [{ affectedRows: 1 }]; } };
  const pub = await oauth.registerClient(db, { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  assert.match(pub.client_id, /^cmmc_/);
  assert.equal(pub.client_secret, undefined);
  const conf = await oauth.registerClient(db, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_post' });
  assert.match(conf.client_secret, /^cmms_/);
  assert.equal(rows[1][1], oauth.sha256(conf.client_secret)); // only the hash is stored
  await assert.rejects(oauth.registerClient(db, { redirect_uris: ['https://evil.example/cb'] }), e => e.code === 'invalid_redirect_uri');
  await assert.rejects(oauth.registerClient(db, { redirect_uris: [] }), e => e.code === 'invalid_redirect_uri');
});

test('client metadata documents are fetched only from Claude and must name themselves', async () => {
  await assert.rejects(oauth.fetchClientMetadata('https://evil.example/client.json', async () => assert.fail('fetched')), e => e.code === 'invalid_client');
  const url = 'https://claude.ai/oauth/test-client-' + crypto.randomUUID();
  const doc = { client_id: url, client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' };
  const client = await oauth.fetchClientMetadata(url, async () => new Response(JSON.stringify(doc)));
  assert.equal(client.clientName, 'Claude');
  const other = 'https://claude.ai/oauth/test-client-' + crypto.randomUUID();
  await assert.rejects(oauth.fetchClientMetadata(other, async () => new Response(JSON.stringify(doc))), e => e.code === 'invalid_client');
});

test('authorization requests need a registered redirect and S256 PKCE', async () => {
  const doc = { client_id: 'https://claude.ai/oauth/claude-code-client-metadata', client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' };
  const fetchImpl = async () => new Response(JSON.stringify(doc));
  const challenge = crypto.createHash('sha256').update('v'.repeat(50)).digest('base64url');
  const params = { response_type: 'code', client_id: doc.client_id, redirect_uri: 'http://localhost:9999/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: BASE + '/mcp' };
  const request = await oauth.validateAuthorizationRequest({}, params, { base: BASE, fetchImpl });
  assert.equal(request.client.clientName, 'Claude Code');
  await assert.rejects(oauth.validateAuthorizationRequest({}, { ...params, redirect_uri: 'https://evil.example/cb' }, { base: BASE, fetchImpl }), e => e.redirect === null);
  await assert.rejects(oauth.validateAuthorizationRequest({}, { ...params, code_challenge_method: 'plain' }, { base: BASE, fetchImpl }), e => e.redirect === params.redirect_uri && e.code === 'invalid_request');
  await assert.rejects(oauth.validateAuthorizationRequest({}, { ...params, resource: 'https://other.example/mcp' }, { base: BASE, fetchImpl }), e => e.code === 'invalid_target');

  // The consent form is bound to the session and the request.
  const secret = crypto.randomBytes(32);
  const token = oauth.consentToken(secret, 'session-a', request);
  assert.ok(oauth.verifyConsentToken(secret, 'session-a', request, token));
  assert.ok(!oauth.verifyConsentToken(secret, 'session-b', request, token));
  assert.ok(!oauth.verifyConsentToken(secret, 'session-a', { ...request, redirectUri: 'http://localhost:1/callback' }, token));
  assert.ok(!oauth.verifyConsentToken(secret, 'session-a', request, token, Date.now() + 3600 * 1000));
});

test('PKCE verification', () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.ok(oauth.verifyPkce(verifier, challenge));
  assert.ok(!oauth.verifyPkce(verifier + 'x', challenge));
  assert.ok(!oauth.verifyPkce('short', challenge));
});

// ---------- MCP protocol ----------
function fakeServices(overrides = {}) {
  const calls = [];
  const video = { id: 'argo_seedance_2_5', label: 'Seedance 2.5', defaultResolution: '720p', defaultDuration: 5, defaultAspectRatio: '16:9',
    resolutions: [{ id: '720p' }, { id: '1080p' }], durations: [4, 5, 6, 7, 8].map(seconds => ({ seconds })), aspectRatios: ['16:9', '9:16'], supportsAudio: true,
    capabilities: { textOnly: true, image: { supported: true, max: 9, roles: ['start_image', 'end_image', 'image_references'] } } };
  const services = {
    calls,
    account: async () => ({ email: 'a@example.com', credits: 5000 }),
    catalog: async () => ({ video: [video], image: [], upscaler: { enabled: false, resolutions: [] } }),
    quote: async () => ({ cost: 2857, isEstimate: false }),
    loadReference: async (_u, ref) => ({ filename: 'p.png', mimeType: 'image/png', data: Buffer.from(JSON.stringify(ref)) }),
    submitVideo: async (_u, body) => { calls.push(body); return { generation: { id: '9f937e14-6304-49c4-821c-a23623462ffa', status: 'queued', model: body.model, credits_cost: 2857, aspect_ratio: body.aspectRatio, media_type: 'video' }, credits: 2143 }; },
    shareUrl: id => BASE + '/media-share/' + id,
    wake: () => {},
    ...overrides,
  };
  return services;
}
const ctxFor = (services, extra = {}) => ({ user: { id: 7 }, base: BASE, services, log: () => {}, protocolHeader: null, ...extra });
const call = (ctx, name, args) => mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);

test('legacy clients (Claude today) get the initialize handshake; modern clients get server/discover', async () => {
  const ctx = ctxFor(fakeServices());
  let out = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }, ctx);
  assert.equal(out.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(out.body.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(out.body.result.serverInfo.icons, [{ src: BASE + '/assets/cmmtools-mcp-icon.png', mimeType: 'image/png', sizes: ['512x512'] }]);
  out = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2030-01-01' } }, ctx);
  assert.equal(out.body.result.protocolVersion, '2025-11-25');
  assert.equal((await mcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)).status, 202);

  const modern = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };
  out = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: modern }, { ...ctx, protocolHeader: '2026-07-28' });
  assert.equal(out.body.result.resultType, 'complete');
  assert.ok(out.body.result.supportedVersions.includes('2025-11-25'));
  out = await mcp.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: modern }, ctx);
  assert.equal(out.body.result.cacheScope, 'public');
  assert.ok(out.body.result.ttlMs >= 0);
  out = await mcp.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } } }, ctx);
  assert.deepEqual([out.status, out.body.error.code], [400, -32022]);
  out = await mcp.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: modern }, { ...ctx, protocolHeader: '2025-11-25' });
  assert.deepEqual([out.status, out.body.error.code], [400, -32020]);
  out = await mcp.handleMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list', params: modern }, ctx);
  assert.deepEqual([out.status, out.body.error.code], [404, -32601]);
  out = await mcp.handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list', params: {} }, ctx);
  assert.deepEqual([out.status, out.body.error.code], [200, -32601]);
  assert.equal((await mcp.handleBody('{not json', ctx)).body.error.code, -32700);
});

test('every tool has a title, the right read-only hint and a short name', () => {
  const readOnly = new Set(['get_account', 'list_models', 'estimate_cost', 'get_job', 'list_jobs', 'list_uploads']);
  for (const tool of mcp.TOOLS) {
    assert.ok(tool.name.length <= 64);
    assert.ok(tool.title && tool.annotations.title);
    assert.equal(tool.annotations.readOnlyHint, readOnly.has(tool.name), tool.name);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('create_video sends references the way Video Studio does and reports the job', async () => {
  const services = fakeServices(), ctx = ctxFor(services);
  let out = await call(ctx, 'create_video', { model: 'argo_seedance_2_5', prompt: 'An ad', aspect_ratio: '9:16', reference_images: [{ upload_id: 'u1' }] });
  const body = services.calls[0];
  assert.equal(out.body.result.isError, undefined);
  assert.equal(out.body.result.structuredContent.job_id, '9f937e14-6304-49c4-821c-a23623462ffa');
  assert.equal(out.body.result.structuredContent.credits_left, 2143);
  assert.deepEqual([body.duration, body.resolution, body.aspectRatio, body.generateAudio], [5, '720p', '9:16', true]);
  assert.deepEqual(JSON.parse(body.referenceOrder), [{ kind: 'fresh', index: 0, role: 'image_references' }]);
  assert.equal(body.images.length, 1);

  await call(ctx, 'create_video', { model: 'argo_seedance_2_5', prompt: 'x', image_mode: 'first_and_last_frame', reference_images: [{ upload_id: 'a' }, { image_job_id: 'b' }] });
  assert.deepEqual(JSON.parse(services.calls[1].referenceOrder).map(r => r.role), ['start_image', 'end_image']);

  out = await call(ctx, 'create_video', { model: 'argo_seedance_2_5', prompt: 'x', image_mode: 'first_frame', reference_images: [{ upload_id: 'a' }, { upload_id: 'b' }] });
  assert.equal(out.body.result.isError, true);
  out = await call(ctx, 'create_video', { model: 'unknown', prompt: 'x' });
  assert.match(out.body.result.content[0].text, /list_models/);
  out = await call(ctx, 'create_video', { model: 'argo_seedance_2_5', prompt: 'x', reference_images: [{ upload_id: 'a', url: 'https://x' }] });
  assert.match(out.body.result.content[0].text, /exactly one/);
  out = await call(ctx, 'create_video', { model: 'argo_seedance_2_5', prompt: 'x', colour: 'red' });
  assert.match(out.body.result.content[0].text, /Unknown argument/);
  assert.equal(services.calls.length, 2);
});

test('account limits come back as readable tool errors; unexpected failures stay generic', async () => {
  const limited = fakeServices({ submitVideo: async () => { throw Object.assign(new Error('Not enough credits.'), { statusCode: 402 }); } });
  let out = await call(ctxFor(limited), 'create_video', { model: 'argo_seedance_2_5', prompt: 'x' });
  assert.deepEqual([out.body.result.isError, out.body.result.content[0].text], [true, 'Not enough credits.']);
  const broken = fakeServices({ account: async () => { throw new Error('ECONNRESET db'); } });
  const original = console.error; console.error = () => {};
  try { out = await call(ctxFor(broken), 'get_account', {}); } finally { console.error = original; }
  assert.equal(out.body.result.isError, true);
  assert.doesNotMatch(out.body.result.content[0].text, /ECONNRESET/);
});

test('get_job waits for a running job and returns a download link when it finishes', async () => {
  let polls = 0;
  const services = fakeServices({
    getJob: async () => (++polls < 2 ? { id: 'j', status: 'processing', media_type: 'video', credits_cost: 1 }
      : { id: 'j', status: 'completed', has_video: true, media_type: 'video', credits_cost: 1 }),
  });
  const ctx = ctxFor(services);
  const out = await call(ctx, 'get_job', { job_id: '9f937e14-6304-49c4-821c-a23623462ffa', wait_seconds: 5 });
  assert.equal(out.body.result.structuredContent.status, 'completed');
  assert.equal(out.body.result.structuredContent.download_url, BASE + '/media-share/j');
});

test('model summaries keep what Claude needs', () => {
  const summary = mcp.videoModelSummary({ id: 'm', label: 'M', resolutions: [{ id: '720p' }], durations: [4, 5, 6, 7].map(seconds => ({ seconds })),
    aspectRatios: ['9:16'], capabilities: { image: { supported: true, max: 2, roles: ['start_image', 'image_references'] } } });
  assert.deepEqual(summary.durations_seconds, { min: 4, max: 7 });
  assert.deepEqual(summary.reference_images, { max: 2, modes: ['reference', 'first_frame'] });
  assert.equal(mcp.imagePriceFromCatalog({ cost: 10, costByQuality: { high: { '1:1': 30 } } }, { aspectRatio: '1:1', quality: 'high' }), 30);
  assert.equal(mcp.imagePriceFromCatalog({ dynamicCost: true, qualities: [], imageSizes: ['1K'], costTable: { '1:1||1K': 405 } }, { aspectRatio: '1:1', imageSize: '1K' }), 405);
});

test('reference links reach only public https addresses', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700::1111'), true);
  await assert.rejects(fetchPublicImage('http://example.com/a.png'), /https/);
  await assert.rejects(fetchPublicImage('https://169.254.169.254/latest/meta-data'), /private address/);
  // A hostname that resolves to the server's own network is refused at connect time.
  await assert.rejects(fetchPublicImage('https://localhost/a.png'), /private address/);
});

test('the MCP endpoint asks for sign-in with a pointer to its metadata', async () => {
  const { createConnector } = require('../src/connector.js');
  const sent = [];
  const connector = createConnector({
    getPool: () => ({ execute: async () => [[]] }), requireDatabase: () => {}, publicOrigin: () => BASE,
    sendJson: (res, status, body) => { sent.push({ status, body, headers: res.headers }); },
    getSettingValue: async () => '1', logActivity: () => {},
  });
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, once() {} };
  const req = { method: 'POST', headers: {} };
  assert.equal(await connector.handle(req, res, new URL(BASE + '/mcp'), '/mcp'), true);
  assert.equal(sent[0].status, 401);
  assert.equal(res.headers['www-authenticate'], 'Bearer resource_metadata="' + BASE + '/.well-known/oauth-protected-resource/mcp", scope="cmm"');
  // A web page on another site cannot call it from a browser.
  sent.length = 0;
  await connector.handle({ method: 'POST', headers: { origin: 'https://evil.example' } }, res, new URL(BASE + '/mcp'), '/mcp');
  assert.equal(sent[0].status, 403);
  assert.equal(await connector.handle(req, res, new URL(BASE + '/api/generations'), '/api/generations'), false);
});

test('a public image link downloads, follows a redirect and rejects non-images', async t => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), https = require('node:https');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-img-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
      '-days', '1', '-subj', '/CN=images.test', '-addext', 'subjectAltName=DNS:images.test'], { stdio: 'ignore' });
  } catch { t.skip('openssl is not available'); return; }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    if (req.url === '/old.png') { res.writeHead(302, { location: '/product.png' }); return res.end(); }
    if (req.url === '/product.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Test-only resolver: images.test is the local server.
  const lookup = (_h, options, cb) => (options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
  const options = { lookup, ca: fs.readFileSync(path.join(dir, 'c.pem')) };
  const base = 'https://images.test:' + server.address().port;
  const image = await fetchPublicImage(base + '/old.png', options);
  assert.deepEqual([image.mimeType, image.data.length, image.filename], ['image/png', png.length, 'product.png']);
  await assert.rejects(fetchPublicImage(base + '/page', options), /not a JPEG, PNG or WebP/);
  await assert.rejects(fetchPublicImage(base + '/product.png', { ...options, maxBytes: 10 }), /larger than 15 MB/);
});

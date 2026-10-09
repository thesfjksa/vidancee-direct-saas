const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { GEMINI_ENHANCER_MODEL } = require('../src/prompt_enhancer.js');

test('enhancement HTTP routes enforce auth/settings, encrypt keys, preserve credits and use Gemini', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'test-admin-only';
  const values = new Map();
  const users = new Map([1, 2].map(id => [id, { id, email: 'user'+id+'@example.com', credits: 2000, status: 'active', plan_code: 'pro' }]));
  async function execute(sql, args = []) {
    if (sql.startsWith('CREATE')) return [[]];
    if (sql.includes('SELECT setting_key')) return [[...values.values()]];
    if (sql.includes('INSERT INTO app_settings')) { values.set(args[0], { setting_key: args[0], setting_value: args[1], is_secret: args[2] }); return [{ affectedRows: 1 }]; }
    if (sql.includes('DELETE FROM app_settings')) { values.delete(args[0]); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('SELECT provider,enabled')) return [[]];
    throw Error('Unexpected SQL (enhancement must not alter customer credits): '+sql);
  }
  const dbModule = require('../src/db.js'); const originalDb = { ...dbModule };
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => ({ query: execute, execute }), initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const auth = require('../src/auth.js'); const originalAuth = { ...auth };
  auth.userFromRequest = async req => users.get(Number(req.headers['x-test-user'] || 1));
  auth.requireUser = async req => { const user = await auth.userFromRequest(req); if (!user) throw Object.assign(Error('Authentication required.'), { statusCode: 401 }); return user; };
  const realFetch = globalThis.fetch; let calls = 0; let mode = 'ok';
  globalThis.fetch = async (url, options) => {
    assert.match(url, /^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\/gemini-3\.8-flash/);
    assert.equal(options.headers['x-goog-api-key'], 'test-gemini-secret');
    if (options.method === 'GET') return Response.json({ name: 'models/'+GEMINI_ENHANCER_MODEL, supportedGenerationMethods: ['generateContent'] });
    calls++;
    if (mode === 'fail') return Response.json({ error: 'test-gemini-secret' }, { status: 503 });
    if (mode === 'blocked') return Response.json({ promptFeedback: { blockReason: 'SAFETY' } });
    const body = JSON.parse(options.body);
    if (!['low', 'medium', 'high'].includes(body.generationConfig.thinkingConfig.thinkingLevel)) {
      return Response.json({ error: { status: 'INVALID_ARGUMENT', message: 'Unsupported thinking level' } }, { status: 400 });
    }
    assert.equal(JSON.parse(body.contents[0].parts[0].text).prompt, 'A child dancing');
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'A realistic child dancing in a quiet street.' }] } }] });
  };
  const server = require('../server.js');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); globalThis.fetch = realFetch; Object.assign(dbModule, originalDb); Object.assign(auth, originalAuth); });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:'+server.address().port;
  async function request(path, { admin = false, method = 'GET', body, user = 1 } = {}) {
    const response = await realFetch(origin+path, { method, headers: { 'x-test-user': String(user), ...(admin ? { 'x-admin-token': 'test-admin-only' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const input = { prompt: 'A child dancing', mediaType: 'image', aspectRatio: '1:1' };
  assert.equal((await request('/api/prompts/enhance', { method: 'POST', body: input, user: 0 })).status,401);
  assert.equal((await request('/api/prompts/enhance', { method: 'POST', body: input })).status,503);
  assert.equal((await request('/admin/prompt-enhancer/check', { method: 'POST' })).status,401);
  const saved = await request('/admin/provider-settings', { admin: true, method: 'POST', body: { promptEnhancerApiKey: 'test-gemini-secret', promptEnhancerEnabled: true, allowProviderCharges: true } });
  assert.equal(saved.status,200); assert.equal(saved.data.settings.promptEnhancer.active,true);
  assert.equal(saved.data.settings.promptEnhancer.model,GEMINI_ENHANCER_MODEL);
  assert.equal(JSON.stringify(saved.data).includes('test-gemini-secret'),false);
  assert.match(values.get('prompt_enhancer_gemini_api_key').setting_value,/^v1:/);
  assert.equal(values.get('prompt_enhancer_gemini_api_key').is_secret,1);
  const config = await request('/api/config'); assert.equal(config.data.promptEnhancer.enabled,true);
  assert.equal(config.data.promptEnhancer.revision,2);
  assert.equal(JSON.stringify(config.data).includes('gemini'),false);
  assert.equal((await request('/admin/prompt-enhancer/check', { admin: true, method: 'POST' })).status,200);
  for (const mediaType of ['image','video']) {
    const result = await request('/api/prompts/enhance', { method: 'POST', body: { ...input, mediaType } });
    assert.equal(result.status,200); assert.equal(result.data.prompt,'A realistic child dancing in a quiet street.');
  }
  assert.equal(calls,2); assert.equal(users.get(1).credits,2000);
  for (const body of [{ ...input, prompt: '' }, { ...input, mediaType: 'audio' }, { ...input, prompt: 'x'.repeat(8001) }]) {
    assert.equal((await request('/api/prompts/enhance', { method: 'POST', body })).status,400);
  }
  assert.equal(calls,2);
  users.get(2).status = 'disabled';
  assert.equal((await request('/api/prompts/enhance', { method: 'POST', body: input, user: 2 })).status,403);
  users.get(2).status = 'active'; mode = 'fail';
  const failure = await request('/api/prompts/enhance', { method: 'POST', body: input, user: 2 });
  assert.equal(failure.status,502); assert.equal(JSON.stringify(failure.data).includes('test-gemini-secret'),false);
  assert.match(failure.data.error,/temporarily unavailable \(HTTP 503\)/);
  mode = 'blocked'; assert.equal((await request('/api/prompts/enhance', { method: 'POST', body: input, user: 2 })).status,422); mode = 'ok';
  for (let i=0;i<4;i++) assert.equal((await request('/api/prompts/enhance', { method: 'POST', body: input })).status,200);
  assert.equal((await request('/api/prompts/enhance', { method: 'POST', body: input })).status,429);
  for (const settings of [{ promptEnhancerEnabled: false }, { promptEnhancerEnabled: true, allowProviderCharges: false }, { allowProviderCharges: true, clearPromptEnhancerApiKey: true }]) {
    await request('/admin/provider-settings', { admin: true, method: 'POST', body: settings });
    assert.equal((await request('/api/config')).data.promptEnhancer.enabled,false);
    assert.equal((await request('/api/prompts/enhance', { method: 'POST', body: input })).status,503);
  }
  assert.equal(values.has('prompt_enhancer_gemini_api_key'),false); assert.equal(users.get(1).credits,2000);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

test('Video Studio lists MiniMax H3 and the admin can rename any model', async t => {
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.WORKER_ENABLED = 'false'; process.env.ADMIN_TOKEN = 'test-admin-only';
  const user = { id: 1, email: 'test1@example.com', credits: 50, status: 'active', plan_code: 'pro', role: 'user' };
  // vgenv is configured; no other source is.
  const settings = new Map([['vgenv_api_key', 'vg-test']]);
  async function execute(sql, args = []) {
    if (sql.includes('SELECT setting_key')) return [[...settings].map(([setting_key, setting_value]) => ({ setting_key, setting_value, is_secret: 0 }))];
    if (sql.startsWith('INSERT INTO app_settings')) { settings.set(args[0], args[1]); return [{ affectedRows: 1 }]; }
    if (/^\s*SELECT/i.test(sql)) return [[]];
    return [{ affectedRows: 0 }];
  }
  const db = { execute, query: execute };
  const dbModule = require('../src/db.js'); const originalDb = { ...dbModule };
  Object.assign(dbModule, { dbConfigured: () => true, getPool: () => db, initDb: async () => true, dbHealth: async () => ({ connected: true }) });
  const auth = require('../src/auth.js'); const originalAuth = { ...auth };
  auth.requireUser = async () => user; auth.userFromRequest = async () => user;
  // Simulate a ready Edge agent without contacting the provider.
  const aividModels=require('../src/aivid_models.js');
  const originalQuoteAivid=aividModels.quoteAivid;
  let aividQuoteCalls=0;
  aividModels.quoteAivid=async()=>{aividQuoteCalls++;return {cost:100,isEstimate:false};};
  const aividSettings=require('../src/aivid_settings.js');
  const originalAividSettings=aividSettings.getAividSettings;
  aividSettings.getAividSettings=async()=>({
    enabled:true,maxSourceCredits:40,mode:'rdp',browser:'edge',
    rdpDevice:{deviceId:'mock',tokenHash:'mock',status:'ready',browser:'edge',seenAt:new Date().toISOString()},
  });
  const server = require('../server.js');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    Object.assign(dbModule, originalDb); Object.assign(auth, originalAuth);
    aividSettings.getAividSettings=originalAividSettings;
    aividModels.quoteAivid=originalQuoteAivid;
  });
  if (!server.listening) await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const admin = { 'content-type': 'application/json', 'x-admin-token': 'test-admin-only' };

  let config = await (await fetch(origin + '/api/config')).json();
  // Seedance Lite (Vidancee/CreatePulse) was removed.
  assert.equal(config.pricing.some(m => m.id === 'seedance_2.5' || m.id === 'seedance_2.0_fast'), false);
  const h3 = config.pricing.find(m => m.id === 'minimax_h3');
  assert.equal(h3.label, 'MiniMax H3 Base · up to 15 s');
  assert.equal(h3.warning, undefined);
  assert.deepEqual(h3.resolutions.map(r => r.id), ['480p', '768p']);
  assert.equal(h3.defaultResolution, '768p');
  assert.ok(h3.durations.length && h3.aspectRatios.length && h3.capabilities.image.supported);
  assert.deepEqual(config.cartoon.pricing.map(m => m.id), ['minimax_h3', 'minimax_h3_cinematic', 'minimax_h3_origin', 'minimax_beast']);
  assert.ok(config.pricing.some(m => m.id === 'minimax_beast' && m.label === 'Minimax Beast · up to 15 s'));
  const originModel = config.pricing.find(m => m.id === 'minimax_h3_origin');
  const cmmOrigin = config.pricing.find(m => m.id === 'cmmtools_origin_2_0');
  assert.deepEqual(cmmOrigin, { ...originModel, id: 'cmmtools_origin_2_0', label: 'CMMTools Origin 2.0 · up to 15 s' });
  assert.ok(!config.cartoon.pricing.some(m => m.id === 'cmmtools_origin_2_0'));
  assert.ok(!config.pricing.some(m => m.id === 'minimax_h3_origin_standard'));
  const retiredStandardQuote = await fetch(origin + '/api/model-cost', {
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model:'minimax_h3_origin_standard',mediaType:'video',duration:10,resolution:'768p',aspectRatio:'16:9'}),
  });
  assert.equal(retiredStandardQuote.status,404);
  assert.ok(!config.cartoon.pricing.some(m => m.id === 'minimax_h3_origin_standard'));
  // Retired IDs stay out of customer lists and direct quotes, even with a ready agent.
  for(const {id} of aividModels.SPECS){
    assert.equal(config.pricing.some(model=>model.id===id),false,id);
    const response=await fetch(origin+'/api/model-cost',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:id,mediaType:'video',duration:10,resolution:'720p',aspectRatio:'16:9'}),
    });
    assert.equal(response.status,404,id);
  }
  assert.equal(aividQuoteCalls,0);

  // CMM Mini (historical seedance_2_0_mini ID) is fully retired from user choice.
  assert.equal(config.pricing.some(m=>m.id==='seedance_2_0_mini'),false);
  assert.ok(!config.cartoon.pricing.some(m=>m.id==='seedance_2_0_mini'));
  const oldSkuQuote = await fetch(origin + '/api/model-cost', {
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model:'seedance_2_0_mini',mediaType:'video',duration:10,resolution:'768p',aspectRatio:'16:9'}),
  });
  assert.equal(oldSkuQuote.status,404);
  assert.ok(config.cartoon.pricing.some(m => m.id === 'minimax_beast' && m.label === 'Minimax Beast'));

  const list = await (await fetch(origin + '/admin/model-names', { headers: admin })).json();
  assert.ok(list.models.some(m => m.key === 'video:minimax_h3' && m.vendor === 'vgenv' && m.defaultName === 'MiniMax H3 Base · up to 15 s' && m.name === ''));
  assert.ok(list.models.some(m => m.key === 'cartoon:minimax_h3'));
  assert.ok(list.models.some(m => m.key === 'video:cmmtools_origin_2_0' && m.vendor === 'vgenv'));
  assert.ok(!list.models.some(m => m.key === 'cartoon:cmmtools_origin_2_0'));
  assert.ok(!list.models.some(m => m.key === 'video:minimax_h3_origin_standard'));
  assert.ok(!list.models.some(m => m.key === 'cartoon:minimax_h3_origin_standard'));
  assert.equal(list.models.some(m => m.key === 'video:seedance_2_0_mini'),false);
  for(const m of aividModels.SPECS)
    assert.equal(list.models.some(row=>row.key==='video:'+m.id),false,m.id);
  assert.equal(list.models.some(m => m.key === 'cartoon:seedance_2_0_mini'),false);
  assert.equal(list.models.some(m => m.key.endsWith(':seedance_2.5')), false);

  const save = body => fetch(origin + '/admin/model-names', { method: 'POST', headers: admin, body: JSON.stringify(body) });
  assert.equal((await save({ names: { 'video:minimax_h3': 'MiniMax Long' } })).status, 200);
  assert.equal((await save({ names: { 'audio:x': 'Nope' } })).status, 400);
  // HD enhance is set here too, for ArgoLink and Higgsfield video models only.
  assert.equal((await save({ hd: { minimax_h3: false } })).status, 400);
  assert.equal((await save({ hd: { argo_seedance_2_5: false } })).status, 200);
  assert.deepEqual(JSON.parse(settings.get('argolink_hd_off_models')), ['argo_seedance_2_5']);
  await save({ hd: { argo_seedance_2_5: true } });
  assert.deepEqual(JSON.parse(settings.get('argolink_hd_off_models')), []);
  assert.equal((await save({ names: { 'video:minimax_h3': 'x'.repeat(81) } })).status, 400);
  assert.equal((await fetch(origin + '/admin/model-names', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

  config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.pricing.find(m => m.id === 'minimax_h3').label, 'MiniMax Long');
  // Names are per studio: Cartoon Studio keeps its own.
  assert.equal(config.cartoon.pricing.find(m => m.id === 'minimax_h3').label, 'MiniMax H3 Base');

  // An empty name goes back to the source's name.
  await save({ names: { 'video:minimax_h3': '' } });
  config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.pricing.find(m => m.id === 'minimax_h3').label, 'MiniMax H3 Base · up to 15 s');
});

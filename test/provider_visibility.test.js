'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { PROVIDERS, readModelVisibility, validateVisibilityPatch, visibleProviderAccess } = require('../src/provider_visibility.js');

const saved = new Map();
const writes = [];
const secretFlags = new Map();
const db = {
  query: async () => [[...saved].map(([setting_key, setting_value]) => ({ setting_key, setting_value, is_secret: secretFlags.get(setting_key)||0 }))],
  execute: async (sql, params) => {
    if(sql.startsWith('DELETE FROM app_settings')){saved.delete(params[0]);secretFlags.delete(params[0]);return [{affectedRows:1}];}
    assert.match(sql, /INSERT INTO app_settings/);
    writes.push(params); saved.set(params[0], params[1]); secretFlags.set(params[0],params[2]); return [{ affectedRows: 1 }];
  },
};
require('../src/db.js').getPool = () => db;
const { getProviderSettings, getAdminProviderSettings, updateProviderSettings } = require('../src/settings.js');

test('existing installations retain visibility and hidden sources cannot grant denied account access', () => {
  assert.ok(Object.values(readModelVisibility(() => undefined)).every(Boolean));
  for (const provider of PROVIDERS) {
    const visibility = readModelVisibility(key => key === provider + '_models_visible' ? 'false' : undefined);
    const access = Object.fromEntries(PROVIDERS.map(key => [key, true]));
    assert.equal(visibleProviderAccess(access, visibility)[provider], false);
    assert.equal(access[provider], true, 'saved customer permissions are unchanged');
    assert.equal(visibleProviderAccess({ [provider]: false }, { [provider]: true })[provider], false);
  }
});

test('visibility saves persist independently without altering provider enablement or credentials', async () => {
  saved.clear(); writes.length = 0;
  saved.set('vgenv_enabled', 'true');
  await updateProviderSettings({ providerModelVisibility: { vgenv: false, fal: false } });
  assert.deepEqual(writes.map(row => row[0]).sort(), ['fal_models_visible', 'vgenv_models_visible']);
  assert.equal((await getProviderSettings()).vgenvEnabled, true);
  assert.equal((await getAdminProviderSettings()).providerModelVisibility.vgenv, false);
  await updateProviderSettings({ providerModelVisibility: { vgenv: true } });
  const settings = await getAdminProviderSettings();
  assert.equal(settings.providerModelVisibility.vgenv, true);
  assert.equal(settings.providerModelVisibility.fal, false, 'saving another source preserves hidden providers');
  assert.equal(settings.providerModelVisibility.vibi, true);
});

test('invalid checkbox payloads fail before any settings write', async () => {
  for (const value of [null, [], 'false', { fal: 'false' }, { unknown: false }]) {
    assert.throws(() => validateVisibilityPatch(value), error => error.statusCode === 400);
    const before = writes.length;
    await assert.rejects(updateProviderSettings({ vgenvEnabled: false, providerModelVisibility: value }), error => error.statusCode === 400);
    assert.equal(writes.length, before);
  }
});

test('customer catalog removes every hidden provider while preserving the Admin source catalog', async () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const start = source.indexOf('async function customerMediaCatalog(');
  const end = source.indexOf('async function api888StudioCatalog(', start);
  let seen;
  const context = { visibleProviderAccess, isRetiredModel: () => false,
    applyModelNames: (studio, models) => models,
    sourceMediaCatalog: async access => { seen = access; return { video: PROVIDERS.filter(key => access[key]).map(id => ({ id })), image: [] }; } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const access = Object.fromEntries(PROVIDERS.map(key => [key, true]));
  for (const key of PROVIDERS) {
    const catalog = await context.customerMediaCatalog(access, { providerModelVisibility: { [key]: false } }, { names: {} });
    assert.equal(catalog.video.some(model => model.id === key), false);
    assert.equal(catalog.video.length, PROVIDERS.length - 1);
    assert.equal(seen[key], false);
    assert.equal(access[key], true);
  }
});

test('public config hides cartoon, voice and upscaler controls when their providers are hidden', async () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const start = source.indexOf("    if (req.method==='GET' && routePath==='/api/config')");
  const end = source.indexOf('// Explicitly retire the old routes', start);
  let result;
  const access = Object.fromEntries(PROVIDERS.map(key => [key, true]));
  const context = {
    req: { method: 'GET' }, routePath: '/api/config', res: {},
    dbConfigured: () => true, userFromRequest: async () => null,
    defaultCustomerProviderAccess: () => ({ ...access }), visibleProviderAccess,
    getAdminProviderSettings: async () => ({ providerModelVisibility: { vgenv: false, sluice: false, vibi: false, fal: false },
      vgenv: { active: true }, sluice: { active: true }, vibi: { active: true } }),
    modelDisplayNames: async () => ({}), applyModelNames: (studio, models) => models,
    publicPricing: () => [{ id: 'minimax_h3' }], CARTOON_MODELS: ['minimax_h3'],
    sluiceCartoonPricing: async () => [{ id: 'sluice' }],
    customerMediaCatalog: async effective => ({ video: [], image: [], upscaler: { enabled: effective.fal } }),
    userPriceRate: async () => 1, scalePrices: value => value,
    publicUpscalerConfig: enabled => ({ enabled }), publicCartoonConfig: (enabled, pricing) => ({ enabled, pricing }),
    publicDopeAccess: value => value, publicPlans: () => [],
    allowSignups: true, ASPECT_RATIOS: [], IMAGE_ASPECT_RATIOS: [], SUPPORT_WHATSAPP: '', whatsappUrl: () => '',
    logActivity: () => assert.fail('config should not fail'), sendJson: (res, status, body) => { result = body; },
  };
  vm.createContext(context);
  await vm.runInContext('(async () => {' + source.slice(start, end) + '})()', context);
  assert.equal(result.catalogError, false);
  assert.equal(result.cartoon.enabled, false);
  assert.equal(result.voice.enabled, false);
  assert.equal(result.upscaler.enabled, false);
  assert.equal(result.providerAccess.vgenv, false);
  assert.equal(result.providerAccess.vercel, true);
});

test('Admin controls save one provider, retain unsaved values across navigation and recover from save errors', async () => {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { checked: true, disabled: true, textContent: '', className: '', value: '' });
    return elements.get(id);
  };
  const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
  for (const provider of PROVIDERS) assert.ok(html.includes('id="modelsVisible-' + provider + '"'), provider);
  let request, fail = false;
  const context = { window: {}, setInterval:()=>{}, document: { getElementById: el, querySelectorAll: () => [] },
    api: async (path, options) => {
      request = { path, method: options.method, ...JSON.parse(options.body) };
      if (fail) throw new Error('Could not save');
      return { settings: JSON.parse(options.body) };
    } };
  vm.createContext(context); vm.runInContext(fs.readFileSync(require.resolve('../public/provider-admin.js'), 'utf8'), context);
  const ui = context.window;
  ui.loadProviderModelVisibility(Object.fromEntries(PROVIDERS.map(key => [key, true])));
  assert.equal(el('modelsVisible-vgenv').disabled, false);
  el('modelsVisible-vgenv').checked = false; el('saveModelsVisible-vgenv').disabled = false;
  ui.selectProviderSource('fal'); ui.selectProviderSource('vgenv');
  assert.equal(el('modelsVisible-vgenv').checked, false);
  await ui.saveProviderModelVisibility('vgenv');
  assert.deepEqual(request, { path: '/admin/provider-settings', method: 'POST', providerModelVisibility: { vgenv: false } });
  assert.match(el('modelsVisibleMsg-vgenv').textContent, /Models hidden/);
  assert.equal(el('modelsVisible-fal').checked, true);
  fail = true; el('modelsVisible-vgenv').checked = true; el('saveModelsVisible-vgenv').disabled = false;
  await ui.saveProviderModelVisibility('vgenv');
  assert.equal(el('saveModelsVisible-vgenv').disabled, false);
  assert.equal(el('modelsVisibleMsg-vgenv').textContent, 'Could not save');
  assert.equal(el('modelsVisible-vgenv').disabled, false);
});

test('a cached model selection cannot obtain a new quote after its provider is hidden', async () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const extract = name => {
    const start = source.indexOf('async function ' + name + '(');
    return source.slice(start, source.indexOf('\n}', start) + 2);
  };
  let visible = false, priced = 0, longPriced = 0;
  const settings = () => ({ providerModelVisibility: { vgenv: visible }, vgenv: { active: true } });
  const context = { visibleProviderAccess, getProviderSettings: async () => settings(),
    getAdminProviderSettings: async () => settings(), getUserProviderAccess: async () => ({ vgenv: true }),
    isRetiredModel: () => false, DIRECT_VIDEO_MODELS: ['minimax_h3'],
    directVideoSourceActive: (id, access, config) => access.vgenv && config.vgenv.active,
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    isLongH3Duration: require('../src/pricing.js').isLongH3Duration,
    VgenvClient: class {}, quoteLongH3Video: async () => { longPriced++; return {cost:600,isEstimate:false}; },
    getCost: () => { priced++; return 100; } };
  vm.createContext(context);
  vm.runInContext(extract('getVisibleUserProviderAccess') + '\n' + extract('quoteModelForUser'), context);
  await assert.rejects(context.quoteModelForUser(1, { model: 'minimax_h3', duration: 4 }), error => error.statusCode === 403);
  await assert.rejects(context.quoteModelForUser(1,{model:'minimax_h3',duration:30}),error=>error.statusCode===403);
  assert.equal(priced, 0);
  assert.equal(longPriced,0);
  visible = true;
  assert.equal((await context.quoteModelForUser(1, { model: 'minimax_h3', duration: 4 })).cost, 100);
  assert.equal((await context.quoteModelForUser(1,{model:'minimax_h3',duration:30})).cost,600);
  assert.equal(longPriced,1);
});

test('Puream dashboard saves encrypted credentials without returning them or reading environment API keys',async()=>{
  saved.clear();writes.length=0;
  const previous=process.env.SETTINGS_ENCRYPTION_KEY;
  const oldPuream=process.env.PUREAM_API_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY='synthetic-encryption-root';
  process.env.PUREAM_API_KEY='unused-env-key';
  try{
    assert.equal((await getProviderSettings()).pureamApiKey,'');
    await updateProviderSettings({pureamApiKey:'synthetic-admin-code',pureamEnabled:true,pureamMaxInflight:2});
    assert.match(saved.get('puream_api_key'),/^v1:/);assert.equal(secretFlags.get('puream_api_key'),1);
    assert.equal((await getProviderSettings()).pureamApiKey,'synthetic-admin-code');
    const admin=await getAdminProviderSettings();
    assert.equal(admin.puream.active,true);assert.equal(admin.puream.maxInflight,2);
    assert.equal(JSON.stringify(admin).includes('synthetic-admin-code'),false);
    const before=writes.length;
    await assert.rejects(updateProviderSettings({pureamEnabled:false,pureamApiKey:'bad code'}),e=>e.statusCode===400);
    assert.equal(writes.length,before);
    await updateProviderSettings({clearPureamApiKey:true});
    assert.equal((await getAdminProviderSettings()).puream.apiKeyConfigured,false);
  }finally{
    if(previous===undefined)delete process.env.SETTINGS_ENCRYPTION_KEY;else process.env.SETTINGS_ENCRYPTION_KEY=previous;
    if(oldPuream===undefined)delete process.env.PUREAM_API_KEY;else process.env.PUREAM_API_KEY=oldPuream;
    saved.clear();secretFlags.clear();
  }
});

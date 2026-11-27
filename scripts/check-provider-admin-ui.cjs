'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  await page.addInitScript(() => {
    if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => '12345678-1234-4abc-8abc-123456789abc' });
  });
  const artifacts = 'artifacts/provider-admin-ui'; fs.mkdirSync(artifacts, { recursive: true });
  const errors = [], requests = [], writes = [];
  let api888Imports=0, longAiImport=null, pureamChecks=0, pureamImports=0, pureamEnabled=false;
  let renderTest = null, paidRequests = 0;
  const renderProof = { expiresAt: Date.now() + 5 * 60 * 1000, signature: 'fixture-proof' };
  page.on('pageerror', error => errors.push(error.message));
  const names = Array.from({ length: 35 }, (_, i) => ({ key: 'video:example_' + i, id: 'example_' + i,
    studio: 'video', vendor: 'Example provider', defaultName: 'Example model ' + i, name: '', hdEnhance: true }));
  const catalog = prefix => Array.from({ length: 75 }, (_, i) => ({ id: i, providerModelId: prefix + '-test-' + i,
    label: prefix + ' Model ' + i, mediaType: 'video', aspectRatios: ['16:9', '9:16'], resolutions: ['720p'], durations: [4, 15],
    ready: true, enabled: true, available: true, adapterSupported: true,
    pricing: { video_duration_pricing: [{ resolution: '720p', cost_per_second: 0.02 }] } }));
  const vercel = catalog('Vercel'), argo = catalog('Argo');
  const api888=[
    {...argo[0],providerModelId:'seedance2.5-480p-plus',upstreamAvailable:false,upstreamStatus:'no_recent_success',api888:{billing:'second',sourceCny:0.5}},
    {...argo[1],providerModelId:'seedance2.5-301010-face',upstreamAvailable:true,upstreamStatus:'available',api888:{billing:'job',sourceCny:7.5}}
  ];
  await page.route('http://cmmtools.test/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    requests.push(pathname + url.search);
    const json = value => route.fulfill({ json: { ok: true, ...value } });
    if (pathname === '/admin-console') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync('public/admin.html', 'utf8') });
    if (pathname === '/admin/aivid/status') return json({ configured: false, apiKeyConfigured: false, endpoint: 'https://production-sfo.browserless.io', ttlDays: 1, login: { state: 'idle' } });
    if (pathname === '/admin/provider-settings') return json({ settings: { argolink: { enabled: true, apiKeyConfigured: true }, longai: { enabled: false, apiKeyConfigured: true }, allowProviderCharges: false } });
    if (pathname === '/admin/longai/check') { assert.equal(request.method(), 'GET'); return json({ providerStatus: 401, elapsedMs: 125 }); }
    if (pathname === '/admin/longai/import') { assert.equal(request.method(), 'POST'); longAiImport = request.postDataJSON(); return json({ models: [] }); }
    if (pathname === '/admin/longai/video-tests') return json({
      source: 'snapshot', snapshotDate: '2026-11-08', keyConfigured: true,
      models: [{ id: 'seedance-2.0-mini', sellers: 1 }, { id: 'kling-video-o-1', sellers: 2 }, { id: 'zero-video', sellers: 0 }],
    });
    if (pathname === '/admin/longai/video-tests/model') {
      assert.equal(request.method(), 'GET');
      const id = url.searchParams.get('model');
      return json(id === 'seedance-2.0-mini' ? { id, status: 'visible', elapsedMs: 25, renderProof } :
        { id, status: 'not_visible', elapsedMs: 25 });
    }
    if (pathname === '/admin/longai/video-tests/renders') {
      if (request.method() === 'GET') return json({ tests: renderTest ? [renderTest] : [], paidEnabled: true });
      assert.equal(request.method(), 'POST');
      paidRequests++;
      const { id, model, confirmPaid, renderProof: submittedProof } = request.postDataJSON();
      assert.match(id, /^[a-f0-9-]{36}$/i);
      assert.equal(model, 'seedance-2.0-mini');
      assert.equal(confirmPaid, true);
      assert.deepEqual(submittedProof, renderProof);
      renderTest = { id, model, status: 'verified', taskId: 'fixture_task', diagnostic: 'Completed and verified a full MP4.' };
      return json({ test: { id, model, status: 'queued' } });
    }
    if(pathname==='/admin/huiqu/check')return json({accessibleModels:1,supportedModels:1,total:2});
    if(pathname==='/admin/huiqu/sync')return json({total:2,enabled:1});
    if(pathname==='/admin/huiqu/performance')return json({models:{}});
    if(pathname==='/admin/provider-models'&&url.searchParams.get('provider')==='huiqu')return json({models:[
      {id:100,label:'Wan 3.0 · Huiqu',providerModelId:'wan-fixture',publicModelId:'huiqu_fixture',available:true,ready:true,enabled:true,resolutions:['720p'],durations:[2,30],huiqu:{price:{priceCny:0.35,unit:'second'}},referenceCapabilities:{image:{max:10},video:{max:5},audio:{max:5}}},
      {id:101,label:'Official token model',providerModelId:'token-fixture',available:true,ready:false,enabled:true,setupReason:'Token billing requires verification',resolutions:['720p'],durations:[4,15],huiqu:{},referenceCapabilities:{}}
    ]});
    if (pathname === '/admin/puream/check') { assert.equal(request.method(),'POST'); pureamChecks++; return json({accessibleModels:1,supportedModels:1}); }
    if (pathname === '/admin/puream/sync') { assert.equal(request.method(),'POST'); pureamImports++; return json({total:1,enabled:Number(pureamEnabled)}); }
    if (pathname === '/admin/puream/models') {
      assert.equal(request.method(),'POST'); pureamEnabled=request.postDataJSON().enabled; return json({total:1});
    }
    if (pathname === '/admin/provider-models' && url.searchParams.get('provider') === 'puream') return json({models:[{
      id:1,label:'Wan 3.0 · Puream TEST',providerModelId:'puream-wan3-fixture',publicModelId:'puream_wan3_fixture',
      available:true,ready:true,enabled:pureamEnabled,puream:{tiers:{'480p':{durations:[2,4],unit:'second',priceCny:0.2475}}},
      referenceCapabilities:{image:{max:9},video:{max:5},audio:{max:3}}
    }]});
    if (pathname === '/admin/puream/performance') return json({models:{'puream_wan3_fixture':{successRate:100,samples:2,averageLatencyMs:1000}}});
    if (pathname === '/admin/provider-models' && url.searchParams.get('provider') === 'longai') return json({ models: [] });
    if (pathname === '/admin/model-names') {
      if(request.method()==='POST'){
        const body=request.postDataJSON();
        for(const row of names)if(Object.hasOwn(body.names||{},row.key))row.name=body.names[row.key];
      }
      return json({models:names});
    }
    if (pathname === '/admin/api888/sync') { api888Imports++; assert.equal(request.method(),'POST'); return json({total:50,adapterSupported:14,dynamicSeedanceModels:5}); }
    if (pathname === '/admin/provider-models') return json({ models: url.searchParams.get('provider') === 'vercel' ? vercel : url.searchParams.get('provider') === 'api888' ? api888 : argo });
    if (pathname === '/admin/vercel/models/0/price') {
      const body = request.postDataJSON(); writes.push(body); vercel[0].priceOverride = body.price; return json({});
    }
    if (pathname.startsWith('/admin/')) return json({ stats: { users: 1, generations: 0, active: 0, completed: 0 },
      models: [], providers: [], entries: [], boots: [], config: {}, web: { slowRequests: [], startedAt: new Date().toISOString() } });
    const file = path.join('public', pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://cmmtools.test/admin-console');
  await page.locator('#tokenInput').fill('fixture-admin');
  await page.getByRole('button', { name: 'Open dashboard', exact: true }).click();
  await page.locator('#adminApp').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Provider', exact: true }).click();
  await page.locator('#aividKeyStatus').filter({ hasText: 'No Browserless key' }).waitFor();
  assert.equal(await page.locator('[data-provider-source]:visible').count(), 1);
  assert.equal(requests.some(url => url === '/admin/model-names' || url === '/admin/provider-models?provider=vercel'), false);
  // Regression: WXKSAI's directory entry must be selectable and never remain at "Checking…".
  const wxksaiNav = page.locator('[data-source-key="wxksai"]');
  await page.locator('#provider-nav-status-wxksai').filter({ hasText: 'Needs setup' }).waitFor();
  await wxksaiNav.click();
  assert.equal(await page.locator('[data-provider-source="wxksai"]').isVisible(), true);
  assert.equal(await page.locator('#aividAdminCard').isVisible(), false);
  assert.equal(await wxksaiNav.getAttribute('aria-pressed'), 'true');
  await page.locator('#wxksaiApiKey').fill('private-unsaved-wxksai-fixture');
  await page.locator('[data-source-key="aivid"]').click();
  await wxksaiNav.click();
  assert.equal(await page.locator('#wxksaiApiKey').inputValue(), 'private-unsaved-wxksai-fixture');
  await page.locator('[data-source-key="puream"]').click();
  await page.locator('#provider-nav-status-puream').filter({hasText:'Needs setup'}).waitFor();
  assert.equal(await page.locator('#pureamApiKey').getAttribute('type'),'password');
  await page.locator('#pureamApiKey').fill('synthetic-unsaved-puream-code');
  await page.locator('#pureamModelSummary').getByText('Wan 3.0 · Puream TEST',{exact:true}).waitFor();
  assert.match(await page.locator('#pureamModelSummary').innerText(),/¥0\.2475\/sec/);
  assert.match(await page.locator('#pureamModelSummary').innerText(),/5 videos/);
  await page.locator('[data-provider-source="puream"]').getByRole('button',{name:'Check connection',exact:true}).click();
  await page.locator('#pureamActionMsg').filter({hasText:'Connected'}).waitFor(); assert.equal(pureamChecks,1);
  await page.locator('[data-provider-source="puream"]').getByRole('button',{name:'Import account models',exact:true}).click();
  await page.locator('#pureamActionMsg').filter({hasText:'Imported 1'}).waitFor(); assert.equal(pureamImports,1);
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-provider-source="puream"]').getByRole('button',{name:'Enable all available',exact:true}).click();
  await page.locator('#pureamActionMsg').filter({hasText:'1 models enabled'}).waitFor(); assert.equal(pureamEnabled,true);
  await page.locator('[data-source-key="aivid"]').click();
  await page.locator('[data-source-key="puream"]').click();
  assert.equal(await page.locator('#pureamApiKey').inputValue(),'synthetic-unsaved-puream-code');
  await page.locator('[data-source-key="huiqu"]').click();
  await page.locator('#huiquModelSummary').getByText('Wan 3.0 · Huiqu',{exact:true}).waitFor();
  assert.match(await page.locator('#huiquModelSummary').innerText(),/¥0\.35\/sec/);
  assert.match(await page.locator('#huiquModelSummary').innerText(),/Token billing requires verification/);
  assert.equal(await page.locator('#huiquApiKey').getAttribute('type'),'password');
  await page.locator('#huiquApiKey').fill('synthetic-unsaved-huiqu');
  await page.locator('[data-provider-source="huiqu"]').getByRole('button',{name:'Import video catalog',exact:true}).click();
  await page.locator('#huiquActionMsg').filter({hasText:'Imported 2'}).waitFor();
  await page.locator('[data-source-key="aivid"]').click();
  await page.locator('[data-source-key="huiqu"]').click();
  assert.equal(await page.locator('#huiquApiKey').inputValue(),'synthetic-unsaved-huiqu');
  await page.locator('[data-source-key="aivid"]').click();
  await page.screenshot({ path: path.join(artifacts, 'connections-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: /^888API Video/ }).click();
  await page.getByRole('button',{name:'Import models & prices',exact:true}).click();
  await page.locator('#api888ActionMsg').filter({hasText:'5 Seedance 2.5 models with live per-second pricing'}).waitFor();
  assert.equal(api888Imports,1);
  await page.getByText('Inspect all imported 888API models',{exact:true}).click();
  await page.locator('#api888ModelAudit').getByText(/Imported · Hidden in Studio \(888API: no recent success\)/).waitFor();
  assert.match(await page.locator('#api888ModelSummary').innerText(),/1 video \/ 0 image ready to offer/);
  assert.equal(requests.some(url=>url.includes('/v1/videos')),false);
  await page.getByRole('button', { name: /^ArgoLink Video/ }).click();
  await page.locator('#argoApiKey').fill('private-unsaved-fixture');
  await page.getByRole('button', { name: /^SmartAIPI Image/ }).click();
  await page.getByRole('button', { name: /^ArgoLink Video/ }).click();
  assert.equal(await page.locator('#argoApiKey').inputValue(), 'private-unsaved-fixture');
  await page.locator('#providerSourceSearch').fill('voice');
  assert.equal(await page.locator('[data-source-key]:visible').count(), 1);
  await page.locator('#providerSourceSearch').fill('');
  assert.equal(await page.locator('[data-source-key]:visible').count(), 15);
  assert.equal(await page.locator('[data-source-key="enhancer"]').count(), 0);
  assert.equal(await page.locator('[data-provider-source="enhancer"]').count(), 0);
  assert.equal(await page.locator('#providerSourceSelect option[value="enhancer"]').count(), 0);
  await page.getByRole('button', { name: /^LONG AI Seedance/ }).click();
  assert.equal(await page.locator('#longaiEnabled').isChecked(), false);
  assert.equal(await page.locator('#longaiApiKey').inputValue(), '');
  await page.getByRole('button', { name: 'Check server connection', exact: true }).click();
  await page.locator('#longaiActionMsg').filter({ hasText: 'LONG AI reached · HTTP 401' }).waitFor();
  await page.locator('#longai480p').fill('0.01');
  await page.locator('#longai720p').fill('0.02');
  await page.getByRole('button', { name: 'Import Seedance 2.0 Mini', exact: true }).click();
  await page.locator('#longaiActionMsg').filter({ hasText: 'Seedance 2.0 Mini imported' }).waitFor();
  assert.deepEqual(longAiImport, { rates: { '480p': '0.01', '720p': '0.02' } });

  await page.getByRole('button', { name: 'Open video tests', exact: true }).click();
  await page.locator('#longAiVideoProgress').filter({ hasText: '2 of 3 video models have a listed seller' }).waitFor();
  assert.equal(await page.locator('#longAiVideoRows tr').count(), 3);
  assert.equal(await page.locator('#longAiVideoRows').getByText('None listed', { exact: true }).count(), 1);
  const paidButton = page.getByRole('button', { name: 'Paid render test for seedance-2.0-mini', exact: true });
  assert.equal(await paidButton.isDisabled(), true);
  await page.getByRole('button', { name: 'Check all models with sellers', exact: true }).click();
  await page.locator('#longAiVideoProgress').filter({ hasText: '2 of 2 checked · 1 visible to the saved key' }).waitFor();
  assert.equal(await paidButton.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Paid render test for kling-video-o-1', exact: true }).isDisabled(), true);
  assert.deepEqual(requests.filter(url => url.startsWith('/admin/longai/video-tests/model?')).sort(), [
    '/admin/longai/video-tests/model?model=kling-video-o-1',
    '/admin/longai/video-tests/model?model=seedance-2.0-mini',
  ]);
  await page.getByRole('button', { name: 'Check key for zero-video', exact: true }).click();
  await page.locator('#longAiVideoProgress').filter({ hasText: '1 of 1 checked · 0 visible to the saved key' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Paid render test for zero-video', exact: true }).isDisabled(), true);
  page.once('dialog', dialog => dialog.dismiss());
  await paidButton.click();
  assert.equal(paidRequests, 0);
  page.once('dialog', dialog => dialog.accept());
  await paidButton.click();
  await page.locator('#longAiVideoRows').getByText(/Render verified.*fixture_task/).waitFor();
  assert.equal(paidRequests, 1);
  await page.getByRole('button', { name: 'Provider', exact: true }).click();

  await page.getByRole('button', { name: 'Video Model Names', exact: true }).click();
  await page.locator('#provider-pager-names').filter({ hasText: 'of 35 models' }).waitFor();
  assert.equal(await page.locator('#modelNameStudio').inputValue(),'video');
  await page.locator('[data-key="video:example_0"]').fill('My saved model name');
  await page.getByRole('button',{name:'Save names',exact:true}).click();
  await page.locator('#modelNameMsg').filter({hasText:'Saved.'}).waitFor();
  assert.equal(names[0].name,'My saved model name');
  await page.locator('[data-key="video:example_0"]').locator('..').getByRole('button',{name:'Reset name',exact:true}).click();
  await page.getByRole('button',{name:'Save names',exact:true}).click();
  await page.locator('#modelNameMsg').filter({hasText:'Saved.'}).waitFor();
  assert.equal(names[0].name,'');
  assert.equal(await page.locator('#modelNameRows tr').count(), 10);
  await page.locator('[data-key="video:example_0"]').fill('My unsaved model name');
  await page.locator('#provider-pager-names').getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('#provider-pager-names').getByRole('button', { name: 'Previous', exact: true }).click();
  assert.equal(await page.locator('[data-key="video:example_0"]').inputValue(), 'My unsaved model name');
  await page.getByRole('tab', { name: 'Vercel catalog', exact: true }).click();
  await page.locator('#vercelPrice0').waitFor();
  assert.equal(await page.locator('#vercelModelRows tr').count(), 10);
  await page.locator('#vercelPrice0').fill('0.025');
  await page.locator('#provider-pager-vercel').getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('#provider-pager-vercel').getByRole('button', { name: 'Previous', exact: true }).click();
  assert.equal(await page.locator('#vercelPrice0').inputValue(), '0.025');
  await page.locator('#vercelPrice0').locator('..').getByRole('button', { name: 'Save price', exact: true }).click();
  await page.locator('#vercelCatalogMsg').filter({ hasText: 'saved' }).waitFor();
  assert.deepEqual(writes, [{ price: { perSecond: 0.025 } }]);
  await page.locator('#vercelModelSearch').fill('Vercel Model 74');
  assert.equal(await page.locator('#vercelModelRows tr').count(), 1);
  assert.match(await page.locator('#provider-pager-vercel').innerText(), /1–1 of 1/);
  await page.locator('#vercelModelSearch').fill('');
  await page.screenshot({ path: path.join(artifacts, 'models-desktop.png'), fullPage: true });
  const tableHeight = await page.locator('#vercelModelRows').locator('xpath=ancestor::div[contains(@class,"tablewrap")]').evaluate(node => node.getBoundingClientRect().height);
  assert.ok(tableHeight <= 622);
  await page.getByRole('tab', { name: 'ArgoLink catalog', exact: true }).click();
  await page.locator('#argoModelSearch').fill('Argo Model 74');
  await page.locator('#argoModelRows').getByText('Argo Model 74', { exact: true }).waitFor();
  assert.equal(await page.locator('#argoModelRows tr').count(), 1);
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  assert.equal(await page.locator('.provider-diagnostics[open]').count(), 0);
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  assert.equal(await page.locator('#argoApiKey').inputValue(), 'private-unsaved-fixture');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('#providerSourceSelect').selectOption('wxksai');
  assert.equal(await page.locator('[data-provider-source="wxksai"]').isVisible(), true);
  assert.equal(await page.locator('#wxksaiApiKey').inputValue(), 'private-unsaved-wxksai-fixture');
  await page.locator('#providerSourceSelect').selectOption('puream');
  assert.equal(await page.locator('[data-provider-source="puream"]').isVisible(),true);
  assert.equal(await page.locator('#pureamApiKey').inputValue(),'synthetic-unsaved-puream-code');
  await page.locator('#providerSourceSelect').selectOption('aivid');
  assert.equal(await page.locator('[data-provider-source]:visible').count(), 1);
  assert.equal(await page.locator('#aividAdminCard').isVisible(), true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  await page.screenshot({ path: path.join(artifacts, 'connections-mobile.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  assert.equal(await page.locator('[data-key="video:example_0"]').count(), 1); // DOM edits survived navigation.
  await page.getByRole('tab', { name: 'Vercel catalog', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('Provider desktop/mobile navigation, search, pagination, edit retention and price save passed.');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });

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
  let api888Imports=0, longAiImport=null;
  let renderTest = null, paidRequests = 0;
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
      source: 'marketplace', fetchedAt: '2026-11-08T08:00:00Z', keyConfigured: true,
      models: [{ id: 'seedance-2.0-mini', sellers: 1 }, { id: 'kling-video-o-1', sellers: 2 }, { id: 'zero-video', sellers: 0 }],
    });
    if (pathname === '/admin/longai/video-tests/model') {
      assert.equal(request.method(), 'GET');
      const id = url.searchParams.get('model');
      return json({ id, status: id === 'seedance-2.0-mini' ? 'visible' : 'not_visible', elapsedMs: 25 });
    }
    if (pathname === '/admin/longai/video-tests/renders') {
      if (request.method() === 'GET') return json({ tests: renderTest ? [renderTest] : [], paidEnabled: true });
      assert.equal(request.method(), 'POST');
      paidRequests++;
      const { id, model, confirmPaid } = request.postDataJSON();
      assert.match(id, /^[a-f0-9-]{36}$/i);
      assert.equal(model, 'seedance-2.0-mini');
      assert.equal(confirmPaid, true);
      renderTest = { id, model, status: 'verified', taskId: 'fixture_task', diagnostic: 'Completed and verified a full MP4.' };
      return json({ test: { id, model, status: 'queued' } });
    }
    if (pathname === '/admin/provider-models' && url.searchParams.get('provider') === 'longai') return json({ models: [] });
    if (pathname === '/admin/model-names') return json({ models: names });
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
  assert.equal(await page.locator('[data-source-key]:visible').count(), 13);
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
  await page.getByRole('button', { name: 'Check all models with sellers', exact: true }).click();
  await page.locator('#longAiVideoProgress').filter({ hasText: '2 of 2 checked · 1 visible to the saved key' }).waitFor();
  assert.deepEqual(requests.filter(url => url.startsWith('/admin/longai/video-tests/model?')).sort(), [
    '/admin/longai/video-tests/model?model=kling-video-o-1',
    '/admin/longai/video-tests/model?model=seedance-2.0-mini',
  ]);
  await page.getByRole('button', { name: 'Check key for zero-video', exact: true }).click();
  await page.locator('#longAiVideoProgress').filter({ hasText: '1 of 1 checked · 0 visible to the saved key' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Paid render test for zero-video', exact: true }).isDisabled(), true);
  const paidButton = page.getByRole('button', { name: 'Paid render test for seedance-2.0-mini', exact: true });
  page.once('dialog', dialog => dialog.dismiss());
  await paidButton.click();
  assert.equal(paidRequests, 0);
  page.once('dialog', dialog => dialog.accept());
  await paidButton.click();
  await page.locator('#longAiVideoRows').getByText(/Render verified.*fixture_task/).waitFor();
  assert.equal(paidRequests, 1);
  await page.getByRole('button', { name: 'Provider', exact: true }).click();

  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  await page.locator('#provider-pager-names').filter({ hasText: 'of 35 models' }).waitFor();
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

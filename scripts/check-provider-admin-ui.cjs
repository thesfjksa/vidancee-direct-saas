'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const artifacts = 'artifacts/provider-admin-ui'; fs.mkdirSync(artifacts, { recursive: true });
  const errors = [], requests = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  const names = Array.from({ length: 35 }, (_, i) => ({ key: 'video:example_' + i, id: 'example_' + i,
    studio: 'video', vendor: 'Example provider', defaultName: 'Example model ' + i, name: '', hdEnhance: true }));
  const catalog = prefix => Array.from({ length: 75 }, (_, i) => ({ id: i, providerModelId: prefix + '-test-' + i,
    label: prefix + ' Model ' + i, mediaType: 'video', aspectRatios: ['16:9', '9:16'], resolutions: ['720p'], durations: [4, 15],
    ready: true, enabled: true, available: true, adapterSupported: true,
    pricing: { video_duration_pricing: [{ resolution: '720p', cost_per_second: 0.02 }] } }));
  const vercel = catalog('Vercel'), argo = catalog('Argo');
  await page.route('http://cmmtools.test/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    requests.push(pathname + url.search);
    const json = value => route.fulfill({ json: { ok: true, ...value } });
    if (pathname === '/admin-console') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync('public/admin.html', 'utf8') });
    if (pathname === '/admin/aivid/status') return json({ configured: false, apiKeyConfigured: false, endpoint: 'https://production-sfo.browserless.io', ttlDays: 1, login: { state: 'idle' } });
    if (pathname === '/admin/provider-settings') return json({ settings: { argolink: { enabled: true, apiKeyConfigured: true }, allowProviderCharges: false } });
    if (pathname === '/admin/model-names') return json({ models: names });
    if (pathname === '/admin/provider-models') return json({ models: url.searchParams.get('provider') === 'vercel' ? vercel : argo });
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

  await page.getByRole('button', { name: /^ArgoLink Video/ }).click();
  await page.locator('#argoApiKey').fill('private-unsaved-fixture');
  await page.getByRole('button', { name: /^SmartAIPI Image/ }).click();
  await page.getByRole('button', { name: /^ArgoLink Video/ }).click();
  assert.equal(await page.locator('#argoApiKey').inputValue(), 'private-unsaved-fixture');
  await page.locator('#providerSourceSearch').fill('voice');
  assert.equal(await page.locator('[data-source-key]:visible').count(), 1);
  await page.locator('#providerSourceSearch').fill('');
  assert.equal(await page.locator('[data-source-key]:visible').count(), 12);

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

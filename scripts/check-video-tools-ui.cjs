'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { extname, join } = require('node:path');
const { chromium } = require('playwright-core');

const origin = 'https://cmmtools.test';
const artifacts = 'artifacts/video-tools';
const user = { id: 1, email: 'preview@example.test', credits: 1000, status: 'active' };
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1010 } });
    const errors = [];
    const quotes = [];
    let submitted;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const path = url.pathname;
      if (path === '/api/video-tools/quote') {
        const quote = route.request().postDataJSON();
        quotes.push(quote);
        return route.fulfill({ json: { cost: quote.duration * 8 + (quote.tool === 'motion-control' ? 3 : 0) } });
      }
      if (path === '/api/video-tools') {
        submitted = route.request().postData();
        return route.fulfill({ status: 201, json: { ok: true, user: { ...user, credits: 941 } } });
      }
      if (path === '/api/uploads/presign') return route.fulfill({ status: 409, json: { error: 'Fixture uses multipart uploads' } });
      if (path.startsWith('/api/')) {
        return route.fulfill({ json: { ok: true, user, pricing: [], imagePricing: [], signupsEnabled: true,
          generations: [], items: [], transactions: [], clones: [], stats: {}, plans: [] } });
      }
      const file = join('public', path === '/app' ? 'index.html' : path.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: mime[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
    });

    await page.goto(origin + '/app#video-tools');
    await page.locator('#videoToolPrice').getByText('40 credits', { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    mkdirSync(artifacts, { recursive: true });
    await page.locator('#video-tools').screenshot({ path: join(artifacts, 'desktop.png') });

    const character = page.getByRole('radio', { name: /Character Swap/ });
    await character.focus();
    await character.press('ArrowRight');
    assert(await page.getByRole('radio', { name: /Motion Control/ }).isChecked());
    assert.equal(await page.locator('#videoToolClipLabel').textContent(), 'Motion video');
    await page.locator('#videoToolDuration').selectOption('7');
    await page.locator('#videoToolPrice').getByText('59 credits', { exact: true }).waitFor();
    assert.deepEqual(quotes.at(-1), { tool: 'motion-control', duration: 7 });
    await page.locator('#videoToolImage').setInputFiles({ name: 'new-character.png', mimeType: 'image/png', buffer: Buffer.from([1, 2]) });
    await page.locator('#videoToolClip').setInputFiles({ name: 'source.mp4', mimeType: 'video/mp4', buffer: Buffer.from([1, 2, 3]) });
    assert.equal(await page.locator('#videoToolImageFile').textContent(), 'new-character.png');
    assert.equal(await page.locator('.vt-upload.has-file').count(), 2);
    await page.locator('#videoToolPermission').check();
    await page.getByRole('button', { name: 'Generate motion' }).click();
    await page.locator('#videoToolStatus').getByText('Motion Control queued.', { exact: true }).waitFor();
    assert.match(submitted, /name="tool"\r\n\r\nmotion-control/);
    assert.match(submitted, /name="priceLimit"\r\n\r\n59/);
    assert.equal(await page.locator('.vt-upload.has-file').count(), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('Object Swap', { exact: true }).click();
    assert(await page.getByRole('radio', { name: /Object Swap/ }).isChecked());
    assert.equal(await page.locator('#videoToolPrompt').getAttribute('required'), '');
    assert(!(await page.locator('#videoToolStartField').isVisible()));
    await page.locator('#videoToolPrice').getByText('56 credits', { exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow on mobile');
    await page.locator('#video-tools').screenshot({ path: join(artifacts, 'mobile.png') });

    assert.deepEqual(errors, []);
    console.log('Video Tools desktop and mobile checks passed.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

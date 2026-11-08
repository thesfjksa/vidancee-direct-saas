'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { html } = require('./aivid-rdp/fixtures/form.cjs');

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const fixture = html.replace('</main>',
      '<input type="file" accept="video/mp4,video/quicktime" onchange="preview(this,&quot;video&quot;)">' +
      '<input type="file" accept="audio/mpeg,audio/wav" onchange="preview(this,&quot;audio&quot;)"></main>');
    await page.route('https://aivid.dev/', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('https://aivid.dev/');
    const install = () => page.addScriptTag({ path: path.join(__dirname, 'aivid-handoff-extension', 'fill.js') });
    const run = (action, payload) => page.evaluate(([name, data]) => globalThis.cmmAividFill(name, data), [action, payload]);
    const settings = { model: 'aivid_seedance_2_0_fast', prompt: 'A quiet river\n\nUse @image1 and @video1.', duration: 10,
      resolution: '480p', aspectRatio: '16:9', sourceCredits: 2 };
    await install();
    assert.equal((await run('start', settings)).ok, true);
    for (const [kind, mimeType] of [['image', 'image/png'], ['video', 'video/mp4'], ['audio', 'audio/mpeg']]) {
      assert.equal((await run('file', { kind, mimeType })).ok, true);
      assert.equal((await run('chunk', 'AQID')).ok, true);
      assert.equal((await run('attach')).ok, true);
    }
    const result = await run('finish');
    assert.equal(result.ok, true, result.error);
    assert.match(result.value, /Form filled\. Review/);
    assert.equal(await page.locator('#model').innerText(), 'Seedance 2.0 (Fast)');
    assert.equal(await page.locator('#seconds').innerText(), '10s');
    assert.equal(await page.locator('#resolution').innerText(), '480p');
    assert.equal(await page.locator('main textarea').inputValue(), settings.prompt);
    assert.equal(await page.locator('#privateToggle').isChecked(), false);
    assert.equal(await page.locator('#bypass').isChecked(), true);
    const files = await page.evaluate(async () => Object.fromEntries(await Promise.all(
      Object.entries(window.selectedFiles).map(async ([kind, [file]]) => [kind, Array.from(new Uint8Array(await file.arrayBuffer()))])
    )));
    assert.deepEqual(files, { image: [1, 2, 3], video: [1, 2, 3], audio: [1, 2, 3] });
    assert.match((await run('start', settings)).error, /fresh AIVID form/);
    assert.equal(await page.evaluate(() => window.generateClicks), 0);

    await page.reload();
    await install();
    assert.equal((await run('start', { ...settings, sourceCredits: 1 })).ok, true);
    assert.match((await run('finish')).value, /Resolve the price before clicking Generate/);
    assert.equal(await page.evaluate(() => window.generateClicks), 0);
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

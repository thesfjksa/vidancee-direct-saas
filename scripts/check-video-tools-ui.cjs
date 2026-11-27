'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { extname, join } = require('node:path');
const { chromium } = require('playwright-core');

const origin = 'https://cmmtools.test';
const artifacts = 'artifacts/video-tools';
const user = { id: 1, email: 'preview@example.test', credits: 1000, status: 'active' };
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };
const durationRows=[{seconds:2,label:'2 sec',cost:50},{seconds:4,label:'4 sec',cost:100}];
const videoModel=(id,label,puream=false)=>({
  id,label,dynamicCost:puream,billingMode:puream?'per_second':undefined,billingRateCredits:puream?25:undefined,
  resolutions:[{id:'480p',label:'480p',durations:durationRows}],durations:durationRows,defaultResolution:'480p',
  defaultDuration:2,aspectRatios:['16:9','9:16'],defaultAspectRatio:'16:9',modes:['reference'],defaultMode:'reference',
  capabilities:{image:{supported:true,max:3,roles:['image_references']},video:{supported:puream,max:puream?5:0,roles:['video_references'],formats:['mp4']},audio:{supported:false,max:0}}
});
const modelFixtures=[
  videoModel('minimax_h3','MiniMax H3'),
  videoModel('new_sd25_abcdef123456','Seedance 2.5 · Fixture',true),
  videoModel('dope_seedance_2_0_mini_720p','Dope Seedance'),
  videoModel('new_wan3_abcdef654321','Wan 3.0 · Fixture',true),
  videoModel('new_sd20_123456abcdef','Renamed fixture model',true),
  videoModel('huiqu_123456789012345678901234','Huiqu fixture',true)
];


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
      if (path === '/api/config') return route.fulfill({json:{ok:true,user,pricing:modelFixtures,imagePricing:[],signupsEnabled:true}});
      if (path === '/api/model-cost') return route.fulfill({json:{cost:50}});
      if (path === '/api/new-performance') return route.fulfill({json:{models:{
        new_sd25_abcdef123456:{successRate:25,averageLatencyMs:2000},
        new_wan3_abcdef654321:{successRate:100,averageLatencyMs:1000}
      }}});
      if (path === '/api/dope-performance') return route.fulfill({json:{models:{}}});
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

    // The retired New models must not appear even in a stale fixture catalog.
    await page.setViewportSize({width:1440,height:1010});
    await page.locator('[data-section="create"]').click();
    const trigger=page.locator('#model').locator('..').locator('.custom-select-trigger');
    await trigger.click();
    const picker=page.locator('#modelPicker');
    const huiquGroup=picker.locator('.model-picker-new-group[data-group-label="Newly Listed"]');
    assert.equal(await picker.locator('.model-picker-new-group').count(),1);
    assert.equal(await huiquGroup.locator('.model-picker-group-count').innerText(),'1 model');
    assert.equal(await picker.locator('.model-picker-options > .custom-select-option').count(),2);
    const search=picker.locator('input[type=search]');
    await search.fill('Wan 3.0');
    assert.equal(await picker.locator('.custom-select-empty').isVisible(),true);
    await search.fill('Newly Listed');
    assert.equal(await huiquGroup.locator('.custom-select-option:visible').count(),1);
    await huiquGroup.getByRole('option',{name:/Huiqu fixture/}).click();
    assert.equal(await page.locator('#model').inputValue(),'huiqu_123456789012345678901234');
    assert.equal(await page.locator('#addVideoReferenceButton').isVisible(),true);
    await page.setViewportSize({width:390,height:844});
    await trigger.click();
    assert.equal(await huiquGroup.evaluate(el=>el.open),true);
    assert(await page.evaluate(()=>document.querySelector('#modelPicker .model-picker-options').scrollWidth<=document.querySelector('#modelPicker .model-picker-options').clientWidth),'Model submenu fits on mobile');
    await picker.screenshot({path:join(artifacts,'newly-listed-menu-mobile.png')});

    assert.deepEqual(errors, []);
    console.log('Video Tools desktop and mobile checks passed.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

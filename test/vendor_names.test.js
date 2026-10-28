const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { hideVendors, hideVendorsInBody } = require('../src/vendor_names.js');

test('customers never see vendor names; prompts are left alone', () => {
  assert.equal(hideVendors('AI Gateway rejected the API credentials or model access.'), 'The generation service rejected the API credentials or model access.');
  assert.equal(hideVendors('CreatePulse HTTP 502'), 'The generation service HTTP 502');
  assert.equal(hideVendors('The upload to ArgoLink storage could not be completed.'), 'The upload to storage could not be completed.');
  const body = hideVendorsInBody({ ok: false, error: 'vgenv reported failed', generation: { prompt: 'a Vercel poster', error_message: 'fal.ai upscale failed' } });
  assert.deepEqual(body, { ok: false, error: 'The generation service reported failed', generation: { prompt: 'a Vercel poster', error_message: 'The generation service upscale failed' } });
  // Customer pages, the plans and Claude's texts name no vendor.
  const vendor = /argolink|vidancee|createpulse|vgenv|smartaipi|vercel|ai gateway|fal\.ai|\bfal\b|vibi|bytedance/i;
  for (const file of ['public/index.html', 'public/landing.html', 'src/plans.js', 'src/mcp_server.js', 'src/mcp_view.js', 'src/mcp_pages.js']) {
    assert.equal(vendor.test(fs.readFileSync(file, 'utf8').replace(/require\([^)]*\)/g, '')), false, file);
  }
});

test('customers never see the 888API source name', () => {
  assert.equal(hideVendors('888API could not complete the video. Credits were refunded.'), 'The generation service could not complete the video. Credits were refunded.');
  assert.equal(hideVendors('Video finished at 888API, but the provider supplied unsafe download links.'), 'Video finished at the generation service, but the provider supplied unsafe download links.');
  // Raw source errors are never shown, whatever their language.
  assert.equal(hideVendors('888API request failed (HTTP 500): upstream error'), 'Model under maintenance. Please choose another model.');
  assert.equal(hideVendors('Request failed (HTTP 400) 请改用其他模型 (request id 202610280708092022055mn6LiQ). Credits were refunded.'),
    'Model under maintenance. Please choose another model. Credits were refunded.');
  assert.equal(hideVendors('This 888API model accepts at most 4 image references.'), 'This model accepts at most 4 image references.');
  assert.equal(hideVendors('Could not reach 888api.xin'), 'Could not reach the generation service');
  assert.equal(hideVendors('Model api888_seedance-2.5-g5-v2 is busy'), 'Model seedance-2.5-g5-v2 is busy');
  assert.equal(hideVendors('Set API888_API_KEY first'), 'Set service setting first');
  for (const text of ['888 API down', 'API 888 down', '888api down']) assert.doesNotMatch(hideVendors(text), /888/);
  const { hideApi888Name } = require('../src/vendor_names.js');
  assert.equal(hideApi888Name('Seedance 2.5 (888API)'), 'Seedance 2.5');
  assert.equal(hideApi888Name('888API · Wan 3.0'), 'Wan 3.0');
  assert.equal(hideApi888Name('Gemini 3 Pro Image'), 'Gemini 3 Pro Image');
  // No customer page, plan text or Claude text carries the name.
  for (const file of ['public/index.html', 'public/landing.html', 'src/plans.js', 'src/mcp_server.js', 'src/mcp_view.js', 'src/mcp_pages.js']) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8').replace(/require\([^)]*\)/g, ''), /888\s*api|api\s*888(?!_)/i, file);
  }
});

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

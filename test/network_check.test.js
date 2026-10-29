'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNetworkCheck } = require('../src/network_check.js');

test('network check reports status codes, timings and error codes per service, never bodies', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push([url, options.headers?.authorization]);
    if (url === 'https://api.ipify.org') return new Response('203.0.113.7');
    if (url.includes('/content')) return new Response('secret video bytes', { status: 502 });
    if (url.startsWith('https://888api.xin')) throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    return new Response('body', { status: 200 });
  };
  const report = await runNetworkCheck({ rounds: 2, api888Key: 'sk-private', task: 'task_abc123',
    fetchImpl, lookup: async () => [{ address: '198.51.100.1' }] });
  assert.equal(report.publicIp, '203.0.113.7');
  assert.deepEqual(report.results['888api'].errors, { UND_ERR_CONNECT_TIMEOUT: 2 });
  assert.equal(report.results['888api'].failed, 2);
  assert.deepEqual(report.results['888api-content'].errors, { 'HTTP 502': 2 });
  assert.equal(report.results.google.ok, 2);
  assert.deepEqual(report.results.google.dns.addresses, ['198.51.100.1']);
  // The key is only sent to the 888API content endpoint and never returned.
  assert.ok(seen.every(([url, auth]) => !auth || url.startsWith('https://888api.xin/v1/videos/')));
  assert.equal(JSON.stringify(report).includes('sk-private'), false);
  assert.equal(JSON.stringify(report).includes('secret video'), false);
});

test('network check skips the content probe for an unsafe task id', async () => {
  const report = await runNetworkCheck({ rounds: 1, api888Key: 'sk-private', task: '../x',
    fetchImpl: async () => new Response('', { status: 200 }), lookup: async () => [] });
  assert.equal(report.results['888api-content'], undefined);
});

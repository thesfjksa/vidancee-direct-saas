'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {storeUrl, handleExtensionDistribution} = require('../src/extension_distribution.js');
function request(routePath, method = 'GET', env = {}) {
  const res = {writeHead(status, headers) {this.status = status; this.headers = headers;}, end(body) {this.body = body;}};
  res.handled = handleExtensionDistribution({method}, res, routePath, env);
  return res;
}
test('install flow uses only a validated Chrome Web Store ID', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(storeUrl({CHROME_WEB_STORE_EXTENSION_ID: id}), 'https://chromewebstore.google.com/detail/' + id);
  for (const value of ['', 'unknown', 'https://evil.example', 'a'.repeat(31), 'q'.repeat(32), '<script>alert(1)</script>']) {
    assert.equal(storeUrl({CHROME_WEB_STORE_EXTENSION_ID: value}), '');
    const page = request('/extension', 'GET', {CHROME_WEB_STORE_EXTENSION_ID: value}).body.toString();
    assert.match(page, /not available yet/);
    assert.doesNotMatch(page, /class="button"/);
  }
  const page = request('/extension', 'GET', {CHROME_WEB_STORE_EXTENSION_ID: id}).body.toString();
  assert.match(page, new RegExp('href="https://chromewebstore.google.com/detail/' + id + '"'));
  assert.match(page, /confirm <strong>Add extension/);
  assert.doesNotMatch(page, /not available yet/);
  assert.match(page, /different extension ID/);
});
test('GET and HEAD agree and unsupported methods do not serve content', () => {
  for (const route of ['/extension', '/extension/privacy']) {
    const get = request(route), head = request(route, 'HEAD');
    assert.equal(get.status, 200);
    assert.deepEqual(get.headers, head.headers);
    assert.equal(get.body.length, get.headers['content-length']);
    assert.equal(head.body, undefined);
    assert.match(get.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(get.headers['cache-control'], 'no-store');
    const post = request(route, 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.equal(post.body, undefined);
  }
  assert.equal(request('/api/models').handled, false);
});
test('privacy explains site reads and Chrome sync and optional proxy credential handling', () => {
  const body = request('/extension/privacy').body.toString();
  assert.match(body, /page text, navigation labels, links and layout/);
  assert.match(body, /storage.sync/);
  assert.match(body, /may sync through your browser account/);
  assert.match(body, /not a device-wide VPN/);
  assert.match(body, /restricted to trusted extension contexts/);
  assert.match(body, /proxy operator receives proxy credentials/);
});

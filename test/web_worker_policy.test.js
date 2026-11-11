'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { webWorkerEnabled } = require('../src/web_worker_policy.js');

test('the customer web app does not start an embedded worker by default', () => {
  assert.equal(webWorkerEnabled({}), false);
  assert.equal(webWorkerEnabled({ WORKER_ENABLED: '' }), false);
  assert.equal(webWorkerEnabled({ WORKER_ENABLED: 'false' }), false);
  assert.equal(webWorkerEnabled({ WORKER_ENABLED: '0' }), false);
  assert.equal(webWorkerEnabled({ WORKER_ENABLED: 'no' }), false);
});

test('embedded worker mode requires an explicit affirmative setting', () => {
  for (const value of ['true', '1', 'yes', 'on', 'TRUE', ' On ']) {
    assert.equal(webWorkerEnabled({ WORKER_ENABLED: value }), true, value);
  }
  for (const value of ['disabled', 'maybe', 'false-and-true', '2']) {
    assert.equal(webWorkerEnabled({ WORKER_ENABLED: value }), false, value);
  }
});

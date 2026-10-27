'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { failureMessage } = require('../src/provider_errors.js');

test('Chinese provider reasons become plain English, unknown ones are dropped', () => {
  assert.equal(failureMessage('video', '输入图片触发安全策略，请更换图片后重试'),
    'The safety filter blocked this video. Please change your prompt or images and try again. Credits were refunded.');
  assert.equal(failureMessage('image', '内容违规'),
    'The safety filter blocked this image. Please change your prompt or images and try again. Credits were refunded.');
  assert.equal(failureMessage('video', '请求过于频繁'), 'The service is busy right now. Please try again in a few minutes. Credits were refunded.');
  assert.equal(failureMessage('video', '某些错误'), 'The video could not be completed. Credits were refunded.');
  assert.equal(failureMessage('video', ''), 'The video could not be completed. Credits were refunded.');
  assert.equal(failureMessage('video', 'Prompt too long.'), 'The video could not be completed: Prompt too long. Credits were refunded.');
  assert.doesNotMatch(failureMessage('video', '输入图片触发安全策略'), /888|[㐀-鿿]/);
});

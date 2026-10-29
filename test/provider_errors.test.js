'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { failureMessage, modelUnavailable, customerError } = require('../src/provider_errors.js');

test('Chinese provider reasons become plain English, unknown ones read "Model under maintenance"', () => {
  assert.equal(failureMessage('video', '输入图片触发安全策略，请更换图片后重试'),
    'The safety filter blocked this video. Please change your prompt or images and try again. Credits were refunded.');
  assert.equal(failureMessage('image', '内容违规'),
    'The safety filter blocked this image. Please change your prompt or images and try again. Credits were refunded.');
  assert.equal(failureMessage('video', '请求过于频繁'), 'The service is busy right now. Please try again in a few minutes. Credits were refunded.');
  assert.equal(failureMessage('video', '某些错误'), 'Model under maintenance. Please choose another model. Credits were refunded.');
  assert.equal(failureMessage('video', ''), 'The video could not be completed. Credits were refunded.');
  assert.equal(failureMessage('video', 'Prompt too long.'), 'Model under maintenance. Please choose another model. Credits were refunded.');
  assert.equal(failureMessage('video', '请改用其他模型'), 'Model under maintenance. Please choose another model. Credits were refunded.');
  assert.doesNotMatch(failureMessage('video', '输入图片触发安全策略'), /888|[㐀-鿿]/);
  assert.equal(failureMessage('video', '输入图片被识别为可能包含真人，请更换参考图片。'),
    'This model does not accept reference images that show a real person. Please use a different image. Credits were refunded.');
  assert.equal(failureMessage('video', '网络波动异常，请重新提交'), 'The video failed because of a temporary error. Please try again. Credits were refunded.');
  assert.equal(failureMessage('video', '系统异常，请重新提交'), 'The video failed because of a temporary error. Please try again. Credits were refunded.');
  assert.equal(failureMessage('video', '2.5需要临时修复，排查一下卡顿问题'), 'Model under maintenance. Please choose another model. Credits were refunded.');
});

test('"please use another model" answers mark the model as down', () => {
  assert.equal(modelUnavailable('请改用其他模型'), true);
  assert.equal(modelUnavailable('当前分组无可用渠道'), true);
  assert.equal(modelUnavailable('model not found'), true);
  assert.equal(modelUnavailable('888API request failed (HTTP 400): 该渠道不支持模型: SD2.5-30-10-10'), true);
  assert.equal(modelUnavailable('2.5需要临时修复，排查一下卡顿问题'), true);
  assert.equal(modelUnavailable('网络波动异常，请重新提交'), false);
  assert.equal(modelUnavailable('输入图片触发安全策略'), false);
  assert.equal(modelUnavailable(''), false);
});

test('stored raw source errors are replaced before customers see them', () => {
  assert.equal(customerError('Request failed (HTTP 400) 请改用其他模型 (request id 2026102807)'),
    'Model under maintenance. Please choose another model.');
  assert.equal(customerError('Video generation timed out. Credits were refunded.'), 'Video generation timed out. Credits were refunded.');
});

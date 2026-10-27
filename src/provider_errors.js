'use strict';

// Some sources answer failures in Chinese (888API: "输入图片触发安全策略，请更换图片后重试").
// Customers get a plain English sentence instead; the activity log keeps the
// original text for the admin.
const HAN = /[㐀-鿿]/;
const KNOWN = [
  // Safety / moderation. 888API says "input image" even for text-to-video
  // jobs without images, so the advice names both.
  [/安全策略|安全审核|内容安全|审核|敏感|违规|不合规|色情|涉黄|涉政|暴力/, 'The safety filter blocked this video. Please change your prompt or images and try again'],
  [/频繁|限流|繁忙|并发|排队/, 'The service is busy right now. Please try again in a few minutes'],
  [/超时/, 'The video took too long to generate. Please try again'],
  [/余额|额度|欠费/, 'The service is temporarily unavailable. Please try again later'],
];

// The refund message a customer sees for a failed job, e.g.
// failureMessage('video', '输入图片触发安全策略') →
// 'The safety filter blocked this video. … Credits were refunded.'
// Unrecognised Chinese reasons are dropped; English ones are kept (vendor
// names are still removed by hideVendors before customers see them).
function failureMessage(media, reason) {
  const text = String(reason || '').trim();
  const known = KNOWN.find(([pattern]) => pattern.test(text));
  if (known) return known[1].replace('video', media) + '. Credits were refunded.';
  const base = 'The ' + media + ' could not be completed';
  if (!text || HAN.test(text)) return base + '. Credits were refunded.';
  return base + ': ' + text.replace(/[.!。]+$/, '') + '. Credits were refunded.';
}

module.exports = { failureMessage };

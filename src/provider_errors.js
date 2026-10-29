'use strict';

// Some sources answer failures in Chinese (888API: "输入图片触发安全策略，请更换图片后重试").
// Customers get a plain English sentence instead; the activity log keeps the
// original text for the admin.
const HAN = /[㐀-鿿]/;
const MAINTENANCE = 'Model under maintenance. Please choose another model';
// The source has switched the model off or has no capacity for it, e.g.
// "请改用其他模型" (please use another model), "无可用渠道" (no channel),
// "该渠道不支持模型: …" (channel dropped the model) or
// "2.5需要临时修复…" (model pulled for a temporary fix).
const MODEL_DOWN = /改用其他模型|不支持模型|临时修复|换其他模型|其他模型|无可用渠道|没有可用|暂无可用|模型不可用|模型.{0,6}(维护|下线|停用|不存在|不支持)|维护中|已下线|已停用|no available channel|model.{0,24}(not found|unavailable|disabled|does not exist|not supported|offline|maintenance)/i;
const KNOWN = [
  // Safety / moderation. 888API says "input image" even for text-to-video
  // jobs without images, so the advice names both.
  [/安全策略|安全审核|内容安全|审核|敏感|违规|不合规|色情|涉黄|涉政|暴力|moderation|safety|sensitive content|nsfw/i, 'The safety filter blocked this video. Please change your prompt or images and try again'],
  [MODEL_DOWN, MAINTENANCE],
  [/频繁|限流|繁忙|并发|排队|too many requests|rate limit/i, 'The service is busy right now. Please try again in a few minutes'],
  [/超时|timed? ?out/i, 'The video took too long to generate. Please try again'],
  // One-off glitches at the source that it asks us to resubmit, e.g.
  // "网络波动异常，请重新提交" (network blip) or "系统异常，请重新提交".
  [/重新提交|重试|网络波动|网络异常|系统异常|服务异常|内部错误|internal (server )?error/i, 'The video failed because of a temporary error. Please try again'],
];

const modelUnavailable = reason => MODEL_DOWN.test(String(reason || ''));

// The refund message a customer sees for a failed job, e.g.
// failureMessage('video', '输入图片触发安全策略') →
// 'The safety filter blocked this video. … Credits were refunded.'
// Any other source reason, in any language, is never shown: the customer
// reads "Model under maintenance" and Activity keeps the raw text.
function failureMessage(media, reason) {
  const text = String(reason || '').trim();
  const known = KNOWN.find(([pattern]) => pattern.test(text));
  if (known) return known[1].replace('video', media) + '. Credits were refunded.';
  if (!text) return 'The ' + media + ' could not be completed. Credits were refunded.';
  return MAINTENANCE + '. Credits were refunded.';
}

// Last guard before a customer sees a stored message: raw source errors
// (Chinese text, "Request failed (HTTP 400)", request ids) become the
// maintenance notice, including failures saved before this guard existed.
const RAW = /[㐀-鿿]|^\s*(?:888[\s-]*API\s+)?request failed\s*\(HTTP\s*\d{3}\)|\brequest[\s_-]*id\b/i;
function customerError(text) {
  if (typeof text !== 'string' || !RAW.test(text)) return text;
  return MAINTENANCE + '.' + (/refunded/i.test(text) ? ' Credits were refunded.' : '');
}

module.exports = { failureMessage, modelUnavailable, customerError, MAINTENANCE };

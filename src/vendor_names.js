'use strict';

// Customers never see which companies run CMM Tools' models. Provider error
// messages are passed through this before they reach a customer or Claude;
// the activity log and Admin keep the real names.
const VENDORS = /\b(?:Vercel\s+AI\s+Gateway|AI\s+Gateway|Vercel|ArgoLink|Argo\s*Link|Vidancee|CreatePulse|Create\s*Pulse|vgenv|SmartAIPI|Smart\s*AIPI|fal\.ai|fal|Vibi|Gemini|ByteDance|Alibaba\s+Cloud|aliyuncs?)\b/gi;

function hideVendors(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/\b(?:CREATEPULSE|VIDANCEE|VGENV|ARGOLINK|SMARTAIPI|VERCEL|FAL|VIBI|GEMINI)_[A-Z_]+\b/g, 'service setting')
    .replace(VENDORS, 'the generation service')
    .replace(/the generation service(?:\s+the generation service)+/gi, 'the generation service')
    .replace(/\b(?:the|a|an|our)\s+the generation service/gi, 'the generation service')
    .replace(/the generation service(?:'s)? storage/gi, 'storage')
    .replace(/(^|[.!?]\s+)the generation service/g, (m, start) => start + 'The generation service');
}

// Hides vendor names in error/message fields of a JSON body (never in prompts).
const MESSAGE_KEYS = new Set(['error', 'message', 'error_message', 'note']);
function hideVendorsInBody(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 6) return body;
  if (Array.isArray(body)) { for (const item of body) hideVendorsInBody(item, depth + 1); return body; }
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') { if (MESSAGE_KEYS.has(key)) body[key] = hideVendors(value); }
    else if (value && typeof value === 'object') hideVendorsInBody(value, depth + 1);
  }
  return body;
}

module.exports = { hideVendors, hideVendorsInBody };

'use strict';

const { customerError } = require('./provider_errors.js');

// Customers never see which companies run CMM Tools' models. Provider error
// messages are passed through this before they reach a customer or Claude;
// the activity log and Admin keep the real names.
const VENDORS = /\b(?:888[\s-]*API(?:\.xin)?|API[\s-]*888|Vercel\s+AI\s+Gateway|AI\s+Gateway|Vercel|ArgoLink|Argo\s*Link|Vidancee|CreatePulse|Create\s*Pulse|vgenv|SmartAIPI|Smart\s*AIPI|fal\.ai|fal|Vibi|Gemini|ByteDance|Alibaba\s+Cloud|aliyuncs?|Yotta\s*Labs|Yotta|Higgsfield|Sluice|getsluice(?:\.com)?)\b/gi;

// Raw source errors (Chinese text, "Request failed (HTTP 400)") are replaced
// with the maintenance notice first (provider_errors.js customerError).
function hideVendors(text) {
  if (typeof text !== 'string' || !text) return text;
  return customerError(text)
    .replace(/\b(?:CREATEPULSE|VIDANCEE|VGENV|ARGOLINK|SMARTAIPI|VERCEL|FAL|VIBI|GEMINI|YOTTA|HIGGSFIELD|SLUICE)_[A-Z_]+\b/g, 'service setting')
    .replace(/\bAPI888_[A-Z_]+\b/g, 'service setting')
    .replace(/\bapi888_(?=[a-z0-9])/gi, '')
    // "This 888API model" reads better as "This model" than with a stand-in.
    .replace(/\b(?:888[\s-]*API|API[\s-]*888)\s+(?=(?:model|image|video|audio|output|references?|task|request|operation|key|token|balance)\b)/gi, '')
    .replace(/^[a-z]/, c => c.toUpperCase())
    .replace(VENDORS, 'the generation service')
    .replace(/the generation service(?:\s+the generation service)+/gi, 'the generation service')
    .replace(/\b(?:the|a|an|our)\s+the generation service/gi, 'the generation service')
    .replace(/the generation service(?:'s)? storage/gi, 'storage')
    .replace(/(^|[.!?]\s+)the generation service/g, (m, start) => start + 'The generation service');
}

// Model names are shown as-is (they name models such as Gemini), but never
// carry the 888API source name, even when Admin typed it into a label.
function hideApi888Name(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(/\s*[(\[]?\s*\b(?:888[\s-]*API|API[\s-]*888)\b\s*[)\]]?\s*/gi, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[·\-–|:\s]+|[·\-–|:\s]+$/g, '');
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

module.exports = { hideVendors, hideVendorsInBody, hideApi888Name };

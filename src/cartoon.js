'use strict';

// Cartoon Studio: video in a chosen cartoon style, made with Seedance Lite on
// Sluice or MiniMax H3 on vgenv. The customer's own prompt is
// stored on the job; the style direction is added only when it is submitted.
const { H3_MODEL_IDS } = require('./pricing.js');
// The new alias is Video Studio-only; no duplicate Origin in Cartoon Studio.
const CARTOON_MODELS = H3_MODEL_IDS.filter(id => id !== 'seedance_2_0_mini');
// Seedance Lite on Sluice (ids sl_…) is in Cartoon Studio too.
const isCartoonModel = id => CARTOON_MODELS.includes(String(id || '')) || String(id || '').startsWith('sl_');

const CARTOON_STYLES = [
  { id: '3d', label: '3D Animation', hint: 'Feature-film 3D characters',
    directive: '3D animated feature film style: expressive stylized characters with large eyes, soft global illumination, smooth rounded shapes, rich saturated colour and a cinematic camera.' },
  { id: 'anime', label: 'Anime', hint: 'Cel-shaded Japanese animation',
    directive: 'Japanese anime style: clean cel shading, crisp line art, vivid colours, expressive eyes, painted backgrounds and dynamic camera moves.' },
  { id: '2d', label: '2D Cartoon', hint: 'Bold outlines, flat colour',
    directive: 'Classic 2D cartoon style: bold outlines, flat bright colours, squash-and-stretch animation and playful, exaggerated motion.' },
  { id: 'clay', label: 'Claymation', hint: 'Handmade stop-motion',
    directive: 'Stop-motion claymation style: handmade plasticine characters and miniature sets with visible texture and fingerprints, slightly stepped motion and warm miniature lighting.' },
  { id: 'comic', label: 'Comic', hint: 'Inked panels and halftones',
    directive: 'Comic-book animation style: inked outlines, halftone shading, punchy colours and bold graphic framing.' },
];

function cartoonStyle(id) {
  return CARTOON_STYLES.find(style => style.id === String(id || '')) || null;
}

function normalizeCartoonRequest(body) {
  const style = cartoonStyle(body.cartoonStyle);
  if (!style) throw Object.assign(new Error('Choose a cartoon style.'), { statusCode: 400 });
  if (!isCartoonModel(body.model)) {
    throw Object.assign(new Error('Cartoon Studio supports Seedance Lite and MiniMax H3.'), { statusCode: 400 });
  }
  return { studio: 'cartoon', cartoonStyle: style.id };
}

function parseOptions(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

function isCartoonJob(job) {
  return parseOptions(job?.generation_options).studio === 'cartoon';
}

// Prompt actually sent to the provider.
function providerPrompt(job) {
  const options = parseOptions(job?.generation_options);
  const style = options.studio === 'cartoon' ? cartoonStyle(options.cartoonStyle) : null;
  const prompt = String(job?.prompt || '');
  return style ? style.directive + ' Scene: ' + prompt : prompt;
}

function looksOutOfCredits(error) {
  const text = [error?.message, safeStringify(error?.details)].join(' ');
  return /insufficient|not enough|out of credit|no credits|credit balance|balance|top.?up|quota|payment required|\b402\b/i.test(text);
}

function safeStringify(value) {
  try { return JSON.stringify(value ?? ''); } catch { return ''; }
}

function publicCartoonConfig(enabled, pricing) {
  return {
    enabled: Boolean(enabled),
    styles: CARTOON_STYLES.map(({ id, label, hint }) => ({ id, label, hint })),
    pricing: pricing.filter(model => isCartoonModel(model.id)),
  };
}

module.exports = {
  CARTOON_MODELS, CARTOON_STYLES, cartoonStyle, normalizeCartoonRequest, isCartoonJob,
  providerPrompt, looksOutOfCredits, publicCartoonConfig,
};

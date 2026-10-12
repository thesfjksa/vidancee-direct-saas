'use strict';

// Cartoon Studio: Seedance video in a chosen cartoon style, sent to Vidancee or
// CreatePulse (whichever has provider credits). The customer's own prompt is
// stored on the job; the style direction is added only when it is submitted.
const CARTOON_MODELS = ['seedance_2.5', 'seedance_2.0_fast'];

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
  if (!CARTOON_MODELS.includes(String(body.model || ''))) {
    throw Object.assign(new Error('Cartoon Studio supports Seedance 2.5 and Seedance 2.0 Fast.'), { statusCode: 400 });
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

// Vidancee charged 6 credits for 10s and 9 for 15s (14 for a 30s image job).
// 0.6 per second covers all observed jobs; the real charge stays Vidancee's.
function vidanceeCreditsNeeded(job) {
  return Math.ceil(Math.max(1, Number(job?.duration || 10)) * 0.6);
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
    pricing: pricing.filter(model => CARTOON_MODELS.includes(model.id)),
  };
}

module.exports = {
  CARTOON_MODELS, CARTOON_STYLES, cartoonStyle, normalizeCartoonRequest, isCartoonJob,
  providerPrompt, vidanceeCreditsNeeded, looksOutOfCredits, publicCartoonConfig,
};

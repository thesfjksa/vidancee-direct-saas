const { usdToCredits } = require('./billing.js');

// Fixed-price video models cost the customer exactly what CMM Tools pays for
// them, in credits (24 credits per rupee of cost; see billing.js), rounded up
// to whole credits. The profit is in the plan price, not here.
const perSecond = (rate, seconds) => Math.ceil(rate * seconds - 1e-9);

// vgenv MiniMax H3 (vgenv.com/pricing, checked 30 October 2026).
// Preserve the three existing Fast-tier models and their pricing.
// "Minimax Beast" is a separate CMMTools choice using vgenv Origin + Quality,
// not a new upstream model; its higher tier must be passed to /v3/videos.
const H3_MODELS = {
  minimax_h3: { label: 'MiniMax H3 Base', vgenvModel: 'base', usdPerSecond: { '480p': 0.0015, '768p': 0.003 } },
  minimax_h3_cinematic: { label: 'MiniMax H3 Cinematic', vgenvModel: 'cinematic', usdPerSecond: { '480p': 0.0015, '768p': 0.003 } },
  minimax_h3_origin: { label: 'MiniMax H3 Origin', vgenvModel: 'origin', usdPerSecond: { '480p': 0.0023, '768p': 0.0046 } },
  // CMMTools alias; actual upstream is MiniMax H3 Origin Fast, NOT Seedance.
  seedance_2_0_mini: { label: 'Seedance 2.0 Mini', vgenvModel: 'origin', usdPerSecond: { '480p': 0.0023, '768p': 0.0046 },
    warning: 'Powered by MiniMax H3 Origin (Fast) on vgenv, not the original ByteDance Seedance model.' },
  minimax_beast: { label: 'Minimax Beast', vgenvModel: 'origin', vgenvTier: 'quality', usdPerSecond: { '480p': 0.0077, '768p': 0.015 } },
};
const H3_MODEL_IDS = Object.keys(H3_MODELS);
const isH3Model = id => Object.hasOwn(H3_MODELS, String(id || ''));
// The model name vgenv takes for one of our ids ('base' for unknown ids).
const h3VgenvModel = id => (isH3Model(id) ? H3_MODELS[id].vgenvModel : 'base');
// Base/Cinematic/Origin remain Fast; Beast requests Origin Quality.
const h3VgenvTier = id => (isH3Model(id) ? (H3_MODELS[id].vgenvTier || 'fast') : 'fast');

function h3Durations(rate) {
  const durations = {};
  for (let seconds = 4; seconds <= 15; seconds += 1) {
    durations[seconds] = perSecond(rate, seconds);
  }
  return durations;
}

function h3ResolutionCosts(usdPerSecond) {
  return { '480p': h3Durations(usdToCredits(usdPerSecond['480p'])), '768p': h3Durations(usdToCredits(usdPerSecond['768p'])) };
}

function pricingMap() {
  return Object.fromEntries(Object.entries(H3_MODELS).map(([id, model]) => [id, {
    label: model.label,
    ...(model.warning ? { warning: model.warning } : {}),
    defaultResolution: '768p',
    resolutions: ['480p', '768p'],
    resolutionCosts: h3ResolutionCosts(model.usdPerSecond),
  }]));
}

const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:3'];

function durationEntries(durations) {
  return Object.entries(durations || {})
    .filter(([, cost]) => Number.isFinite(Number(cost)) && Number(cost) > 0)
    .map(([seconds, cost]) => ({ seconds: Number(seconds), cost: Number(cost) }));
}

function normalizeResolution(model, resolution) {
  const info = pricingMap()[model];
  if (!info) {
    const error = new Error('This model is not enabled.');
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(info.resolutions) || !info.resolutions.length) return null;

  const value = String(resolution || info.defaultResolution || '').trim().toLowerCase();
  if (!info.resolutions.includes(value)) {
    const error = new Error('Unsupported resolution for this model.');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function getCost(model, duration, resolution = null) {
  const modelInfo = pricingMap()[model];
  if (!modelInfo) {
    const error = new Error('This model/duration combination is not enabled.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedResolution = normalizeResolution(model, resolution);
  const durations = modelInfo.resolutionCosts
    ? modelInfo.resolutionCosts[normalizedResolution]
    : modelInfo.durations;

  const cost = durations && durations[Number(duration)];
  if (!Number.isFinite(Number(cost)) || Number(cost) <= 0) {
    const error = new Error('This model/duration/resolution combination is not enabled.');
    error.statusCode = 400;
    throw error;
  }
  return Number(cost);
}

function publicPricing() {
  const map = pricingMap();
  return Object.entries(map).map(([id, info]) => {
    if (info.resolutionCosts) {
      const resolutions = info.resolutions.map(resolution => ({
        id: resolution,
        label: resolution,
        durations: durationEntries(info.resolutionCosts[resolution]),
      }));
      const defaultResolution = info.defaultResolution || info.resolutions[0];
      const defaultEntry = resolutions.find(item => item.id === defaultResolution) || resolutions[0];
      return {
        id,
        label: info.label,
        ...(info.warning ? { warning: info.warning } : {}),
        defaultResolution,
        resolutions,
        durations: defaultEntry ? defaultEntry.durations : [],
      };
    }

    return {
      id,
      label: info.label,
      defaultResolution: null,
      resolutions: [],
      durations: durationEntries(info.durations),
    };
  });
}

function validateAspectRatio(value) {
  if (!ASPECT_RATIOS.includes(value)) {
    const error = new Error('Unsupported aspect ratio.');
    error.statusCode = 400;
    throw error;
  }
}

module.exports = {
  getCost,
  publicPricing,
  validateAspectRatio,
  normalizeResolution,
  ASPECT_RATIOS,
  H3_MODEL_IDS,
  isH3Model,
  h3VgenvModel,
  h3VgenvTier,
};

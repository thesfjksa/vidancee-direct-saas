const { positiveNumber, sourceToCustomerCredits } = require('./billing.js');

function sourceCost(name, fallback = null) {
  return positiveNumber(process.env[name], fallback);
}

function h3Durations(perSecond) {
  const durations = {};
  for (let seconds = 4; seconds <= 15; seconds += 1) {
    durations[seconds] = sourceToCustomerCredits(perSecond * seconds);
  }
  return durations;
}

function h3ResolutionCosts() {
  return {
    '480p': h3Durations(sourceCost('SOURCE_MINIMAX_H3_FAST_480P_CREDITS_PER_SECOND', 0.15)),
    '768p': h3Durations(sourceCost('SOURCE_MINIMAX_H3_FAST_768P_CREDITS_PER_SECOND', 0.3)),
  };
}

// Vidancee and CreatePulse charge about Rs 40 for 30 s of Seedance 2.5. A
// CMM Tools credit sells for Rs 3 (every plan), so the source cost is
// 40 / 30 / 3 credits per second before the 2.5x customer multiplier.
// Seedance 2.0 Fast keeps its earlier 5:6 ratio to Seedance 2.5.
const SEEDANCE_25_PER_SECOND = 40 / 30 / 3;
const SEEDANCE_20_FAST_PER_SECOND = SEEDANCE_25_PER_SECOND * 5 / 6;
const perSecond = (rate, seconds) => Math.round(rate * seconds * 10000) / 10000;

function pricingMap() {
  return {
    'seedance_2.5': {
      label: 'Seedance 2.5',
      resolutions: [],
      durations: {
        10: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_25_10', perSecond(SEEDANCE_25_PER_SECOND, 10))),
        15: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_25_15', perSecond(SEEDANCE_25_PER_SECOND, 15))),
        20: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_25_20', null)),
        30: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_25_30', perSecond(SEEDANCE_25_PER_SECOND, 30))),
      },
    },
    'seedance_2.0_fast': {
      label: 'Seedance 2.0 Fast',
      resolutions: [],
      durations: {
        10: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_20_FAST_10', perSecond(SEEDANCE_20_FAST_PER_SECOND, 10))),
        15: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_20_FAST_15', perSecond(SEEDANCE_20_FAST_PER_SECOND, 15))),
      },
    },
    'minimax_h3': {
      label: 'MiniMax H3',
      defaultResolution: '768p',
      resolutions: ['480p', '768p'],
      resolutionCosts: h3ResolutionCosts(),
    },
  };
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
};

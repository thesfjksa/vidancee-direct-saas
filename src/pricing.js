const { rsToCredits, usdToCredits } = require('./billing.js');

// Fixed-price video models cost the customer exactly what CMM Tools pays for
// them, in credits (24 credits per rupee of cost; see billing.js), rounded up
// to whole credits. The profit is in the plan price, not here.
const perSecond = (rate, seconds) => Math.ceil(rate * seconds - 1e-9);

// Vidancee and CreatePulse: Rs 40 for 30 s of Seedance 2.5. Seedance 2.0 Fast
// keeps its earlier 5:6 ratio to Seedance 2.5.
const SEEDANCE_25_PER_SECOND = rsToCredits(40 / 30);
const SEEDANCE_20_FAST_PER_SECOND = SEEDANCE_25_PER_SECOND * 5 / 6;

// vgenv MiniMax H3, Fast tier (vgenv.com/developers): $0.0015/s at 480p,
// $0.003/s at 768p.
const H3_PER_SECOND = { '480p': usdToCredits(0.0015), '768p': usdToCredits(0.003) };

function h3Durations(rate) {
  const durations = {};
  for (let seconds = 4; seconds <= 15; seconds += 1) {
    durations[seconds] = perSecond(rate, seconds);
  }
  return durations;
}

function h3ResolutionCosts() {
  return { '480p': h3Durations(H3_PER_SECOND['480p']), '768p': h3Durations(H3_PER_SECOND['768p']) };
}

function pricingMap() {
  return {
    'seedance_2.5': {
      label: 'Seedance 2.5',
      resolutions: [],
      durations: {
        10: (perSecond(SEEDANCE_25_PER_SECOND, 10)),
        15: (perSecond(SEEDANCE_25_PER_SECOND, 15)),
        30: (perSecond(SEEDANCE_25_PER_SECOND, 30)),
      },
    },
    'seedance_2.0_fast': {
      label: 'Seedance 2.0 Fast',
      resolutions: [],
      durations: {
        10: (perSecond(SEEDANCE_20_FAST_PER_SECOND, 10)),
        15: (perSecond(SEEDANCE_20_FAST_PER_SECOND, 15)),
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

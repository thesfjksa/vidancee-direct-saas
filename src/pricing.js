const { positiveNumber, sourceToCustomerCredits } = require('./billing.js');

function sourceCost(name, fallback = null) {
  return positiveNumber(process.env[name], fallback);
}

function h3Durations() {
  const perSecond = sourceCost('SOURCE_MINIMAX_H3_FAST_768P_CREDITS_PER_SECOND', 0.3);
  const durations = {};
  for (let seconds = 4; seconds <= 15; seconds += 1) {
    durations[seconds] = sourceToCustomerCredits(perSecond * seconds);
  }
  return durations;
}

function pricingMap() {
  return {
    'seedance_2.5': {
      label: 'Seedance 2.5',
      durations: {
        10: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_25_10', 6)),
        15: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_25_15', 9)),
        20: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_25_20', null)),
        30: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_25_30', 14)),
      },
    },
    'seedance_2.0_fast': {
      label: 'Seedance 2.0 Fast',
      durations: {
        // Customer-facing product rule: Seedance 2.0 Fast is locked to 10 seconds.
        10: sourceToCustomerCredits(sourceCost('PRICE_SEEDANCE_20_FAST_10', 5)),
      },
    },
    'minimax_h3': {
      label: 'MiniMax H3',
      durations: h3Durations(),
    },
  };
}

const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:3'];

function getCost(model, duration) {
  const modelInfo = pricingMap()[model];
  const cost = modelInfo && modelInfo.durations[Number(duration)];
  if (!Number.isFinite(Number(cost)) || Number(cost) <= 0) {
    const error = new Error('This model/duration combination is not enabled.');
    error.statusCode = 400;
    throw error;
  }
  return Number(cost);
}

function publicPricing() {
  const map = pricingMap();
  return Object.entries(map).map(([id, info]) => ({
    id,
    label: info.label,
    durations: Object.entries(info.durations)
      .filter(([, cost]) => Number.isFinite(Number(cost)) && Number(cost) > 0)
      .map(([seconds, cost]) => ({ seconds: Number(seconds), cost: Number(cost) })),
  }));
}

function validateAspectRatio(value) {
  if (!ASPECT_RATIOS.includes(value)) {
    const error = new Error('Unsupported aspect ratio.');
    error.statusCode = 400;
    throw error;
  }
}

module.exports = { getCost, publicPricing, validateAspectRatio, ASPECT_RATIOS };

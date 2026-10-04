function optionalPositiveInt(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function pricingMap() {
  return {
    seedance_2.5: {
      label: 'Seedance 2.5',
      durations: {
        10: optionalPositiveInt('PRICE_SEEDANCE_25_10', 6),
        15: optionalPositiveInt('PRICE_SEEDANCE_25_15', 9),
        30: optionalPositiveInt('PRICE_SEEDANCE_25_30', 14),
      },
    },
    seedance_2.0_fast: {
      label: 'Seedance 2.0 Fast',
      durations: {
        10: optionalPositiveInt('PRICE_SEEDANCE_20_FAST_10', 5),
        15: optionalPositiveInt('PRICE_SEEDANCE_20_FAST_15', null),
        30: optionalPositiveInt('PRICE_SEEDANCE_20_FAST_30', null),
      },
    },
  };
}

const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'];

function getCost(model, duration) {
  const modelInfo = pricingMap()[model];
  const cost = modelInfo && modelInfo.durations[Number(duration)];
  if (!Number.isInteger(cost) || cost <= 0) {
    const error = new Error('This model/duration combination is not enabled.');
    error.statusCode = 400;
    throw error;
  }
  return cost;
}

function publicPricing() {
  const map = pricingMap();
  return Object.entries(map).map(([id, info]) => ({
    id,
    label: info.label,
    durations: Object.entries(info.durations)
      .filter(([, cost]) => Number.isInteger(cost) && cost > 0)
      .map(([seconds, cost]) => ({ seconds: Number(seconds), cost })),
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

'use strict';

const { PKR_PER_USD, PRICE_INCREASE } = require('./billing.js');
const { RS_PER_CREDIT } = require('./plans.js');

const API_ORIGIN = 'https://ai.dijinlong.com';
const MODEL_ID = 'seedance-2.0-mini';
const PUBLIC_ID = 'longai_seedance_2_0_mini';
const RESOLUTIONS = ['480p', '720p'];
const TARGET_GROSS_MARGIN = 0.55;
// Quotes and debits already apply PRICE_INCREASE after the base quote.
const LONG_AI_CUSTOMER_CREDITS_PER_USD =
  PKR_PER_USD / (RS_PER_CREDIT * (1 - TARGET_GROSS_MARGIN) * PRICE_INCREASE);
const isLongAiModel = id => id === PUBLIC_ID;

function longAiMediaModel(rates) {
  const pricing = RESOLUTIONS.map(resolution => {
    const rate = rates?.[resolution];
    const cost = typeof rate === 'string' || typeof rate === 'number' ? Number(rate) : NaN;
    if (!(cost > 0 && cost <= 100)) {
      throw Object.assign(new Error('Enter a positive USD price per second for ' + resolution + ' (up to $100).'), { statusCode: 400 });
    }
    return { resolution, cost_per_second: cost };
  });
  return {
    providerModelId: MODEL_ID, publicModelId: PUBLIC_ID, label: 'Seedance 2.0 Mini · LONG AI', mediaType: 'video',
    options: {
      catalogVerified: true, adapterSupported: true, gatewayType: 'video',
      pricing: { video_duration_pricing: pricing },
      supportedOperations: ['text-to-video'],
      durations: Array.from({ length: 12 }, (_, i) => i + 4),
      resolutions: RESOLUTIONS, aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      defaultDuration: 5, defaultResolution: '480p', defaultAspectRatio: '16:9',
      referenceCapabilities: { textOnly: true, totalMax: 0 },
    },
  };
}

module.exports = { API_ORIGIN, MODEL_ID, PUBLIC_ID, LONG_AI_CUSTOMER_CREDITS_PER_USD, isLongAiModel, longAiMediaModel };

const { positiveNumber, sourceToCustomerCredits } = require('./billing.js');

function sourceCost(name, fallback = null) {
  return positiveNumber(process.env[name], fallback);
}

const IMAGE_ASPECT_RATIOS = ['1:1', '4:3', '16:9', '9:16'];

const SEEDREAM_SIZE_BY_RATIO = {
  '1:1': '2048*2048',
  '4:3': '2304*1728',
  '16:9': '2848*1600',
  '9:16': '1600*2848',
};

function imagePricingMap() {
  return {
    seedream_v5_lite: {
      label: 'Seedream 5.0 Lite',
      cost: sourceToCustomerCredits(sourceCost('PRICE_IMAGE_SEEDREAM_50_LITE', 2)),
      textModel: 'bytedance/seedream-v5.0-lite',
      referenceModel: 'bytedance/seedream-v5.0-lite/edit',
      buildPayload({ prompt, aspectRatio, imageUrls = [] }) {
        const payload = {
          model: imageUrls.length ? this.referenceModel : this.textModel,
          prompt,
          size: SEEDREAM_SIZE_BY_RATIO[aspectRatio],
          output_format: 'jpeg',
        };
        if (imageUrls.length) payload.images = imageUrls;
        return payload;
      },
    },
    nano_banana_2: {
      label: 'Nano Banana 2',
      cost: sourceToCustomerCredits(sourceCost('PRICE_IMAGE_NANO_BANANA_2', 3)),
      textModel: 'google/nano-banana-2/text-to-image',
      referenceModel: 'google/nano-banana-2/reference-to-image',
      buildPayload({ prompt, aspectRatio, imageUrls = [] }) {
        const payload = {
          model: imageUrls.length ? this.referenceModel : this.textModel,
          prompt,
          aspect_ratio: aspectRatio,
          resolution: '2k',
        };
        if (imageUrls.length) payload.images = imageUrls;
        return payload;
      },
    },
  };
}

function getImageModelSpec(model) {
  const spec = imagePricingMap()[String(model || '')];
  if (!spec || !Number.isFinite(Number(spec.cost)) || Number(spec.cost) <= 0) {
    const error = new Error('This image model is not enabled.');
    error.statusCode = 400;
    throw error;
  }
  return spec;
}

function getImageCost(model) {
  return Number(getImageModelSpec(model).cost);
}

function validateImageAspectRatio(value) {
  if (!IMAGE_ASPECT_RATIOS.includes(String(value || ''))) {
    const error = new Error('Unsupported image aspect ratio.');
    error.statusCode = 400;
    throw error;
  }
}

function publicImagePricing() {
  return Object.entries(imagePricingMap())
    .filter(([, spec]) => Number.isFinite(Number(spec.cost)) && Number(spec.cost) > 0)
    .map(([id, spec]) => ({ id, label: spec.label, cost: Number(spec.cost) }));
}

module.exports = {
  IMAGE_ASPECT_RATIOS,
  getImageModelSpec,
  getImageCost,
  validateImageAspectRatio,
  publicImagePricing,
};

const { sourceToCustomerCredits } = require('./billing.js');

// Explicit API IDs and square source-price estimates from SmartAIPI's pricing
// page (2026-10-09). Public IDs preserve routing independently of other catalogs.
const SMART_IMAGE_QUALITIES = ['low', 'medium', 'high'];
const SMART_IMAGE_MODELS = [
  ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare', [0.003, 0.0265, 0.1055]],
  ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', [0.003, 0.0265, 0.1055]],
  ['gpt-image-2', 'GPT Image 2', [0.003, 0.0265, 0.1055]],
  ['gpt-image-1.5', 'GPT Image 1.5', [0.0045, 0.017, 0.067]],
  ['gpt-image-1', 'GPT Image 1', [0, 0, 0]],
  ['gpt-image-1-mini', 'GPT Image 1 Mini', [0.0025, 0.0055, 0.018]],
].map(([apiModel, label, prices]) => ({
  id: apiModel.replace(/[-.]/g, '_') + '_studio', apiModel, label,
  sourceUsd: prices[1], qualitySourceUsd: Object.fromEntries(SMART_IMAGE_QUALITIES.map((q, i) => [q, prices[i]])),
  freeformSizes: /^gpt-image-2(?:\.|$)/.test(apiModel),
}));
const SMART_IMAGE_SIZES = {
  '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536',
  '16:9': '1536x864', '9:16': '864x1536', '4:3': '1280x960', '3:4': '960x1280',
  '4:5': '1024x1280', '5:4': '1280x1024', '3:1': '1536x512', '1:3': '512x1536',
};
const SMART_IMAGE_FIXED_RATIOS = ['1:1', '3:2', '2:3'];
const SMART_IMAGE_REFS = { image: { supported: true, min: 0, max: 1 } };

function defaultSmartImageConfig() {
  return Object.fromEntries(SMART_IMAGE_MODELS.map(m => [m.id, {
    enabled: true, sourceUsd: m.sourceUsd, qualitySourceUsd: { ...m.qualitySourceUsd },
  }]));
}

function normalizeSmartImageConfig(input = defaultSmartImageConfig()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid GPT image pricing.');
  const out = defaultSmartImageConfig();
  for (const [id, value] of Object.entries(input)) {
    const spec = smartImageModel(id);
    if (!spec || !value || typeof value !== 'object') throw new Error('Unknown GPT image model.');
    if (typeof value.enabled !== 'boolean') throw new Error('Image model enabled must be true or false.');
    const explicit = value.qualitySourceUsd;
    if (explicit !== undefined && (!explicit || typeof explicit !== 'object' || Array.isArray(explicit) ||
        Object.keys(explicit).some(q => !SMART_IMAGE_QUALITIES.includes(q)))) throw new Error('Invalid image quality pricing.');
    const medium = Number(explicit?.medium ?? value.sourceUsd ?? spec.sourceUsd);
    // Preserve existing medium overrides. Derive initial low/high estimates in
    // proportion to published rates, except unpriced GPT Image 1 (no guessed rate).
    const prices = Object.fromEntries(SMART_IMAGE_QUALITIES.map(q => [q,
      Number(explicit?.[q] ?? (q === 'medium' ? medium : spec.sourceUsd > 0 ? spec.qualitySourceUsd[q] * medium / spec.sourceUsd : 0)),
    ]));
    if (Object.values(prices).some(n => !Number.isFinite(n) || n < 0 || n > 1000)) throw new Error('Image source price must be between $0 and $1000.');
    out[id] = { enabled: value.enabled, sourceUsd: prices.medium, qualitySourceUsd: prices };
  }
  return out;
}

function smartImageModel(id) { return SMART_IMAGE_MODELS.find(m => m.id === String(id || '')) || null; }
function smartImageRatios(id) { return smartImageModel(id)?.freeformSizes ? Object.keys(SMART_IMAGE_SIZES) : [...SMART_IMAGE_FIXED_RATIOS]; }
function smartImageSourcePrice(price, quality = 'medium') {
  return Number(quality === 'medium' ? price?.sourceUsd : price?.qualitySourceUsd?.[quality] || 0);
}

function smartImageRequestSpec(id, ratio, quality = 'medium') {
  const spec = smartImageModel(id);
  if (!spec || !smartImageRatios(id).includes(String(ratio))) {
    throw Object.assign(new Error('Unsupported image aspect ratio for this model.'), { statusCode: 400 });
  }
  if (!SMART_IMAGE_QUALITIES.includes(quality)) {
    throw Object.assign(new Error('Unsupported image quality. Choose Low, Medium or High.'), { statusCode: 400 });
  }
  return { size: SMART_IMAGE_SIZES[ratio], quality, apiModel: spec.apiModel };
}

function smartImageQuote(id, ratio, settings, quality = 'medium') {
  const price = settings.smartAipiModels?.[id];
  if (!smartImageModel(id) || !price?.enabled) {
    throw Object.assign(new Error('This image model is not enabled.'), { statusCode: 400 });
  }
  const request = smartImageRequestSpec(id, ratio, quality);
  const squareSourceUsd = smartImageSourcePrice(price, quality);
  if (!(squareSourceUsd > 0)) throw Object.assign(new Error('This image quality does not have an enabled price.'), { statusCode: 400 });
  const [width, height] = request.size.split('x').map(Number);
  // Fixed landscape/portrait retain the existing 1.5x estimate. New free-form
  // presets use an explicitly approximate pixel-area estimate, editable via
  // each quality's square source rate. Input tokens can add upstream charges.
  const sourceUsd = squareSourceUsd * width * height / (1024 * 1024);
  const cost = sourceToCustomerCredits(sourceUsd * settings.smartAipiCreditsPerUsd);
  if (!(cost > 0)) throw Object.assign(new Error('This image quality needs a valid credit price.'), { statusCode: 400 });
  return { cost, sourceUsd, ...request };
}

function publicSmartImagePricing(settings) {
  if (!settings.smartAipiEnabled || !settings.smartAipiApiKey) return [];
  return SMART_IMAGE_MODELS.flatMap(spec => {
    const aspectRatios = smartImageRatios(spec.id);
    const costByQuality = {};
    for (const quality of SMART_IMAGE_QUALITIES) {
      try { costByQuality[quality] = Object.fromEntries(aspectRatios.map(r => [r, smartImageQuote(spec.id, r, settings, quality).cost])); }
      catch { /* Unconfigured qualities stay hidden and cannot be submitted. */ }
    }
    const qualities = Object.keys(costByQuality);
    if (!qualities.length) return [];
    const defaultQuality = qualities.includes('medium') ? 'medium' : qualities[0];
    const costByAspectRatio = costByQuality[defaultQuality];
    return [{ id: spec.id, label: spec.label, cost: costByAspectRatio['1:1'], costByAspectRatio, costByQuality,
      qualities, defaultQuality, aspectRatios, defaultAspectRatio: '1:1', referenceCapabilities: SMART_IMAGE_REFS,
      capabilities: { totalMax: 1, image: { ...SMART_IMAGE_REFS.image, maxBytes: 20 * 1024 * 1024, roles: ['image_references'] } } }];
  });
}

module.exports = { SMART_IMAGE_MODELS, SMART_IMAGE_SIZES, SMART_IMAGE_QUALITIES, SMART_IMAGE_REFS,
  defaultSmartImageConfig, normalizeSmartImageConfig, smartImageModel, smartImageRatios,
  smartImageSourcePrice, smartImageRequestSpec, smartImageQuote, publicSmartImagePricing };

const { sourceToCustomerCredits } = require('./billing.js');

// Explicit API IDs from https://smartaipi.com/docs. Public IDs are distinct from
// other providers' catalogs so saved generations always retain their routing.
const SMART_IMAGE_MODELS = [
  ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare', 0.0265],
  ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', 0.0265],
  ['gpt-image-2', 'GPT Image 2', 0.0265],
  ['gpt-image-1.5', 'GPT Image 1.5', 0.017],
  ['gpt-image-1', 'GPT Image 1', 0],
  ['gpt-image-1-mini', 'GPT Image 1 Mini', 0.0055],
].map(([apiModel, label, sourceUsd]) => ({
  id: apiModel.replace(/[-.]/g, '_') + '_studio', apiModel, label, sourceUsd,
}));
const SMART_IMAGE_SIZES = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' };
const SMART_IMAGE_REFS = { image: { supported: true, min: 0, max: 1 } };

function defaultSmartImageConfig() {
  return Object.fromEntries(SMART_IMAGE_MODELS.map(m => [m.id, { enabled: true, sourceUsd: m.sourceUsd }]));
}

function normalizeSmartImageConfig(input = defaultSmartImageConfig()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid GPT image pricing.');
  const out = defaultSmartImageConfig();
  for (const [id, value] of Object.entries(input)) {
    if (!Object.hasOwn(out, id) || !value || typeof value !== 'object') throw new Error('Unknown GPT image model.');
    const sourceUsd = Number(value.sourceUsd);
    if (!Number.isFinite(sourceUsd) || sourceUsd < 0 || sourceUsd > 1000) throw new Error('Image source price must be between $0 and $1000.');
    if (typeof value.enabled !== 'boolean') throw new Error('Image model enabled must be true or false.');
    out[id] = { enabled: value.enabled, sourceUsd };
  }
  return out;
}

function smartImageModel(id) { return SMART_IMAGE_MODELS.find(m => m.id === String(id || '')) || null; }

function smartImageQuote(id, ratio, settings) {
  const spec = smartImageModel(id);
  const price = settings.smartAipiModels?.[id];
  if (!spec || !price?.enabled || !(Number(price.sourceUsd) > 0)) {
    throw Object.assign(new Error('This image model is not enabled.'), { statusCode: 400 });
  }
  if (!Object.hasOwn(SMART_IMAGE_SIZES, ratio)) {
    throw Object.assign(new Error('Unsupported image aspect ratio.'), { statusCode: 400 });
  }
  const sourceUsd = Number(price.sourceUsd) * (ratio === '1:1' ? 1 : 1.5);
  const cost = sourceToCustomerCredits(sourceUsd * settings.smartAipiCreditsPerUsd);
  if (!(cost > 0)) throw Object.assign(new Error('This image model needs a valid credit price.'), { statusCode: 400 });
  return { cost, sourceUsd, size: SMART_IMAGE_SIZES[ratio] };
}

function publicSmartImagePricing(settings) {
  if (!settings.smartAipiEnabled || !settings.smartAipiApiKey) return [];
  return SMART_IMAGE_MODELS.flatMap(spec => {
    try {
      const costByAspectRatio = Object.fromEntries(Object.keys(SMART_IMAGE_SIZES).map(r => [r, smartImageQuote(spec.id, r, settings).cost]));
      return [{ id: spec.id, label: spec.label, cost: costByAspectRatio['1:1'], costByAspectRatio,
        aspectRatios: Object.keys(SMART_IMAGE_SIZES), defaultAspectRatio: '1:1', referenceCapabilities: SMART_IMAGE_REFS,
        capabilities: { totalMax: 1, image: { ...SMART_IMAGE_REFS.image, maxBytes: 20 * 1024 * 1024, roles: ['image_references'] } } }];
    } catch { return []; }
  });
}

module.exports = { SMART_IMAGE_MODELS, SMART_IMAGE_SIZES, SMART_IMAGE_REFS, defaultSmartImageConfig,
  normalizeSmartImageConfig, smartImageModel, smartImageQuote, publicSmartImagePricing };

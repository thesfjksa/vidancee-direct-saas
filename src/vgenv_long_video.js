'use strict';

const { getCost, normalizeResolution, validateAspectRatio, h3VgenvModel, h3VgenvTier, isLongH3Duration } = require('./pricing.js');
const { cnyToCredits, usdToCredits } = require('./billing.js');

function sourceCredits(price, unit) {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (unit === 'cny') return cnyToCredits(price);
  if (unit === 'usd') return Math.ceil(usdToCredits(price) - 1e-9);
  return null;
}

async function checkLongVideoCapabilities(client, hasReferences) {
  const capabilities = await client.longVideoCapabilities();
  if (hasReferences && capabilities?.materialsEnabled !== true) {
    throw Object.assign(new Error('Long videos with reference files are currently unavailable. Choose 15 seconds or fewer, or remove the references.'), { statusCode: 400 });
  }
  return capabilities;
}

async function quoteLongH3Video(client, input, { checkCapabilities = true, inputs = [] } = {}) {
  const duration = Number(input.duration);
  const resolution = normalizeResolution(input.model, input.resolution);
  const aspectRatio = String(input.aspectRatio || input.aspect_ratio || '');
  getCost(input.model, duration, resolution);
  validateAspectRatio(aspectRatio);
  if (!isLongH3Duration(duration)) throw Object.assign(new Error('Choose a duration from 16 to 30 seconds.'), { statusCode: 400 });

  const hasReferences = Boolean(inputs.length || input.previewHasReferences || input.images?.length ||
    input.videos?.length || input.audios?.length || input.reuseImageIds?.length || input.reuse_image_ids?.length);
  if (checkCapabilities) await checkLongVideoCapabilities(client, hasReferences);
  const quote = await client.quoteLongVideo({
    model: h3VgenvModel(input.model), tier: h3VgenvTier(input.model), duration, resolution, aspectRatio, inputs,
  });
  const unit = quote.currency === 'CNY' ? 'cny' : quote.currency === 'USD' ? 'usd' : null;
  const cost = sourceCredits(quote.price, unit);
  if (!cost) throw Object.assign(new Error('The video service did not return a usable long-video price.'), { statusCode: 502 });
  return { cost, sourcePrice: quote.price, sourceUnit: unit, resolution, isEstimate: false };
}

function validateLongVideoQuote(quote, job) {
  let approved;
  try { approved = JSON.parse(job.generation_options || '{}')?.longVideoCredits; }
  catch { approved = null; }
  if (!Number.isSafeInteger(approved) || approved <= 0) approved = sourceCredits(Number(job.provider_cost), job.provider_cost_unit);
  if (!approved || quote.cost > approved) {
    throw Object.assign(new Error('The long-video price changed. Credits were refunded.'), { statusCode: 409 });
  }
}

module.exports = { quoteLongH3Video, validateLongVideoQuote, checkLongVideoCapabilities };

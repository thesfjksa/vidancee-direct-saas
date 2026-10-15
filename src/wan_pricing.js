'use strict';

// Wan models are priced at least 30% below Higgsfield. Each Wan quote is
// capped at 70% of what the same clip costs on Higgsfield's app, compared in
// money: Higgsfield credits × the USD price of a credit on its Starter plan
// ($19 for 270 credits, the plan closest to our Creator plan), against the
// price of one of our credits on the Creator plan (Rs 5,000 for 60,000 credits
// at Rs 280 per USD). Quotes already below the cap are unchanged.
const { PKR_PER_USD } = require('./billing.js');
const { PLANS } = require('./plans.js');

const HIGGSFIELD_USD_PER_CREDIT = 19 / 270;
const creator = PLANS.creator;
const CUSTOMER_USD_PER_CREDIT = creator.pricePkr / creator.credits / PKR_PER_USD;
const CHEAPER_THAN_HIGGSFIELD = 0.3;

// Higgsfield credits per second of video (October 2026). Wan 3.0: 8.75 credits
// for 5 s at 720p, 17.5 at 1080p, half of 720p at 480p (its API rates double per
// step). Wan 2.7: 8 credits for 5 s 720p but 15 for 10 s (the lower 1.5/s is
// used), 13 for 5 s 1080p. Wan 3.0 Prime: 30 credits for 5 s 1080p, halving per
// step like its API rates.
const HIGGSFIELD_CREDITS_PER_SECOND = {
  'wan-3.0': { '480p': 0.875, '720p': 1.75, '1080p': 3.5 },
  'wan-3.0-prime': { '480p': 1.5, '720p': 3, '1080p': 6 },
  'wan-2.7': { '720p': 1.5, '1080p': 2.6 },
};
const FAMILY_BY_MODEL = {
  yotta_wan_3_0: 'wan-3.0', argo_wan_3: 'wan-3.0',
  argo_wan_3_prime: 'wan-3.0-prime',
  yotta_wan_2_7: 'wan-2.7',
};

// Highest credit price for this clip, or null when the model is not a Wan model
// or Higgsfield has no price for the resolution.
function wanCreditCap(modelId, resolution, seconds) {
  const rate = HIGGSFIELD_CREDITS_PER_SECOND[FAMILY_BY_MODEL[String(modelId)]]?.[String(resolution)];
  if (!rate || !(Number(seconds) > 0)) return null;
  const higgsfieldUsd = rate * Number(seconds) * HIGGSFIELD_USD_PER_CREDIT;
  return Math.floor(higgsfieldUsd * (1 - CHEAPER_THAN_HIGGSFIELD) / CUSTOMER_USD_PER_CREDIT);
}

// Wan 3.0 and Wan 2.7 are sold without profit: the customer pays what the render (and the
// HD upscale) costs CMM Tools, at the price a credit sells for on the Creator
// plan, rounded up to a whole credit.
const NO_PROFIT_MODELS = ['yotta_wan_3_0', 'argo_wan_3', 'yotta_wan_2_7'];
function noProfitCredits(sourceUsd) {
  return Number(sourceUsd) > 0 ? Math.ceil(Number(sourceUsd) / CUSTOMER_USD_PER_CREDIT - 1e-9) : null;
}

// A video quote with the Wan pricing applied (no profit on Wan 3.0 and Wan 2.7, and never
// more than the Higgsfield cap). The HD enhancement part, refunded if the
// upscale cannot run, shrinks in proportion to the price.
function applyWanCap(modelId, quote) {
  const limits = [wanCreditCap(modelId, quote.resolution, quote.duration),
    NO_PROFIT_MODELS.includes(String(modelId)) ? noProfitCredits(quote.sourceUsd) : null].filter(n => n != null);
  const cap = limits.length ? Math.min(...limits) : null;
  if (cap == null || !(quote.cost > cap)) return quote;
  const ratio = cap / quote.cost;
  const enhance = quote.enhance ? { ...quote.enhance, credits: Math.floor(quote.enhance.credits * ratio) } : quote.enhance;
  return { ...quote, cost: cap, listCost: quote.cost, wanCap: true, enhance };
}

module.exports = { NO_PROFIT_MODELS, noProfitCredits, HIGGSFIELD_USD_PER_CREDIT, CUSTOMER_USD_PER_CREDIT, HIGGSFIELD_CREDITS_PER_SECOND, FAMILY_BY_MODEL, wanCreditCap, applyWanCap };

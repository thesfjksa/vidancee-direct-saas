function positiveNumber(value, fallback = null) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// Every model costs the customer exactly what CMM Tools pays for it, in credits:
// 24 credits per rupee of cost (USD at Rs 280, so 6,720 credits per USD). The
// Rs 5,000 plan gives 60,000 credits = Rs 2,500 of generation; the other half
// is profit, whatever the customer generates.
const PKR_PER_USD = 280;
const CREDITS_PER_RS = 60000 / 2500; // 24, exact
const CREDIT_COST_RS = 1 / CREDITS_PER_RS;
const CREDITS_PER_USD = PKR_PER_USD * CREDITS_PER_RS;
// 888API bills in Chinese yuan (¥1 of balance costs ¥1). Taken at ¥7 per USD,
// slightly above the market rate, so a yuan is never under-charged: ¥1 =
// Rs 40 = 960 credits. Quotes round up to whole credits.
const CNY_PER_USD = 7;
const CREDITS_PER_CNY = CREDITS_PER_USD / CNY_PER_USD;
const cnyToCredits = cny => Math.ceil(Number(cny) * CREDITS_PER_CNY - 1e-9);
const rsToCredits = rs => Number(rs) * CREDITS_PER_RS;
const usdToCredits = usd => Number(usd) * CREDITS_PER_USD;

// Legacy source-credit/image conversion. Vibi voice uses its own at-cost
// conversion below; do not reuse this multiplier for voice generation.
function creditMultiplier() {
  return 2.5;
}

function roundCredits(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Kept for 888API charges saved before yuan were converted (4 decimals).
function roundYuanCredits(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function sourceToCustomerCredits(sourceCredits) {
  const source = Number(sourceCredits);
  if (!Number.isFinite(source) || source <= 0) return null;
  return roundCredits(source * creditMultiplier());
}

// Owner-supplied Vibi purchasing rate, 19 Nov 2026. Use the customer's
// purchase value of CMM credits, not the model cost basis (24/PKR), which
// embeds the plan's 50% margin. No account boost or 5% increase applies.
const VIBI_CREDITS_PER_PKR=69.637;
const VOICE_RETAIL_CREDITS_PER_PKR=60000/5000;
function voiceCreditsPerPkr(user){
  const plan=require('./plans').getPlan(user?.plan_code);
  const ratio=Number(plan?.credits)/Number(plan?.pricePkr);
  return Number.isFinite(ratio)&&ratio>0?ratio:VOICE_RETAIL_CREDITS_PER_PKR;
}
function vibiToCustomerCredits(sourceCredits,creditsPerPkr=VOICE_RETAIL_CREDITS_PER_PKR){
  const source=Number(sourceCredits),basis=Number(creditsPerPkr);
  if(!Number.isFinite(source)||source<0||!Number.isFinite(basis)||basis<=0)return null;
  // Round down to wallet precision: rounding must not add a markup.
  return Math.floor((source/VIBI_CREDITS_PER_PKR*basis+1e-12)*10000)/10000;
}

// Boosted pricing, turned on per customer by the admin: every price is shown
// and charged x 60000/42000, so a 60,000-credit plan buys what 42,000 credits
// buy at the normal rate. 1 is the normal rate.
const BOOSTED_PRICE_RATE = 60000 / 42000;
// Every customer price is 5% above cost (owner's request, 28 Oct 2026), on
// top of boosted pricing where that is on.
const PRICE_INCREASE = 1.05;
// The admin-set rate alone (1 = normal, BOOSTED_PRICE_RATE = boosted).
function customerRate(user) {
  const rate = Number(user?.price_rate);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}
function priceRate(user) {
  return customerRate(user) * PRICE_INCREASE;
}
function applyPriceRate(cost, rate) {
  const value = Number(cost), r = Number(rate);
  if (!Number.isFinite(value) || !Number.isFinite(r) || r <= 0 || r === 1) return cost;
  return roundCredits(value * r);
}
// Copies a model catalog with every credit price scaled by rate; the original
// is left as is (some entries share one price object between two keys).
const PRICE_KEYS = new Set(['cost', 'costByQuality', 'costByAspectRatio', 'costTable', 'billingRateCredits', 'referenceSurcharge', 'resolutionCosts', 'listCost']);
function scalePrices(value, rate, inPrice = false) {
  if (!Number.isFinite(Number(rate)) || Number(rate) <= 0 || Number(rate) === 1) return value;
  if (Array.isArray(value)) return value.map(v => scalePrices(v, rate, inPrice));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scalePrices(v, rate, inPrice || PRICE_KEYS.has(k))]));
  }
  return inPrice && typeof value === 'number' ? applyPriceRate(value, rate) : value;
}

module.exports = { BOOSTED_PRICE_RATE, PRICE_INCREASE, customerRate, priceRate, applyPriceRate, scalePrices, positiveNumber, creditMultiplier, roundCredits, roundYuanCredits, sourceToCustomerCredits, VIBI_CREDITS_PER_PKR, VOICE_RETAIL_CREDITS_PER_PKR,voiceCreditsPerPkr,vibiToCustomerCredits,PKR_PER_USD, CREDITS_PER_RS, CREDIT_COST_RS, CREDITS_PER_USD, CNY_PER_USD, CREDITS_PER_CNY, cnyToCredits, rsToCredits, usdToCredits };


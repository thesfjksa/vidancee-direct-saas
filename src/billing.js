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

// Voice (Vibi) only: its per-character source units x 2.5.
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

module.exports = { positiveNumber, creditMultiplier, roundCredits, roundYuanCredits, sourceToCustomerCredits, PKR_PER_USD, CREDITS_PER_RS, CREDIT_COST_RS, CREDITS_PER_USD, CNY_PER_USD, CREDITS_PER_CNY, cnyToCredits, rsToCredits, usdToCredits };

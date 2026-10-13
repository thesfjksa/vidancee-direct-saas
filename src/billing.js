function positiveNumber(value, fallback = null) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// One CMM Tools credit = Rs 1 of what CMM Tools pays its providers. Plans sell
// credits at twice that (Rs 5,000 buys 2,500 credits), so every plan keeps 50%
// whatever the customer generates. USD costs convert at Rs 280.
const PKR_PER_USD = 280;
const CREDIT_COST_RS = 1;
const CREDITS_PER_USD = PKR_PER_USD / CREDIT_COST_RS;
const rsToCredits = rs => Number(rs) / CREDIT_COST_RS;
const usdToCredits = usd => Number(usd) * CREDITS_PER_USD;

// Voice (Vibi) only: its per-character source units x 2.5.
function creditMultiplier() {
  return 2.5;
}

function roundCredits(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function sourceToCustomerCredits(sourceCredits) {
  const source = Number(sourceCredits);
  if (!Number.isFinite(source) || source <= 0) return null;
  return roundCredits(source * creditMultiplier());
}

module.exports = { positiveNumber, creditMultiplier, roundCredits, sourceToCustomerCredits, PKR_PER_USD, CREDIT_COST_RS, CREDITS_PER_USD, rsToCredits, usdToCredits };

function positiveNumber(value, fallback = null) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function creditMultiplier() {
  return positiveNumber(process.env.CUSTOMER_CREDIT_MULTIPLIER, 2.5);
}

function roundCredits(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function sourceToCustomerCredits(sourceCredits) {
  const source = Number(sourceCredits);
  if (!Number.isFinite(source) || source <= 0) return null;
  return roundCredits(source * creditMultiplier());
}

module.exports = { positiveNumber, creditMultiplier, roundCredits, sourceToCustomerCredits };

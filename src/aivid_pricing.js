'use strict';
// Owner-confirmed AIVID credit purchase cost: USD 0.12 per source credit.
// Convert through the SAME USD->wallet rate used by ArgoLink, Vercel, and
// other USD-denominated models. Customer-level 5% / boosted rate is applied
// elsewhere (customerQuote and createGenerationForUser), not here.
const {usdToCredits,roundCredits}=require('./billing.js');
const AIVID_USD_PER_CREDIT=0.12;
const AIVID_CUSTOMER_CREDITS_PER_SOURCE_CREDIT=roundCredits(usdToCredits(AIVID_USD_PER_CREDIT));
function aividSourceUsd(sourceCredits){
  const units=Number(sourceCredits);
  if(!Number.isFinite(units)||units<=0)return null;
  return roundCredits(units*AIVID_USD_PER_CREDIT);
}
function aividBaseCredits(sourceCredits){
  const units=Number(sourceCredits);
  if(!Number.isFinite(units)||units<=0)return null;
  return roundCredits(usdToCredits(units*AIVID_USD_PER_CREDIT));
}
module.exports={AIVID_USD_PER_CREDIT,AIVID_CUSTOMER_CREDITS_PER_SOURCE_CREDIT,aividSourceUsd,aividBaseCredits};

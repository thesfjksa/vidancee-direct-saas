'use strict';

// The /compare page: what the same clip costs on CMM Tools and on other AI
// video platforms. Other platforms' prices are their list prices, read from
// their own pages on CHECKED (monthly billing, cheapest plan with the model,
// before tax); USD is converted at PKR_PER_USD. CMM Tools prices are quoted
// live at the Creator plan's credit price, and a comparison is shown only
// while CMM Tools is cheaper. Update the numbers here when a platform
// changes its prices.
const { PKR_PER_USD } = require('./billing.js');
const { PLANS } = require('./plans.js');

const CHECKED = '2026-10-15';

const PLATFORMS = {
  pika: { name: 'Pika', plan: 'Starter', usd: 10, credits: 900, url: 'https://pika.art/pricing' },
  runway: { name: 'Runway', plan: 'Standard', usd: 15, credits: 625, url: 'https://runway.com/pricing' },
  luma: { name: 'Luma Dream Machine', plan: 'Plus', usd: 30, credits: 10000, url: 'https://lumalabs.ai/pricing' },
  freepik: { name: 'Freepik', plan: 'Premium', usd: 20, credits: 20000, url: 'https://www.freepik.com/pricing' },
  invideo: { name: 'Invideo AI', plan: 'Plus', usd: 60, credits: 2000, url: 'https://invideo.io/pricing' },
  higgsfield: { name: 'Higgsfield', plan: 'Starter', usd: 15, credits: 200, url: 'https://higgsfield.ai/pricing' },
};

// One row per clip; each offer is the same clip on another platform, in its
// credits (its own name for the model when it differs).
const COMPARISONS = [
  { model: 'hf_wan_3_0', name: 'Wan 3.0', seconds: 5, resolution: '720p', audio: true,
    offers: [{ platform: 'pika', credits: 33 }, { platform: 'higgsfield', credits: 8.75 }] },
  { model: 'hf_wan_3_0', name: 'Wan 3.0', seconds: 2, resolution: '1080p', audio: true,
    offers: [{ platform: 'freepik', credits: 400, note: 'at its 50% off price' }] },
  { model: 'argo_seedance_2_5', name: 'Seedance 2.5', seconds: 5, resolution: '720p', audio: true,
    offers: [{ platform: 'pika', credits: 122 }, { platform: 'invideo', credits: 56 }] },
  { model: 'argo_seedance_2_5', name: 'Seedance 2.5', seconds: 4, resolution: '720p', audio: true,
    offers: [{ platform: 'freepik', credits: 1760 }] },
  { model: 'argo_seedance_2_0', name: 'Seedance 2.0', seconds: 5, resolution: '720p', audio: true,
    offers: [{ platform: 'luma', credits: 255 }] },
  { model: 'argo_seedance_2_0', name: 'Seedance 2.0', seconds: 4, resolution: '1080p', audio: true,
    offers: [{ platform: 'runway', credits: 160, model: 'Seedance 2.0 Pro' }] },
  { model: 'minimax_h3', name: 'MiniMax H3', seconds: 5, resolution: '768p', audio: false,
    offers: [{ platform: 'freepik', credits: 200, model: 'MiniMax H3 Max Turbo' }] },
];

const creator = PLANS.creator;
const RS_PER_CREDIT = creator.pricePkr / creator.credits;
const rs = value => Math.round(value * 100) / 100;

// quote(comparison) → CMM Tools credits for that clip, or null when the model
// is unavailable (its rows are then left out).
async function comparePrices(quote) {
  const rows = [];
  for (const c of COMPARISONS) {
    let credits = null;
    try { credits = await quote(c); } catch {}
    if (!(credits > 0)) continue;
    const ours = rs(credits * RS_PER_CREDIT);
    const offers = c.offers.map(o => {
      const p = PLATFORMS[o.platform];
      const theirs = rs(o.credits * p.usd / p.credits * PKR_PER_USD);
      return { platform: p.name, plan: p.plan, model: o.model || c.name, note: o.note || '', credits: o.credits, rs: theirs, usd: rs(theirs / PKR_PER_USD), url: p.url,
        saving: Math.round((1 - ours / theirs) * 100) };
    }).filter(o => o.rs > ours);
    if (offers.length) rows.push({ model: c.name, seconds: c.seconds, resolution: c.resolution, audio: c.audio, credits, rs: ours, offers });
  }
  const used = new Set(rows.flatMap(r => r.offers.map(o => o.platform)));
  const plans = Object.values(PLATFORMS).filter(p => used.has(p.name))
    .map(p => ({ name: p.name, plan: p.plan, usd: p.usd, rs: Math.round(p.usd * PKR_PER_USD), credits: p.credits, url: p.url }));
  return { checked: CHECKED, pkrPerUsd: PKR_PER_USD, ours: { plan: creator.name, rs: creator.pricePkr, credits: creator.credits }, rows, plans };
}

module.exports = { CHECKED, PLATFORMS, COMPARISONS, comparePrices };

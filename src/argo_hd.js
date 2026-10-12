'use strict';

// Video Studio offers ArgoLink models at 720p and 1080p only. With fal.ai
// configured, both are delivered as 1080p files (HD enhancement): 720p is
// rendered at 480p and 1080p at 720p (MiniMax H3: 768p for both), then fal
// upscales to 1080p with its default settings. Without fal, a resolution is
// offered only if the model renders it natively.
const { quoteGateway } = require('./vercel_models.js');
const { planUpscale, upscaleCredits, dimensionsFor, SHORT_SIDE } = require('./enhance.js');

const DISPLAY_RESOLUTIONS = ['720p', '1080p'];
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

function falReady(settings) { return Boolean(settings?.falEnabled && settings?.falApiKey); }

// {source, upscale} for one display resolution, or null when not offered.
function hdPlan(nativeResolutions, display, withFal) {
  const native = [...nativeResolutions].filter(r => SHORT_SIDE[r]).sort((a, b) => SHORT_SIDE[a] - SHORT_SIDE[b]);
  const has = r => native.includes(r);
  const nearHd = native.find(r => SHORT_SIDE[r] >= 720 && SHORT_SIDE[r] < 1080);
  if (display === '720p') {
    if (withFal) {
      const source = has('480p') ? '480p' : nearHd;
      if (source) return { source, upscale: true, target: '1080p' };
    }
    return nearHd ? { source: nearHd, upscale: false } : null;
  }
  if (display === '1080p') {
    if (withFal) {
      const source = has('720p') ? '720p' : native.find(r => SHORT_SIDE[r] > 720 && SHORT_SIDE[r] < 1080);
      if (source) return { source, upscale: true, target: '1080p' };
    }
    return has('1080p') ? { source: '1080p', upscale: false } : null;
  }
  return null;
}

// The model as Video Studio shows it: resolutions 720p/1080p only.
function argoVideoView(model, withFal) {
  if (model?.mediaType !== 'video') return model;
  const plans = Object.fromEntries(DISPLAY_RESOLUTIONS.map(d => [d, hdPlan(model.resolutions || [], d, withFal)]).filter(([, p]) => p));
  const resolutions = Object.keys(plans);
  return { ...model, nativeResolutions: model.resolutions, resolutions, hdPlans: plans,
    defaultResolution: resolutions.includes('720p') ? '720p' : resolutions[0] || null };
}

// Price of an ArgoLink video in Video Studio: ArgoLink's render at the source
// resolution, plus fal's upscale when one is needed.
function quoteArgoVideo(model, body, settings) {
  const withFal = falReady(settings);
  const view = argoVideoView(model, withFal);
  const display = String(body.resolution || view.defaultResolution || '');
  const plan = view.hdPlans[display];
  if (!plan) fail('Unsupported resolution for this model.');
  const render = quoteGateway(model, { ...body, resolution: plan.source }, settings.argoLinkCustomerCreditsPerUsd);
  let enhance = null, extraUsd = 0, extraCredits = 0;
  if (plan.upscale) {
    const ratio = render.aspectRatio === 'adaptive' ? '16:9' : render.aspectRatio;
    // fal's defaults (general preset, high fidelity, its own frame rate).
    const upscale = planUpscale({ ...dimensionsFor(plan.source, ratio), seconds: render.duration }, plan.target, { preset: 'general' });
    if (upscale) {
      extraUsd = upscale.usd;
      extraCredits = upscaleCredits(upscale, settings.falCustomerCreditsPerUsd);
      enhance = { sourceResolution: plan.source, upscale, credits: extraCredits };
    }
  }
  return { ...render, resolution: display, sourceResolution: plan.source, renderUsd: render.sourceUsd,
    sourceUsd: render.sourceUsd + extraUsd, cost: render.cost + extraCredits, enhance };
}

module.exports = { DISPLAY_RESOLUTIONS, falReady, hdPlan, argoVideoView, quoteArgoVideo };

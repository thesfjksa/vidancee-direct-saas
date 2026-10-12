'use strict';

// Video Studio offers ArgoLink models at 720p and 1080p only. 720p is always
// rendered natively: upscaling a 480p render damaged small text and textures
// (tested 12 October 2026). With fal.ai configured, 1080p is rendered at 720p
// (or MiniMax H3's 768p) and upscaled by fal (HD enhancement). Without fal,
// 1080p is offered only if the model renders it natively.
const { quoteGateway } = require('./vercel_models.js');
const { planUpscale, upscaleCredits, dimensionsFor, SHORT_SIDE } = require('./enhance.js');

const DISPLAY_RESOLUTIONS = ['720p', '1080p'];
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

function falReady(settings) { return Boolean(settings?.falEnabled && settings?.falApiKey); }

// {source, upscale} for one display resolution, or null when not offered.
function hdPlan(nativeResolutions, display, withFal) {
  const native = [...nativeResolutions].filter(r => SHORT_SIDE[r]).sort((a, b) => SHORT_SIDE[a] - SHORT_SIDE[b]);
  const has = r => native.includes(r);
  if (display === '720p') {
    const near = native.find(r => SHORT_SIDE[r] >= 720 && SHORT_SIDE[r] < 1080);
    return near ? { source: near, upscale: false } : null;
  }
  if (display === '1080p') {
    if (withFal) {
      const source = has('720p') ? '720p' : native.find(r => SHORT_SIDE[r] > 720 && SHORT_SIDE[r] < 1080);
      if (source) return { source, upscale: true };
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
    const upscale = planUpscale({ ...dimensionsFor(plan.source, ratio), seconds: render.duration }, display, { preset: 'general', fps: 24 });
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

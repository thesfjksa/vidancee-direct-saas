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

// The model as Video Studio shows it: resolutions 720p/1080p only. With HD
// enhancement turned off for the model (hd: false), its own resolutions are
// offered and rendered as they are, never upscaled.
function argoVideoView(model, withFal, { hd = true } = {}) {
  if (model?.mediaType !== 'video') return model;
  const plans = hd
    ? Object.fromEntries(DISPLAY_RESOLUTIONS.map(d => [d, hdPlan(model.resolutions || [], d, withFal)]).filter(([, p]) => p))
    : Object.fromEntries([...(model.resolutions || [])].filter(r => SHORT_SIDE[r]).sort((a, b) => SHORT_SIDE[a] - SHORT_SIDE[b]).map(r => [r, { source: r, upscale: false }]));
  const resolutions = Object.keys(plans);
  return { ...model, nativeResolutions: model.resolutions, resolutions, hdPlans: plans,
    defaultResolution: resolutions.includes('720p') ? '720p' : resolutions[0] || null };
}

// Wan models in Video Studio (Higgsfield): 480p is rendered natively; with
// fal, 720p is rendered at 480p and 1080p at 720p, both upscaled to 1080p (HD
// enhancement), which costs less than the source's own 720p/1080p. A model with
// no 480p render offers 720p natively. Without fal, every resolution the model
// renders is offered as it is.
const WAN_RESOLUTIONS = ['480p', '720p', '1080p'];
function wanPlan(nativeResolutions, display, withFal) {
  const has = r => nativeResolutions.includes(r);
  if (display === '480p') return has('480p') ? { source: '480p', upscale: false } : null;
  if (display === '720p') {
    if (withFal && has('480p')) return { source: '480p', upscale: true, target: '1080p' };
    return has('720p') ? { source: '720p', upscale: false } : null;
  }
  if (display === '1080p') {
    if (withFal && has('720p')) return { source: '720p', upscale: true, target: '1080p' };
    return has('1080p') ? { source: '1080p', upscale: false } : null;
  }
  return null;
}

function wanVideoView(model, withFal, { hd = true } = {}) {
  if (model?.mediaType !== 'video') return model;
  const native = model.resolutions || [];
  const plans = Object.fromEntries(WAN_RESOLUTIONS.map(d => [d, hd ? wanPlan(native, d, withFal) : (native.includes(d) ? { source: d, upscale: false } : null)]).filter(([, p]) => p));
  const resolutions = Object.keys(plans);
  return { ...model, nativeResolutions: native, resolutions, hdPlans: plans,
    defaultResolution: resolutions.includes('720p') ? '720p' : resolutions[0] || null };
}

// Price of an ArgoLink (or Higgsfield) video in Video Studio: the source's render at
// the source resolution, plus fal's upscale when one is needed.
function quoteArgoVideo(model, body, settings, { hd = true, view: viewFor = argoVideoView, creditsPerUsd = settings.argoLinkCustomerCreditsPerUsd } = {}) {
  const withFal = falReady(settings);
  const view = viewFor(model, withFal, { hd });
  const display = String(body.resolution || view.defaultResolution || '');
  const plan = view.hdPlans[display];
  if (!plan) fail('Unsupported resolution for this model.');
  const render = quoteGateway(model, { ...body, resolution: plan.source }, creditsPerUsd);
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

module.exports = { DISPLAY_RESOLUTIONS, WAN_RESOLUTIONS, falReady, hdPlan, argoVideoView, wanPlan, wanVideoView, quoteArgoVideo };

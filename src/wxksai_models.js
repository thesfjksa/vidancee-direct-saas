'use strict';

// Account visibility is confirmed with GET /v1/models before an Admin import.
// Prices are the published 8 November 2026 CNY snapshot, NOT live quotes.
// All new models remain disabled until Admin explicitly reviews and enables them.
const { CNY_PER_USD } = require('./billing.js');
const ORIGIN = 'https://api.wxksai.com';
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const everySecond = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const SPECS = Object.freeze({
  'seedance-2.5-special2': {
    name: 'Seedance 2.5 Special2 · WXKSAI', resolution: '1080p',
    durations: everySecond(5, 30), defaultDuration: 30, priceCny: 2.49, pricingMode: 'clip',
    ratios: [...RATIOS, '21:9'], promptMax: 10000,
  },
  'seedance-2.5-full-720p-9img': {
    name: 'Seedance 2.5 Full 720p · WXKSAI', resolution: '720p',
    durations: [5, 10, 15], defaultDuration: 15, priceCny: 2.52, pricingMode: 'clip',
    ratios: ['16:9', '9:16'],
  },
  'seedance-2.5-full-720p-15-30s': {
    name: 'Seedance 2.5 Full 15–30s · WXKSAI', resolution: '720p',
    durations: [15, 30], defaultDuration: 15, priceCny: 4.9, pricingMode: 'clip',
    ratios: RATIOS,
  },
  'seedance-2.5-bd-2': {
    name: 'Seedance 2.5 BD2 Full · WXKSAI', resolution: '720p',
    durations: everySecond(4, 30), defaultDuration: 15, priceCny: 4.9, pricingMode: 'clip',
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    promptMax: 45000,
  },
  'wan3.0-video': {
    name: 'Wan 3.0 Standard · WXKSAI', resolution: '720p',
    resolutions: ['720p', '1080p'],
    durations: everySecond(5, 30), defaultDuration: 5,
    priceCny: 0.247, pricingMode: 'second', ratios: RATIOS,
  },
  'seedance-2.0-full-720p-900': {
    name: 'Seedance 2.0 Full 720p (900) · WXKSAI', resolution: '720p',
    durations: [10], defaultDuration: 10,
    priceCny: 2.1, pricingMode: 'clip', ratios: RATIOS,
  },
  'seedance2.5-buff': {
    name: 'Seedance 2.5 Buff 720p · WXKSAI', resolution: '720p',
    durations: everySecond(4, 30), defaultDuration: 10, priceCny: 0.78, pricingMode: 'second',
    ratios: RATIOS,
  },
});

// Caps follow the published V1 model contracts, not the common endpoint's
// theoretical capabilities. The Buff video/audio count is intentionally 1
// until the provider publishes a numerical maximum for those two media types.
const REFERENCE_SPECS = Object.freeze({
  'seedance-2.5-special2': { images: 9, videos: 0, audios: 3 },
  'seedance-2.5-full-720p-9img': { images: 9, videos: 0, audios: 0 },
  'seedance-2.5-full-720p-15-30s': { images: 9, videos: 0, audios: 0 },
  'seedance-2.5-bd-2': { images: 30, videos: 10, audios: 10, total: 30, totalSeconds: 30 },
  'wan3.0-video': { images: 10, videos: 5, audios: 5 },
  'seedance-2.0-full-720p-900': { images: 9, videos: 0, audios: 0 },
  'seedance2.5-buff': { images: 30, videos: 1, audios: 1 },
});
const MIB = 1024 * 1024;
function wxksaiReferenceCapabilities(id) {
  const ref = REFERENCE_SPECS[id];
  if (!ref) return { textOnly: true, totalMax: 0, image: { supported: false, max: 0 }, video: { supported: false, max: 0 }, audio: { supported: false, max: 0 } };
  const kind = (max, roles, maxBytes, formats) => ({
    supported: max > 0, max, min: 0, roles: max > 0 ? roles : [],
    maxBytes, formats,
  });
  return {
    textOnly: true,
    totalMax: ref.total || ref.images + ref.videos + ref.audios,
    image: kind(ref.images, ['image_references'], 20 * MIB, ['jpg', 'jpeg', 'png', 'webp']),
    video: kind(ref.videos, ['video_references'], 25 * MIB, ['mp4']),
    audio: kind(ref.audios, ['audio_references'], 15 * MIB, ['mp3', 'wav']),
  };
}

const publicId = id => 'wxksai_' + id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/,'');
const isWxksaiModel = id => typeof id === 'string' && Object.keys(SPECS).some(key => publicId(key) === id);

function wxksaiMediaModels(live) {
  if (!Array.isArray(live?.data)) throw new Error('WXKSAI did not return an account-scoped model list.');
  const allowed = new Set(live.data.filter(x=>typeof x?.id==='string').map(x=>x.id));
  return Object.entries(SPECS).filter(([id]) => allowed.has(id)).map(([id, spec]) => {
    const priceUsd = spec.priceCny / CNY_PER_USD;
    const pricing = spec.pricingMode === 'clip'
      ? { video_duration_prices: spec.durations.map(duration => ({ duration, cost: priceUsd })) }
      : { video_duration_pricing: (spec.resolutions || [spec.resolution]).map(resolution => ({ resolution, cost_per_second: priceUsd })) };
    const referenceCapabilities = wxksaiReferenceCapabilities(id);
    return {
      providerModelId: id, publicModelId: publicId(id), label: spec.name, mediaType: 'video',
      options: {
        catalogVerified: true, adapterSupported: true, gatewayType: 'video',
        pricing, wxksai: { priceCny: spec.priceCny, pricingMode: spec.pricingMode, priceCheckedAt: '2026-11-08' },
        durations: spec.durations, resolutions: spec.resolutions || [spec.resolution],
        aspectRatios: spec.ratios, defaultDuration: spec.defaultDuration,
        defaultResolution: spec.resolution, defaultAspectRatio: '16:9',
        inputLimits: { text: { max_chars: Math.min(20000,spec.promptMax||10000) } },
        supportedOperations: ['text-to-video', 'reference-to-video'],
        referenceCapabilities,
        mediaRoles: [
          ...referenceCapabilities.image.roles,
          ...referenceCapabilities.video.roles,
          ...referenceCapabilities.audio.roles,
        ],
      },
    };
  });
}

module.exports = { ORIGIN, SPECS, REFERENCE_SPECS, wxksaiReferenceCapabilities, publicId, isWxksaiModel, wxksaiMediaModels };

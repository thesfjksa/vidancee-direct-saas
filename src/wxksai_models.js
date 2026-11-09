'use strict';

// Account visibility is confirmed with GET /v1/models before an Admin import.
// Prices are the published 8 November 2026 CNY snapshot, NOT live quotes.
// All new models remain disabled until Admin explicitly reviews and enables them.
const { CNY_PER_USD } = require('./billing.js');
const ORIGIN = 'https://api.wxksai.com';
// User-provided candidate model ID (from a chat-completions curl example).
// Do not offer as video until its /v1/videos contract, capabilities and
// separate pricing are documented and confirmed. Checking GET /v1/models
// is read-only and cannot start a billed generation.
const UNVERIFIED_DOPE_VIDEO_CANDIDATE = 'sd 2.5掺水板';
function unverifiedDopeCandidateVisible(live) {
  if (!Array.isArray(live?.data)) throw new Error('Dope did not return an account-scoped model list.');
  return live.data.some(item => item?.id === UNVERIFIED_DOPE_VIDEO_CANDIDATE);
}
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const everySecond = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const SPECS = Object.freeze({
  [UNVERIFIED_DOPE_VIDEO_CANDIDATE]: {
    // Marketplace screenshot, 9 Nov 2026: 2–30 seconds, 480/720/1080p
    // for one video price, text-to-video, multiple reference images and
    // first/last frames. The published V1 video table does not yet list
    // this exact ID; it MUST remain Admin opt-in pending live verification.
    name: 'Seedance 2.5 Value · Dope',
    resolution: '720p', resolutions: ['480p','720p','1080p'],
    durations: everySecond(2,30), defaultDuration: 5,
    priceCny: 2.20, pricingMode: 'clip',
    priceReviewRequired: true, videoApiVerified: false,
    // The screenshot omits supported ratios; use a conservative starter.
    ratios: ['16:9','9:16'],
  },
  'seedance-2.5-special2': {
    name: 'Seedance 2.5 Special2 · Dope', resolution: '1080p',
    durations: everySecond(5, 30), defaultDuration: 30, priceCny: 2.49, pricingMode: 'clip',
    ratios: [...RATIOS, '21:9'], promptMax: 10000,
  },
  'seedance-2.5-full-720p-9img': {
    name: 'Seedance 2.5 Full 720p · Dope', resolution: '720p',
    durations: [5, 10, 15], defaultDuration: 15, priceCny: 2.52, pricingMode: 'clip',
    ratios: ['16:9', '9:16'],
  },
  'seedance-2.5-full-720p-15-30s': {
    name: 'Seedance 2.5 Full 15–30s · Dope', resolution: '720p',
    durations: [15, 30], defaultDuration: 15, priceCny: 4.9, pricingMode: 'clip',
    ratios: RATIOS,
  },
  'seedance-2.5-bd-2': {
    name: 'Seedance 2.5 BD2 Full · Dope', resolution: '720p',
    durations: everySecond(4, 30), defaultDuration: 15, priceCny: 4.9, pricingMode: 'clip',
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    promptMax: 45000,
  },
  'wan3.0-video': {
    name: 'Wan 3.0 Standard · Dope', resolution: '720p',
    resolutions: ['720p', '1080p'],
    durations: everySecond(5, 30), defaultDuration: 5,
    priceCny: 0.247, pricingMode: 'second', ratios: RATIOS,
  },
  'seedance-2.0-full-720p-900': {
    name: 'Seedance 2.0 Full 720p (900) · Dope', resolution: '720p',
    durations: [10], defaultDuration: 10,
    priceCny: 2.1, pricingMode: 'clip', ratios: RATIOS,
  },
  'seedance2.5-buff': {
    name: 'Seedance 2.5 Buff 720p · Dope', resolution: '720p',
    durations: everySecond(4, 30), defaultDuration: 10, priceCny: 0.78, pricingMode: 'second',
    ratios: RATIOS,
  },
});

// Caps follow the published V1 model contracts, not the common endpoint's
// theoretical capabilities. The Buff video/audio count is intentionally 1
// until the provider publishes a numerical maximum for those two media types.
const REFERENCE_SPECS = Object.freeze({
  // Screenshot confirms multiple images and first/last frame input, but
  // does not show the provider's actual maximum. Start with only 2 images,
  // keep video/audio unsupported, and validate upstream before expanding.
  [UNVERIFIED_DOPE_VIDEO_CANDIDATE]: { images: 2, videos: 0, audios: 0 },
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

const publicId = id => id === UNVERIFIED_DOPE_VIDEO_CANDIDATE
  ? 'wxksai_sd25_value' // Stable ASCII customer-facing alias, never leak vendor.
  : 'wxksai_' + id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/,'');
const isWxksaiModel = id => typeof id === 'string' && Object.keys(SPECS).some(key => {
  const legacy = publicId(key);
  return legacy === id || require('./dope_brand.js').customerModelId(legacy) === id;
});

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
        pricing, wxksai: {
          priceCny: spec.priceCny, pricingMode: spec.pricingMode,
          priceCheckedAt: id===UNVERIFIED_DOPE_VIDEO_CANDIDATE?'2026-11-09':'2026-11-08',
          ...(spec.priceReviewRequired ? {
            priceReviewRequired: true, videoApiVerified: false,
            sourcePriceCny: spec.priceCny, screenshotTaskPriceCny: 1.90,
          } : {}),
        },
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

module.exports = { ORIGIN, SPECS, REFERENCE_SPECS, UNVERIFIED_DOPE_VIDEO_CANDIDATE, unverifiedDopeCandidateVisible, wxksaiReferenceCapabilities, publicId, isWxksaiModel, wxksaiMediaModels };

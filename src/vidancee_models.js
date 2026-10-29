'use strict';

// Owner-confirmed Vidancee Omni Flash source credits for BOTH text-to-video
// and image-to-video (29 Oct 2026). Source credits are not USD.
// Supported 9:16 images[] multipart is confirmed by successful job 26443.
const MODEL_ID = 'Omni-Flash';
const DURATION_CREDITS = Object.freeze({4: 30, 6: 40, 8: 50, 10: 60});
const DURATIONS = Object.freeze([4, 6, 8, 10]);
// Vidancee sells its credits at a fixed 900 per USD (vidancee.com pricing,
// 29 Oct 2026), so a 10 s clip costs $0.0667. Sold at cost like every model.
const VIDANCEE_CREDITS_PER_USD = 900;

function isVidanceeModel(id) { return id === 'vd_omni_flash'; }

function vidanceeCreditsForDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isInteger(n) || !Object.hasOwn(DURATION_CREDITS, n))
    throw new Error('Unsupported Omni Flash duration. Choose 4, 6, 8 or 10 seconds.');
  return DURATION_CREDITS[n];
}

function vidanceeReferenceCapabilities() {
  return {
    textOnly: true,
    totalMax: 1,
    image: {supported: true, max: 1, min: 0, roles: ['image_references'],
      requiredRoles: [], maxBytes: 10 * 1024 * 1024, formats: ['jpeg', 'png', 'webp']},
    video: {supported: false, max: 0, min: 0, roles: [], requiredRoles: []},
    audio: {supported: false, max: 0, min: 0, roles: [], requiredRoles: []},
  };
}

function vidanceeMediaModels() {
  const referenceCapabilities = vidanceeReferenceCapabilities();
  return [{
    providerModelId: MODEL_ID, publicModelId: 'vd_omni_flash',
    mediaType: 'video', label: 'Omni Flash · 4–10 s',
    options: {
      catalogVerified: true, adapterSupported: true, setupReason: '', gatewayType: 'video',
      // USD cost of each clip length at Vidancee's credit price.
      pricing: {video_duration_prices: DURATIONS.map(duration => ({
        duration, cost: DURATION_CREDITS[duration] / VIDANCEE_CREDITS_PER_USD,
      }))},
      supportedOperations: ['text-to-video', 'image-to-video', 'reference-to-video'],
      durations: [...DURATIONS], resolutions: ['720p'], aspectRatios: ['9:16'],
      defaultAspectRatio: '9:16', defaultDuration: 4, defaultResolution: '720p',
      fps: 24, modes: [], supportsAudio: false,
      mediaRoles: referenceCapabilities.image.roles, referenceCapabilities,
      vidancee: {model: MODEL_ID, providerCreditsByDuration: {...DURATION_CREDITS}},
    },
  }];
}

module.exports = {
  MODEL_ID, DURATIONS, DURATION_CREDITS, VIDANCEE_CREDITS_PER_USD,
  isVidanceeModel, vidanceeCreditsForDuration,
  vidanceeMediaModels, vidanceeReferenceCapabilities,
};

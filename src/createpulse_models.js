'use strict';

// CreatePulse (createpulse.online/docs) Omni Flash in Video Studio. The API
// has no model catalogue; prices come from its docs (28 October 2026). The
// API is billed at twice the website price and its price is flat per
// generation, set by the duration only (4, 6, 8 or 10 s; 9:16 or 16:9).
// Sold at cost like every model (CREDITS_PER_USD), so the plan price carries
// the margin. Output resolution is not stated; Omni Flash renders 720p.
const API_ORIGIN = 'https://createpulse.online';
const IMAGE_BYTES = 10 * 1024 * 1024;
const MODELS = [
  { id: 'veo-omni-flash', publicModelId: 'cp_omni_flash', name: 'Omni Flash',
    prices: { 4: 0.05, 6: 0.072, 8: 0.086, 10: 0.1072 }, aspectRatios: ['16:9', '9:16'], maxReferences: 4 },
];

function isCreatePulseModel(id) { return String(id || '').startsWith('cp_'); }

// Start frame (init_image_url), end frame (end_frame_url) and reference images
// (image_reference_urls), at most 4 images in all.
function createPulseReferenceCapabilities(max) {
  const roles = ['start_image', 'end_image', 'image_references'];
  return {
    textOnly: true, totalMax: max,
    image: { supported: true, max, min: 0, roles, requiredRoles: [], maxBytes: IMAGE_BYTES, formats: ['jpeg', 'png', 'webp'] },
    video: { supported: false, max: 0, min: 0, roles: [], requiredRoles: [] },
    audio: { supported: false, max: 0, min: 0, roles: [], requiredRoles: [] },
  };
}

function createPulseMediaModels() {
  return MODELS.map(m => {
    const durations = Object.keys(m.prices).map(Number).sort((a, b) => a - b);
    const referenceCapabilities = createPulseReferenceCapabilities(m.maxReferences);
    return {
      providerModelId: m.id, publicModelId: m.publicModelId, mediaType: 'video',
      label: m.name + ' · ' + durations[0] + '–' + durations.at(-1) + ' s',
      options: {
        catalogVerified: true, adapterSupported: true, setupReason: '',
        gatewayType: 'video',
        pricing: { video_duration_prices: durations.map(duration => ({ duration, cost: m.prices[duration] })) },
        supportedOperations: ['text-to-video', 'image-to-video', 'first-last-frame', 'reference-to-video'],
        durations, resolutions: ['720p'], aspectRatios: m.aspectRatios,
        defaultAspectRatio: '9:16', defaultDuration: durations.at(-1), defaultResolution: '720p',
        fps: 24, modes: [], supportsAudio: false,
        mediaRoles: referenceCapabilities.image.roles, referenceCapabilities,
        createPulse: { model: m.id },
      },
    };
  });
}

module.exports = { API_ORIGIN, isCreatePulseModel, createPulseReferenceCapabilities, createPulseMediaModels };

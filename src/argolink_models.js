'use strict';

// ArgoLink (argolink.io) media models. Its public catalog
// (GET /api/catalog/v1/models) lists each model's settings and USD prices; this
// turns the image and video entries into provider_models rows shaped like the
// AI Gateway's, so the same quote, reference checks and Studio controls apply.
const CATALOG_URL = 'https://argolink.io/api/catalog/v1/models?page_size=100';

// xAI retires grok-imagine-image-quality on 2 November 2026 (its requests then
// run on grok-imagine-image-2.0), so it is not offered.
const SKIP = new Set(['grok-imagine-image-quality']);

// Ratios the Studio ratio picker can show; ArgoLink's extra Grok ratios
// (19.5:9, 20:9, ...) and "auto" are left out.
const PICKER_RATIOS = ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9','2:1','1:2','5:2'];

// The catalog has no settings block for Grok Video 1.5; these come from its
// guide (1-15 s, 480p/720p/1080p, first frame, last frame, reference images).
const GROK_VIDEO = {
  default_resolution: '720p', default_duration: 8, generate_audio: 'switch',
  modes: [
    { mode: 'text', min_duration: 1, max_duration: 15, aspect_ratios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3'], default_aspect_ratio: '16:9' },
    { mode: 'start_image', min_duration: 1, max_duration: 15, max_images: 1 },
    { mode: 'first_last_frames', min_duration: 1, max_duration: 15, max_images: 2 },
    { mode: 'multimodal_reference', min_duration: 1, max_duration: 15, max_images: 7, max_assets: 7 },
  ],
};

const IMAGE_BYTES = 20 * 1024 * 1024, VIDEO_BYTES = 50 * 1024 * 1024;
const upper = value => String(value).toUpperCase();
const range = (min, max) => Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);

function isArgoModel(id) { return String(id || '').startsWith('argo_'); }
function argoPublicId(id) { return 'argo_' + String(id).replace(/[^a-zA-Z0-9]/g, '_'); }

function effectiveTiers(raw) {
  return (raw.pricing?.effective?.tiers || []).filter(t => t?.label && Number(t.price) > 0);
}

function imageModel(raw) {
  const spec = raw.image || {};
  const gpt = spec.frame === 'size';
  const ratios = (gpt ? (spec.sizes || []).map(s => s.aspect_ratio) : spec.aspect_ratios || []).filter(r => PICKER_RATIOS.includes(r));
  const imageSizes = (spec.resolutions || []).map(upper);
  const prices = Object.fromEntries(effectiveTiers(raw).map(t => [upper(t.label), Number(t.price)]));
  // Grok's 1.5K tier is not listed separately; it is charged as the next tier up.
  const tiers = imageSizes.map((size, i) => ({ size, cost: prices[size] ?? Math.max(...imageSizes.slice(i).map(s => prices[s] || 0)) }))
    .filter(t => t.cost > 0);
  const qualities = gpt ? ['low', 'medium', 'high'] : [];
  const maxRefs = Math.max(0, Number(spec.max_references || 0));
  const roles = maxRefs ? ['image_references'] : [];
  const referenceCapabilities = {
    textOnly: true, totalMax: maxRefs,
    image: { supported: maxRefs > 0, max: maxRefs, min: 0, roles, requiredRoles: [], maxBytes: Math.min(IMAGE_BYTES, Number(spec.max_reference_mb || 20) * 1024 * 1024), formats: ['jpeg', 'png', 'webp'] },
    video: { supported: false, max: 0, min: 0, roles: [] }, audio: { supported: false, max: 0, min: 0, roles: [] },
  };
  const defaultRatio = ratios.includes('1:1') ? '1:1' : ratios[0];
  return {
    providerModelId: raw.id, publicModelId: argoPublicId(raw.id), label: raw.display_name || raw.id, mediaType: 'image',
    options: {
      catalogVerified: true, adapterSupported: tiers.length > 0 && ratios.length > 0,
      setupReason: tiers.length ? '' : 'ArgoLink lists no price for this model.',
      gatewayType: 'image', argoFrame: gpt ? 'size' : 'aspect_ratio',
      pixelSizes: gpt ? Object.fromEntries((spec.sizes || []).map(s => [s.aspect_ratio, s.pixels || {}])) : {},
      pricing: { image_dimension_quality_pricing: tiers }, inputLimits: { text: { max_chars: 8000 } },
      aspectRatios: ratios, defaultAspectRatio: defaultRatio,
      qualities, defaultQuality: qualities.length ? 'medium' : undefined,
      imageSizes, defaultImageSize: imageSizes.includes('1K') ? '1K' : imageSizes[0],
      mediaRoles: roles, referenceCapabilities,
    },
  };
}

function videoModel(raw) {
  const spec = raw.video || (raw.id === 'grok-imagine-video-1.5' ? GROK_VIDEO : null);
  if (!spec) return null;
  const modes = Object.fromEntries((spec.modes || []).map(m => [m.mode, m]));
  const text = modes.text || {};
  const tiers = effectiveTiers(raw);
  const resolutions = tiers.map(t => String(t.label));
  const durations = range(Number(text.min_duration || 4), Number(text.max_duration || 15));
  const aspectRatios = (text.aspect_ratios || []).filter(r => PICKER_RATIOS.includes(r));
  const refs = modes.multimodal_reference || {};
  const frameRoles = [...(modes.start_image ? ['start_image'] : []), ...(modes.first_last_frames ? ['end_image'] : [])];
  const imageRoles = [...frameRoles, ...(Number(refs.max_images) > 0 ? ['image_references'] : [])];
  const maxImages = Math.max(Number(refs.max_images || 0), modes.first_last_frames ? 2 : modes.start_image ? 1 : 0);
  const maxVideos = Number(refs.max_videos || 0);
  const referenceCapabilities = {
    textOnly: true, totalMax: Math.max(maxImages, Number(refs.max_assets || 0)),
    image: { supported: imageRoles.length > 0, max: maxImages, min: 0, roles: imageRoles, requiredRoles: [], maxBytes: IMAGE_BYTES, formats: ['jpeg', 'png'] },
    video: { supported: maxVideos > 0, max: maxVideos, min: 0, roles: maxVideos ? ['video'] : [], requiredRoles: [], maxBytes: VIDEO_BYTES, formats: ['mp4', 'mov'] },
    audio: { supported: false, max: 0, min: 0, roles: [] },
  };
  const multiplier = Number(raw.pricing?.effective?.reference_video_multiplier);
  return {
    providerModelId: raw.id, publicModelId: argoPublicId(raw.id), label: raw.display_name || raw.id, mediaType: 'video',
    options: {
      catalogVerified: true, adapterSupported: tiers.length > 0 && aspectRatios.length > 0,
      setupReason: tiers.length ? '' : 'ArgoLink lists no price for this model.',
      gatewayType: 'video',
      pricing: {
        video_duration_pricing: tiers.map(t => ({ resolution: String(t.label), cost_per_second: Number(t.price) })),
        // Reference videos are billed by their length at the output rate
        // (Seedance 2.5 bills every second at a lower rate when one is sent).
        reference_videos_billed: maxVideos > 0,
        ...(multiplier > 0 ? { reference_video_multiplier: multiplier } : {}),
      },
      inputLimits: { text: { max_chars: Number(spec.max_prompt_chars || 8000) }, video: { max_duration_seconds: Number(refs.reference_video?.total_seconds || 15) } },
      supportedOperations: ['text-to-video', ...(modes.start_image ? ['image-to-video'] : []), ...(modes.first_last_frames ? ['first-last-frame'] : []), ...(refs.mode ? ['reference-to-video'] : [])],
      // Frame requests on these routes accept only "adaptive" (the video takes the first frame's shape).
      adaptiveFrames: (modes.start_image?.aspect_ratios || []).every(r => r === 'adaptive') && Boolean(modes.start_image?.aspect_ratios),
      durations, resolutions, aspectRatios,
      defaultAspectRatio: aspectRatios.includes('16:9') ? '16:9' : aspectRatios[0],
      defaultDuration: durations.includes(5) ? 5 : durations[0],
      defaultResolution: resolutions.includes(spec.default_resolution) ? spec.default_resolution : resolutions[0],
      fps: 24, modes: [], supportsAudio: spec.generate_audio === 'switch',
      mediaRoles: [...imageRoles, ...referenceCapabilities.video.roles], referenceCapabilities,
    },
  };
}

function argoMediaModels(catalog) {
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const models = items.filter(m => m?.id && !SKIP.has(m.id) && (m.category === 'image' || m.category === 'video'))
    .map(m => m.category === 'image' ? imageModel(m) : videoModel(m)).filter(Boolean);
  if (!models.length) throw Object.assign(new Error('The ArgoLink catalog had no media models. The previous catalog has been kept.'), { statusCode: 502 });
  return models;
}

module.exports = { CATALOG_URL, isArgoModel, argoPublicId, argoMediaModels };

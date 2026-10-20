'use strict';

// Sluice (getsluice.com) Seedance models: the "Lite" Seedance models in Video
// Studio and Cartoon Studio. Its public catalogue (GET /v1/models, no key)
// gives each model's per-second price, durations, resolutions and image
// inputs; prices are per second of output plus a flat surcharge when a request
// carries input images. Sold at cost like every model: 24 credits per rupee
// (6,720 per USD), so the plan price carries the 50% margin.
const API_ORIGIN = 'https://www.getsluice.com';
const FAMILIES = [
  { id: 'seedance-2.5', publicModelId: 'sl_seedance_2_5', name: 'Seedance 2.5 Lite' },
  { id: 'seedance-2.0', publicModelId: 'sl_seedance_2_0', name: 'Seedance 2.0 Lite' },
  { id: 'seedance-2.0-fast', publicModelId: 'sl_seedance_2_0_fast', name: 'Seedance 2.0 Fast Lite' },
];
// Ratios the Studio ratio picker shows. Sluice has no aspect-ratio field; the
// chosen ratio is written into the prompt (see provider/sluice.js).
const PICKER_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const IMAGE_BYTES = 10 * 1024 * 1024;
// Room left in Sluice's prompt for the aspect-ratio line.
const PROMPT_RESERVE = 40;

function isSluiceModel(id) { return String(id || '').startsWith('sl_'); }

const range = (min, max) => Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);

function sluiceReferenceCapabilities(caps = {}) {
  const max = Math.max(1, Number(caps.max_references || 5));
  // Plain reference images come first: Cartoon Studio's character image takes the first role.
  const roles = ['image_references', ...(caps.first_frame ? ['start_image'] : []), ...(caps.last_frame ? ['end_image'] : [])];
  return {
    textOnly: true, totalMax: max,
    image: { supported: caps.image_input !== false, max, min: 0, roles, requiredRoles: [], maxBytes: IMAGE_BYTES, formats: ['jpeg', 'png', 'webp'] },
    video: { supported: false, max: 0, min: 0, roles: [], requiredRoles: [] },
    audio: { supported: false, max: 0, min: 0, roles: [], requiredRoles: [] },
  };
}

function familyModel(family, item, defaults = {}) {
  const caps = item.capabilities || {};
  const price = Number(item.price_per_second_micros) / 1e6;
  const resolutions = (item.resolutions || []).map(String);
  const durations = range(Number(item.min_duration_seconds || defaults.min_duration_seconds || 4), Number(item.max_duration_seconds || 15));
  const aspectRatios = (caps.aspect_ratios || PICKER_RATIOS).map(String).filter(r => PICKER_RATIOS.includes(r));
  const referenceCapabilities = sluiceReferenceCapabilities(caps);
  const ok = item.status === 'ga' && price > 0 && resolutions.length > 0 && durations.length > 0;
  const promptChars = Number(defaults.max_prompt_chars || 20000) - PROMPT_RESERVE;
  return {
    providerModelId: family.id, publicModelId: family.publicModelId, mediaType: 'video',
    label: family.name + ' · ' + (durations[0] >= 10 ? durations[0] + '–' + durations.at(-1) + ' s' : 'up to ' + durations.at(-1) + ' s'),
    options: {
      catalogVerified: true, adapterSupported: ok,
      setupReason: ok ? '' : 'Sluice does not offer this model right now.',
      gatewayType: 'video',
      pricing: {
        video_duration_pricing: resolutions.map(resolution => ({ resolution, cost_per_second: price })),
        reference_surcharge_usd: Number(item.reference_surcharge_micros || 0) / 1e6,
      },
      inputLimits: { text: { max_chars: promptChars } },
      supportedOperations: ['text-to-video', 'reference-to-video'],
      durations, resolutions, aspectRatios,
      defaultAspectRatio: aspectRatios.includes('9:16') ? '9:16' : aspectRatios[0],
      defaultDuration: durations.includes(5) ? 5 : durations[0],
      defaultResolution: resolutions.includes(item.default_resolution) ? item.default_resolution : resolutions[0],
      fps: 24, modes: [], supportsAudio: false,
      mediaRoles: referenceCapabilities.image.roles, referenceCapabilities,
      sluice: { model: family.id, maxReferences: referenceCapabilities.totalMax },
    },
  };
}

// The Video Studio rows for a /v1/models answer.
function sluiceMediaModels(catalog) {
  const items = Array.isArray(catalog?.models) ? catalog.models : [];
  const models = FAMILIES.map(f => { const item = items.find(i => i.id === f.id); return item ? familyModel(f, item, catalog.defaults || {}) : null; }).filter(Boolean);
  if (!models.length) throw Object.assign(new Error('The Sluice catalogue had no Seedance models. The previous catalogue has been kept.'), { statusCode: 502 });
  return models;
}

async function fetchSluiceCatalog(fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(API_ORIGIN + '/v1/models', { headers: { accept: 'application/json', 'user-agent': 'CMMTools/1.0' }, signal: AbortSignal.timeout(20000), redirect: 'error' }); }
  catch { throw Object.assign(new Error('Sluice could not be reached. Please try again later.'), { statusCode: 502 }); }
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body?.models)) throw Object.assign(new Error('Sluice returned no model catalogue (HTTP ' + response.status + ').'), { statusCode: 502 });
  return body;
}

module.exports = { API_ORIGIN, FAMILIES, isSluiceModel, sluiceReferenceCapabilities, sluiceMediaModels, fetchSluiceCatalog };

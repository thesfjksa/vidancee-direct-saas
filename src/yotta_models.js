'use strict';

// Yotta Labs AI Gateway (gateway.yottalabs.ai) video models. Its public catalog
// (GET /api/maas/models/{slug}, no key needed) gives each model's settings and
// USD prices per second; one Yotta model has a text, an image (first frame) and
// a reference slug, which become one Video Studio model here, priced and
// checked by the same code as ArgoLink's models.
const CATALOG_ORIGIN = 'https://gateway.yottalabs.ai/api/maas';
const FAMILIES = [
  { key: 'wan3.0', publicModelId: 'yotta_wan_3_0', label: 'Wan 3.0 · up to 30 s' },
  { key: 'wan2.7', publicModelId: 'yotta_wan_2_7', label: 'Wan 2.7 · up to 15 s' },
];
const SLUGS = FAMILIES.flatMap(f => ['t2v', 'i2v', 'r2v'].map(mode => f.key + '-' + mode));
// Ratios the Studio ratio picker can show ("adaptive" is used for frame requests only).
const PICKER_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const MAX_IMAGES = 5;
const IMAGE_BYTES = 10 * 1024 * 1024;

function isYottaModel(id) { return String(id || '').startsWith('yotta_'); }

const range = (min, max) => Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

// Per-second prices as video_duration_pricing tiers. Yotta's current
// (discounted) price is what it charges; the list price is the fallback.
function priceTiers(item) {
  const prices = item?.providers?.[0]?.display_prices;
  const tiers = [];
  for (const p of prices?.items || []) {
    const resolution = String(p.resolution || '');
    if (!resolution) continue;
    if (prices.type === 'video_tiered') {
      const silent = Number(p.discounted_without_audio_per_second ?? p.without_audio_per_second);
      const audio = Number(p.discounted_with_audio_per_second ?? p.with_audio_per_second);
      if (positive(silent)) tiers.push({ resolution, audio: false, cost_per_second: silent });
      if (positive(audio)) tiers.push({ resolution, audio: true, cost_per_second: audio });
    } else {
      const rate = Number(p.discounted_per_second ?? p.per_second);
      if (positive(rate)) tiers.push({ resolution, cost_per_second: rate });
    }
  }
  return tiers;
}

function familyModel(family, items) {
  const bySlug = Object.fromEntries(items.map(item => [item.slug, item]));
  const t2v = bySlug[family.key + '-t2v'];
  if (!t2v) return null;
  const i2v = bySlug[family.key + '-i2v'], r2v = bySlug[family.key + '-r2v'];
  const p = t2v.parameters || {};
  const resolutions = (p.resolution || []).map(String);
  const durations = range(Number(p.duration?.min || 2), Number(p.duration?.max || 15));
  const aspectRatios = (p.aspect_ratio || []).map(String).filter(r => PICKER_RATIOS.includes(r));
  const tiers = priceTiers(t2v);
  const roles = [...(i2v ? ['start_image'] : []), ...(r2v ? ['image_references'] : [])];
  const supportsAudio = Array.isArray(p.generate_audio);
  return {
    providerModelId: family.key, publicModelId: family.publicModelId, label: family.label, mediaType: 'video',
    options: {
      catalogVerified: true, adapterSupported: tiers.length > 0 && aspectRatios.length > 0 && resolutions.length > 0,
      setupReason: tiers.length ? '' : 'Yotta lists no price for this model.',
      gatewayType: 'video', pricing: { video_duration_pricing: tiers },
      inputLimits: { text: { max_chars: 5000 } },
      supportedOperations: ['text-to-video', ...(i2v ? ['image-to-video'] : []), ...(r2v ? ['reference-to-video'] : [])],
      durations, resolutions, aspectRatios,
      defaultAspectRatio: aspectRatios.includes('16:9') ? '16:9' : aspectRatios[0],
      defaultDuration: durations.includes(5) ? 5 : durations[0],
      defaultResolution: resolutions[0],
      fps: 24, modes: [], supportsAudio,
      mediaRoles: roles,
      referenceCapabilities: {
        textOnly: true, totalMax: MAX_IMAGES,
        image: { supported: roles.length > 0, max: MAX_IMAGES, min: 0, roles, requiredRoles: [], maxBytes: IMAGE_BYTES, formats: ['jpeg', 'png'] },
        video: { supported: false, max: 0, min: 0, roles: [] }, audio: { supported: false, max: 0, min: 0, roles: [] },
      },
      // Yotta model slugs per request shape, and whether its frame route takes an aspect ratio.
      yotta: { t2v: t2v.slug, i2v: i2v?.slug || null, r2v: r2v?.slug || null,
        framesAspectRatio: Array.isArray(i2v?.parameters?.aspect_ratio) && i2v.parameters.aspect_ratio.includes('adaptive') },
    },
  };
}

function yottaMediaModels(catalog) {
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const models = FAMILIES.map(f => familyModel(f, items)).filter(Boolean);
  if (!models.length) throw Object.assign(new Error('The Yotta catalog had no Wan models. The previous catalog has been kept.'), { statusCode: 502 });
  return models;
}

// The live catalog, read the way the snapshot was made.
async function fetchYottaCatalog(fetchImpl = fetch) {
  const items = [];
  for (const slug of SLUGS) {
    let response;
    try { response = await fetchImpl(CATALOG_ORIGIN + '/models/' + encodeURIComponent(slug), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error' }); }
    catch { throw Object.assign(new Error('Yotta could not be reached. Please try again later.'), { statusCode: 502 }); }
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code !== 10000 || !body.data) continue;
    const d = body.data;
    items.push({ slug: d.slug, name: d.name, category: d.category, parameters: d.parameters,
      providers: (d.providers || []).map(p => ({ slug: p.slug, display_prices: p.display_prices })) });
  }
  return { fetchedAt: new Date().toISOString(), items };
}

module.exports = { CATALOG_ORIGIN, FAMILIES, SLUGS, isYottaModel, priceTiers, yottaMediaModels, fetchYottaCatalog };

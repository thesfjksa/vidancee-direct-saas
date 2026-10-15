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
const IMAGE_BYTES = 10 * 1024 * 1024;
const VIDEO_BYTES = 25 * 1024 * 1024;
const AUDIO_BYTES = 15 * 1024 * 1024;
// Reference files per family (Yotta, October 2026). Wan 3.0's reference route
// takes up to 10 images, 5 videos and 5 sound clips (@Image1, @Video1, @Audio1
// in the prompt), with at most 15 s of video and 15 s of sound in total; a
// reference video shortens the longest output by its own length. Its text and
// frame routes take no sound. Wan 2.7's reference route takes up to 5 images
// and videos together, and its output is 10 s at most with a reference video;
// one sound file drives a text or start-frame video (audio_url), or gives
// @Video1 its voice (reference_audio) on the reference route.
const REFERENCES = {
  'wan3.0': { totalMax: 15, images: 10, videos: 5, audios: 5, audioRole: 'audio_references', videoSeconds: 15, audioSeconds: 15, videoShortensOutput: true },
  'wan2.7': { totalMax: 5, images: 5, videos: 5, audios: 1, audioRole: 'audio_track', maxDurationWithVideo: 10 },
};

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
  const yotta = { family: family.key, t2v: t2v.slug, i2v: i2v?.slug || null, r2v: r2v?.slug || null,
    framesAspectRatio: Array.isArray(i2v?.parameters?.aspect_ratio) && i2v.parameters.aspect_ratio.includes('adaptive') };
  const referenceCapabilities = yottaReferenceCapabilities(yotta);
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
      mediaRoles: referenceCapabilities.image.roles, referenceCapabilities,
      // Yotta model slugs per request shape, and whether its frame route takes an aspect ratio.
      yotta,
    },
  };
}

// What each model accepts, worked out from its family and slugs (models saved
// before reference videos and sound were added get them from here too).
function yottaReferenceCapabilities(yotta = {}) {
  const r = REFERENCES[yotta.family] || REFERENCES['wan2.7'];
  const imageRoles = [...(yotta.i2v ? ['start_image'] : []), ...(yotta.r2v ? ['image_references'] : [])];
  const audioSupported = yotta.family === 'wan3.0' ? Boolean(yotta.r2v) : true;
  return {
    textOnly: true, totalMax: r.totalMax,
    image: { supported: imageRoles.length > 0, max: r.images, min: 0, roles: imageRoles, requiredRoles: [], maxBytes: IMAGE_BYTES, formats: ['jpeg', 'png'] },
    video: { supported: Boolean(yotta.r2v), max: yotta.r2v ? r.videos : 0, min: 0, roles: yotta.r2v ? ['video_references'] : [], requiredRoles: [], maxBytes: VIDEO_BYTES, formats: ['mp4', 'mov'] },
    audio: { supported: audioSupported, max: audioSupported ? r.audios : 0, min: 0, roles: audioSupported ? [r.audioRole] : [], requiredRoles: [], maxBytes: AUDIO_BYTES, formats: ['mp3', 'wav'],
      ...(r.audioSeconds ? { maxTotalSeconds: r.audioSeconds } : {}) },
    ...(r.videoSeconds ? { videoMaxTotalSeconds: r.videoSeconds } : {}),
  };
}

// Length of a WAV file in seconds, or null (MP3 lengths are left to Yotta).
function wavSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12, byteRate = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= buffer.length) byteRate = buffer.readUInt32LE(offset + 16);
    if (id === 'data') return byteRate > 0 ? Math.min(size, buffer.length - offset - 8) / byteRate : null;
    offset += 8 + size + (size % 2);
  }
  return null;
}

const refFail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

// The Yotta rules beyond counts and formats: which references go together,
// how long reference clips may be and how they limit the output length.
// mp4Seconds measures reference videos (passed in to avoid a require cycle).
function validateYottaReferences(model, body = {}, { mp4Seconds = () => null } = {}) {
  const yotta = model.yotta || {}, r = REFERENCES[yotta.family] || REFERENCES['wan2.7'];
  const videos = Array.isArray(body.videos) ? body.videos : [], audios = Array.isArray(body.audios) ? body.audios : [];
  let order = [];
  try { order = typeof body.referenceOrder === 'string' ? JSON.parse(body.referenceOrder || '[]') : (body.referenceOrder || []); } catch {}
  const roles = (Array.isArray(order) ? order : []).map(o => o?.role);
  const frame = roles.includes('start_image') || roles.includes('end_image');
  const imageRefs = roles.includes('image_references');
  const duration = Number(body.duration);
  if (audios.length) {
    if (yotta.family === 'wan3.0' && frame) refFail('Wan 3.0 takes sound references with reference images or videos, not with a start frame.');
    if (yotta.family !== 'wan3.0' && imageRefs && !videos.length) refFail('With reference images, Wan 2.7 can use a sound file only to voice a reference video. Add a reference video or remove the sound file.');
  }
  if (videos.length) {
    const seconds = videos.reduce((sum, v) => sum + (mp4Seconds(v?.data) ?? 0), 0);
    if (r.videoSeconds && seconds > r.videoSeconds + 0.05) refFail('Reference videos can be ' + r.videoSeconds + ' seconds long in total for this model.');
    if (r.maxDurationWithVideo && duration > r.maxDurationWithVideo) refFail('With a reference video this model makes videos of up to ' + r.maxDurationWithVideo + ' seconds.');
    const max = Math.max(...(model.durations || [30]));
    if (r.videoShortensOutput && seconds > 0 && duration + seconds > max + 0.05) refFail('Your reference videos run ' + Math.ceil(seconds) + ' s, so this model can make up to ' + Math.max(0, Math.floor(max - seconds)) + ' s. Choose a shorter duration.');
  }
  if (audios.length && r.audioSeconds) {
    const seconds = audios.reduce((sum, a) => sum + (wavSeconds(a?.data) ?? 0), 0);
    if (seconds > r.audioSeconds + 0.05) refFail('Sound references can be ' + r.audioSeconds + ' seconds long in total for this model.');
  }
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

module.exports = { CATALOG_ORIGIN, FAMILIES, SLUGS, REFERENCES, isYottaModel, yottaReferenceCapabilities, validateYottaReferences, wavSeconds, priceTiers, yottaMediaModels, fetchYottaCatalog };

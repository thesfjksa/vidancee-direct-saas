'use strict';

const { MAX_PROMPT_CHARS } = require('./prompt_limits.js');
const { wavSeconds } = require('./media_info.js');

// Higgsfield API (docs.higgsfield.ai) video models in Video Studio. Wan 3.0 has
// one endpoint per request shape (text, start/end frames, reference files);
// together they are one Video Studio model, priced and checked by the same
// code as ArgoLink's models. Prices are per output second, read from
// Higgsfield's /estimate endpoint when the admin syncs prices.
const API_ORIGIN = 'https://api.higgsfield.ai';
const WAN_3 = {
  providerModelId: 'wan-3.0', publicModelId: 'hf_wan_3_0', label: 'Wan 3.0 · up to 30 s',
  paths: { t2v: 'alibaba/wan-3.0/text-to-video', i2v: 'alibaba/wan-3.0/image-to-video', r2v: 'alibaba/wan-3.0/reference-to-video' },
};
const RESOLUTIONS = ['480p', '720p', '1080p'];
// Ratios the Studio ratio picker shows ("adaptive" is used for frame requests only).
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const DURATIONS = Array.from({ length: 29 }, (_, i) => i + 2); // 2-30 s
const IMAGE_BYTES = 10 * 1024 * 1024;
const VIDEO_BYTES = 25 * 1024 * 1024;
const AUDIO_BYTES = 15 * 1024 * 1024;
// Higgsfield's Wan 3.0 reference route: up to 10 images, 5 videos (1-30 s each,
// 30 s in total) and 5 sound clips (WAV or MP3, 30 s in total), cited as
// @Image1, @Video1, @Audio1 in the prompt. Its frame route takes a start frame
// and an optional end frame, and no other files.
const REFERENCES = { images: 10, videos: 5, audios: 5, videoSeconds: 30, audioSeconds: 30, clipMinSeconds: 1 };

function isHiggsfieldModel(id) { return String(id || '').startsWith('hf_'); }

function higgsfieldReferenceCapabilities() {
  const r = REFERENCES;
  return {
    textOnly: true, totalMax: r.images + r.videos,
    image: { supported: true, max: r.images, min: 0, roles: ['start_image', 'end_image', 'image_references'], requiredRoles: [], maxBytes: IMAGE_BYTES, formats: ['jpeg', 'png', 'webp'] },
    video: { supported: true, max: r.videos, min: 0, roles: ['video_references'], requiredRoles: [], maxBytes: VIDEO_BYTES, formats: ['mp4', 'mov'] },
    audio: { supported: true, max: r.audios, min: 0, roles: ['audio_references'], requiredRoles: [], maxBytes: AUDIO_BYTES, formats: ['mp3', 'wav'], maxTotalSeconds: r.audioSeconds },
    videoMaxTotalSeconds: r.videoSeconds,
  };
}

// The model row. tiers are video_duration_pricing entries ({resolution, audio,
// cost_per_second}); without them the model stays hidden until prices are synced.
function higgsfieldMediaModels(tiers = []) {
  const referenceCapabilities = higgsfieldReferenceCapabilities();
  return [{
    providerModelId: WAN_3.providerModelId, publicModelId: WAN_3.publicModelId, label: WAN_3.label, mediaType: 'video',
    options: {
      catalogVerified: true, adapterSupported: tiers.length > 0,
      setupReason: tiers.length ? '' : 'Save the Higgsfield API key and sync prices in Admin.',
      gatewayType: 'video', pricing: { video_duration_pricing: tiers },
      inputLimits: { text: { max_chars: MAX_PROMPT_CHARS } },
      supportedOperations: ['text-to-video', 'image-to-video', 'reference-to-video'],
      durations: DURATIONS, resolutions: RESOLUTIONS, aspectRatios: ASPECT_RATIOS,
      defaultAspectRatio: '16:9', defaultDuration: 5, defaultResolution: '480p',
      fps: 24, modes: [], supportsAudio: true,
      mediaRoles: referenceCapabilities.image.roles, referenceCapabilities,
      higgsfield: { paths: WAN_3.paths },
    },
  }];
}

// Per-second prices from Higgsfield's estimates: a 5 s text-to-video clip at
// each resolution, with and without generated sound. estimate(path, input)
// returns {usd}.
async function fetchHiggsfieldTiers(estimate) {
  const tiers = [], seconds = 5;
  for (const resolution of RESOLUTIONS) {
    for (const audio of [false, true]) {
      let result;
      try { result = await estimate(WAN_3.paths.t2v, { prompt: 'A calm lake at sunrise.', duration: seconds, resolution, aspect_ratio: '16:9', generate_audio: audio }); }
      catch (error) { throw Object.assign(new Error('Price estimate for ' + resolution + (audio ? ' with sound' : '') + ' failed: ' + error.message), { statusCode: error.statusCode || 502, providerStatus: error.providerStatus, detail: error.detail }); }
      const usd = Number(result?.usd);
      if (!(usd > 0)) throw Object.assign(new Error('Higgsfield returned no price for Wan 3.0 at ' + resolution + ' (answer: ' + JSON.stringify(result).slice(0, 200) + ').'), { statusCode: 502 });
      tiers.push({ resolution, audio, cost_per_second: usd / seconds });
    }
  }
  return tiers;
}

const refFail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

// The rules beyond counts and formats: frames do not mix with reference files,
// and reference clips have length limits. mp4Seconds measures reference videos
// (passed in to avoid a require cycle).
function validateHiggsfieldReferences(model, body = {}, { mp4Seconds = () => null } = {}) {
  const r = REFERENCES;
  const videos = Array.isArray(body.videos) ? body.videos : [], audios = Array.isArray(body.audios) ? body.audios : [];
  let order = [];
  try { order = typeof body.referenceOrder === 'string' ? JSON.parse(body.referenceOrder || '[]') : (body.referenceOrder || []); } catch {}
  const roles = (Array.isArray(order) ? order : []).map(o => o?.role);
  const frames = roles.includes('start_image') || roles.includes('end_image');
  if (frames && (roles.includes('image_references') || videos.length || audios.length)) {
    refFail('Use either start/end frames or reference files (images, videos, sound) in one Wan 3.0 video.');
  }
  if (videos.length) {
    const lengths = videos.map(v => mp4Seconds(v?.data));
    if (lengths.some(s => s != null && s < r.clipMinSeconds - 0.05)) refFail('Each reference video must be at least 1 second long.');
    const total = lengths.reduce((sum, s) => sum + (s ?? 0), 0);
    if (total > r.videoSeconds + 0.05) refFail('Reference videos can be ' + r.videoSeconds + ' seconds long in total for this model.');
  }
  if (audios.length) {
    const total = audios.reduce((sum, a) => sum + (wavSeconds(a?.data) ?? 0), 0);
    if (total > r.audioSeconds + 0.05) refFail('Sound references can be ' + r.audioSeconds + ' seconds long in total for this model.');
  }
}

module.exports = { API_ORIGIN, WAN_3, RESOLUTIONS, REFERENCES, isHiggsfieldModel, higgsfieldReferenceCapabilities,
  higgsfieldMediaModels, fetchHiggsfieldTiers, validateHiggsfieldReferences };

'use strict';

// Seedance 2.5 on fal.ai: the backup for Video Studio's Seedance 2.5 while
// ArgoLink is out of credits. fal has one endpoint per request shape (prompt
// only, start/end frames, reference files); the render then goes through the
// same HD enhancement as an ArgoLink render.
const FAL_SEEDANCE_25 = {
  text: 'bytedance/seedance-2.5/text-to-video',
  frames: 'bytedance/seedance-2.5/image-to-video',
  reference: 'bytedance/seedance-2.5/reference-to-video',
};
// fal's listed price per output second. With reference videos their seconds
// are billed too and every second costs 0.6x, as on ArgoLink (0.598x).
const FAL_SEEDANCE_25_USD_PER_SECOND = { '480p': 0.2205, '720p': 0.473, '1080p': 1.164 };
const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];

function isSeedance25(model) { return model?.providerModelId === 'seedance-2.5'; }

// {path, input} for fal's queue. Duration is a string enum on fal ("4"-"30");
// audio is sent explicitly because fal turns it on by default.
function falSeedanceRequest(params, references = []) {
  const frames = references.filter(r => r.role === 'start_image' || r.role === 'end_image');
  const images = references.filter(r => r.mimeType?.startsWith('image/') && !frames.includes(r));
  const videos = references.filter(r => r.mimeType?.startsWith('video/'));
  const audios = references.filter(r => r.mimeType?.startsWith('audio/'));
  // H.264 plays in every browser and is what the HD upscaler reads.
  const input = { prompt: String(params.prompt || ''), resolution: String(params.resolution), duration: String(params.duration),
    generate_audio: Boolean(params.generateAudio), codec: 'H264' };
  if (frames.length) {
    if (images.length || videos.length || audios.length) throw new Error('Use either frames or reference files in a single video request.');
    const start = frames.find(r => r.role === 'start_image'), end = frames.find(r => r.role === 'end_image');
    if (!start) throw new Error('Add a start frame before an end frame.');
    // The video takes the start frame's shape, as on ArgoLink.
    return { path: FAL_SEEDANCE_25.frames, input: { ...input, image_url: start.url, ...(end ? { end_image_url: end.url } : {}) } };
  }
  input.aspect_ratio = RATIOS.includes(params.aspectRatio) ? params.aspectRatio : 'auto';
  if (!images.length && !videos.length && !audios.length) return { path: FAL_SEEDANCE_25.text, input };
  if (images.length) input.image_urls = images.map(r => r.url);
  if (videos.length) input.video_urls = videos.map(r => r.url);
  if (audios.length) input.audio_urls = audios.map(r => r.url);
  return { path: FAL_SEEDANCE_25.reference, input };
}

// fal's price for the render, from ArgoLink's quote for the same request (both
// bill per second at the render resolution, reference video seconds included).
function falSeedanceUsd(model, params) {
  const resolution = String(params.resolution);
  const argoRate = Number((model?.pricing?.video_duration_pricing || []).find(t => t.resolution === resolution)?.cost_per_second);
  const falRate = FAL_SEEDANCE_25_USD_PER_SECOND[resolution];
  const renderUsd = Number(params.renderUsd);
  if (!(argoRate > 0) || !falRate || !(renderUsd > 0)) return null;
  return renderUsd / argoRate * falRate;
}

module.exports = { FAL_SEEDANCE_25, FAL_SEEDANCE_25_USD_PER_SECOND, isSeedance25, falSeedanceRequest, falSeedanceUsd };

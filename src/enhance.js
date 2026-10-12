'use strict';

// Video upscaling with the ByteDance upscaler on fal.ai, used by the Upscaler
// tab and by ArgoLink HD enhancement.
const { videoDimensions } = require('./vercel_models.js');

const FAL_UPSCALER = { label: 'ByteDance Video Upscaler', path: 'fal-ai/bytedance-upscaler/upscale/video' };
// USD per second at up to 30 fps, by output tier (targets up to 1080p use the 1080p rate).
const BYTEDANCE_USD = { '1080p': 0.0072, '2k': 0.0144, '4k': 0.0288 };
const SHORT_SIDE = { '480p': 480, '720p': 720, '768p': 768, '1080p': 1080, '2k': 1440, '4k': 2160 };

function dimensionsFor(resolution, aspectRatio) {
  const ratio = /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(String(aspectRatio || '')) ? aspectRatio : '16:9';
  const [w, h] = videoDimensions(SHORT_SIDE[resolution] ? resolution : '720p', ratio).split('x').map(Number);
  return { width: w, height: h };
}

// How to upscale a width x height clip of `seconds` to `target` (720p, 1080p,
// 2k or 4k). Returns null when the clip is already at least that size.
function planUpscale({ width, height, seconds }, target, { preset = 'general', fps } = {}) {
  const targetShort = SHORT_SIDE[target];
  const short = Math.min(width, height);
  if (!targetShort || !short || !(seconds > 0)) throw Object.assign(new Error('The video size or length could not be read.'), { statusCode: 400 });
  if (short >= targetShort * 0.98) return null;
  const tier = targetShort <= 1080 ? '1080p' : targetShort <= 1440 ? '2k' : '4k';
  const input = {
    // Named tiers where fal has them; 720p is reached with a scale ratio.
    ...(['1080p', '2k', '4k'].includes(target) ? { target_resolution: target } : { scale_ratio: Math.max(1.1, Math.round(targetShort / short * 1000) / 1000) }),
    enhancement_preset: preset, ...(fps ? { target_fps: fps } : {}),
  };
  return { path: FAL_UPSCALER.path, input, usd: Math.ceil(seconds - 1e-9) * BYTEDANCE_USD[tier], target };
}

function upscaleCredits(plan, creditsPerUsd) {
  return plan ? Math.ceil(plan.usd * Number(creditsPerUsd) - 1e-9) : 0;
}

// Width and height of the first video track in an MP4/MOV ('tkhd' box), or null.
function mp4Dimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  for (let at = buffer.indexOf('tkhd'); at >= 4; at = buffer.indexOf('tkhd', at + 4)) {
    const offset = buffer[at + 4] === 1 ? at + 88 : at + 80;
    if (offset + 8 > buffer.length) return null;
    const width = buffer.readUInt32BE(offset) / 65536, height = buffer.readUInt32BE(offset + 4) / 65536;
    if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) };
  }
  return null;
}

module.exports = { FAL_UPSCALER, BYTEDANCE_USD, SHORT_SIDE, dimensionsFor, planUpscale, upscaleCredits, mp4Dimensions };

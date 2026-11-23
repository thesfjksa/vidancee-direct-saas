'use strict';

const { cnyToCredits, usdToCredits } = require('./billing.js');
const { ASPECT_RATIOS } = require('./pricing.js');
const { readBoxes, isCompleteMp4 } = require('./mp4_trim.js');

const TOOLS = Object.freeze({
  'character-swap': { label: 'Character Swap', replacement: true,
    prompt: 'Replace the main person in the reference video with the person in the identity image. Keep the source performance, camera, and background.' },
  'motion-control': { label: 'Motion Control', replacement: true,
    prompt: 'Make the person in the identity image perform the movement in the reference video. Follow the source timing and body motion while preserving the new character’s identity.' },
  'object-swap': { label: 'Object Swap', replacement: false,
    prompt: 'Replace only the specified object in the reference video with the object in reference image 1. Preserve the scene, camera motion, people, and the original object’s movement and scale.' },
});
const IMAGE_LIMIT = 5 * 1024 * 1024;
const VIDEO_LIMIT = 25 * 1024 * 1024;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// Reviewed Fast 768p rates. The worker checks an exact quote for the media
// combination before creating a paid provider task.
function quoteVideoTool(input = {}) {
  const id = String(input.tool || '');
  const tool = Object.hasOwn(TOOLS, id) ? TOOLS[id] : null;
  if (!tool) fail('Choose a video tool.');
  const duration = Number(input.duration);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) fail('Choose a duration from 4 to 15 seconds.');
  const usd = duration * (tool.replacement ? 0.0062 : 0.003);
  return { id, tool, duration, cost: Math.ceil(usdToCredits(usd) - 1e-9), usd };
}

function videoSourceInfo(data) {
  try {
    if (!isCompleteMp4(data)) return null;
    const movie = readBoxes(data).find(box => box.type === 'moov');
    const header = movie?.children.find(box => box.type === 'mvhd')?.data;
    if (!header || header.length < 20) return null;
    const v1 = header[0] === 1;
    if (v1 && header.length < 32) return null;
    const scale = header.readUInt32BE(v1 ? 20 : 12);
    const length = v1 ? Number(header.readBigUInt64BE(24)) : header.readUInt32BE(16);
    const handlers = movie.children.filter(box => box.type === 'trak').map(track =>
      track.children.find(box => box.type === 'mdia')?.children
        .find(box => box.type === 'hdlr')?.data.toString('latin1', 8, 12));
    if (!scale || !length || !handlers.includes('vide')) return null;
    return { duration: length / scale, audio: handlers.includes('soun') };
  } catch {
    return null;
  }
}

function prepareVideoTool(input) {
  const quote = quoteVideoTool(input);
  const aspectRatio = String(input.aspectRatio || '');
  if (!ASPECT_RATIOS.includes(aspectRatio)) fail('Choose a supported aspect ratio.');
  const motionStart = Number(input.motionStart || 0);
  if (!Number.isFinite(motionStart) || motionStart < 0 || (!quote.tool.replacement && motionStart !== 0))
    fail('Choose a valid start time.');
  const preserveAudio = input.preserveAudio === true || input.preserveAudio === 'true';
  if (input.permission !== 'accepted') fail('Confirm you have permission to use the uploaded files.');
  const instructions = String(input.instructions || '').trim();
  if (instructions.length > 1600) fail('Use no more than 1,600 characters of instructions.');
  if (!quote.tool.replacement && !instructions) fail('Describe the object you want to replace.');
  if (input.images?.length !== 1 || input.videos?.length !== 1 || input.audios?.length)
    fail('Upload one reference image and one MP4 source video.');
  const [image] = input.images;
  const [video] = input.videos;
  if (!['image/jpeg','image/png','image/webp'].includes(image.mimeType) ||
      !Buffer.isBuffer(image.data) || !image.data.length || image.data.length > IMAGE_LIMIT)
    fail('Upload a JPEG, PNG, or WebP image up to 5 MB.');
  if (video.mimeType !== 'video/mp4' || !Buffer.isBuffer(video.data) || video.data.length > VIDEO_LIMIT)
    fail('Upload an MP4 source video up to 25 MB.');
  const source = videoSourceInfo(video.data);
  if (!source) fail('This MP4 could not be read. Export it as a standard MP4 and try again.');
  if (motionStart + quote.duration > source.duration) fail('The selected time range must fit inside the source video.');
  if (preserveAudio && !source.audio) fail('There is no source audio. Turn off Keep original audio.');

  return {
    quote,
    generation: { model: 'minimax_h3', duration: quote.duration, resolution: '768p', aspectRatio,
      prompt: quote.tool.prompt + (instructions ? '\n' + instructions : ''), images: [image], videos: [video] },
    options: { studio: 'video-tools', videoTool: quote.id, motionStart, preserveAudio },
  };
}

function validateSourceQuote(result, tool, duration) {
  const cost = result.price;
  const amount = result.currency === 'USD' ? usdToCredits(cost) :
    result.currency === 'CNY' ? cnyToCredits(cost) : NaN;
  const ceiling = quoteVideoTool({ tool, duration }).cost;
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(amount))
    fail('The video service did not return a usable price. Credits were refunded.', 502);
  if (amount > ceiling + 1e-6)
    fail('The video service price changed. Credits were refunded.', 409);
}

module.exports = { TOOLS, quoteVideoTool, prepareVideoTool, validateSourceQuote };

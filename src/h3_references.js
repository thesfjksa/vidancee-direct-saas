'use strict';

const { wavSeconds } = require('./media_info.js');

// Sound and video references for MiniMax H3 on vgenv (api.vgenv.com/docs-json):
// up to 2 sound clips (MP3 or WAV, "Audio 1/2") and one MP4 reference video,
// both sent as uploaded vgenv assets. MiniMax takes sound only together with a
// reference image or the reference video, and reference clips of 2-15 s. The
// app takes sound up to 15 MB and video up to 25 MB. WAV and MP4 lengths are
// checked here; MP3 lengths are left to vgenv.
const H3_REFS = Object.freeze({
  audios: 2, videos: 1,
  minSeconds: 2, maxSeconds: 15,
  audioBytes: 15 * 1024 * 1024, videoBytes: 25 * 1024 * 1024,
});

const H3_AUDIO_CAPABILITY = Object.freeze({
  supported: true, max: H3_REFS.audios, min: 0, roles: ['audio_references'], requiredRoles: [],
  maxBytes: H3_REFS.audioBytes, formats: ['mp3', 'wav'], needsImage: true,
});
const H3_VIDEO_CAPABILITY = Object.freeze({
  supported: true, max: H3_REFS.videos, min: 0, roles: ['video_references'], requiredRoles: [],
  maxBytes: H3_REFS.videoBytes, formats: ['mp4'],
});

const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'];

const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const lengthOk = seconds => seconds == null || (seconds >= H3_REFS.minSeconds - 0.05 && seconds <= H3_REFS.maxSeconds + 0.05);

// Checked before credits are taken. imageCount counts uploaded and reused
// images; mp4Seconds measures videos (passed in to avoid a require cycle).
function validateH3Media(audios, videos, imageCount, { mp4Seconds = () => null } = {}) {
  const sound = Array.isArray(audios) ? audios : [], clips = Array.isArray(videos) ? videos : [];
  if (clips.length > H3_REFS.videos) fail('MiniMax H3 accepts one reference video.');
  for (const video of clips) {
    if (String(video?.mimeType || '').toLowerCase() !== 'video/mp4') fail('The MiniMax H3 reference video must be an MP4 file.');
    if (!Buffer.isBuffer(video.data) || !video.data.length) fail('The reference video is empty.');
    if (video.data.length > H3_REFS.videoBytes) fail('The reference video must be 25 MB or smaller.');
    if (!lengthOk(mp4Seconds(video.data))) fail('The MiniMax H3 reference video must be ' + H3_REFS.minSeconds + ' to ' + H3_REFS.maxSeconds + ' seconds long.');
  }
  if (!sound.length) return;
  if (sound.length > H3_REFS.audios) fail('MiniMax H3 accepts at most ' + H3_REFS.audios + ' sound references.');
  if (!(Number(imageCount) > 0) && !clips.length) fail('MiniMax H3 needs a reference image or a reference video to use a sound reference.');
  for (const audio of sound) {
    if (!AUDIO_TYPES.includes(String(audio?.mimeType || '').toLowerCase())) fail('Sound references must be MP3 or WAV.');
    if (!Buffer.isBuffer(audio.data) || !audio.data.length) fail('A sound reference is empty.');
    if (audio.data.length > H3_REFS.audioBytes) fail('Each sound reference must be 15 MB or smaller.');
    if (!lengthOk(wavSeconds(audio.data))) fail('Each MiniMax H3 sound reference must be ' + H3_REFS.minSeconds + ' to ' + H3_REFS.maxSeconds + ' seconds long.');
  }
}

module.exports = { H3_REFS, H3_AUDIO_CAPABILITY, H3_VIDEO_CAPABILITY, validateH3Media };

'use strict';

const { wavSeconds } = require('./media_info.js');

// Sound references for MiniMax H3 on vgenv. MiniMax's rules: up to 3 clips of
// 2-15 s each, and only together with at least one reference image (sound
// alone, or with start/end frames, is not accepted). The app takes MP3 or WAV
// up to 15 MB; WAV lengths are checked here, MP3 lengths are left to vgenv.
const H3_AUDIO = Object.freeze({
  max: 3,
  minSeconds: 2,
  maxSeconds: 15,
  maxBytes: 15 * 1024 * 1024,
  role: 'audio_references',
});

const H3_AUDIO_CAPABILITY = Object.freeze({
  supported: true, max: H3_AUDIO.max, min: 0, roles: [H3_AUDIO.role], requiredRoles: [],
  maxBytes: H3_AUDIO.maxBytes, formats: ['mp3', 'wav'], needsImage: true,
});

const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'];

const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

// Checked before credits are taken. imageCount counts uploaded and reused images.
function validateH3Audio(audios, imageCount) {
  const list = Array.isArray(audios) ? audios : [];
  if (!list.length) return;
  if (list.length > H3_AUDIO.max) fail('MiniMax H3 accepts at most ' + H3_AUDIO.max + ' sound references.');
  if (!(Number(imageCount) > 0)) fail('MiniMax H3 needs at least one reference image to use a sound reference.');
  for (const audio of list) {
    if (!AUDIO_TYPES.includes(String(audio?.mimeType || '').toLowerCase())) fail('Sound references must be MP3 or WAV.');
    if (!Buffer.isBuffer(audio.data) || !audio.data.length) fail('A sound reference is empty.');
    if (audio.data.length > H3_AUDIO.maxBytes) fail('Each sound reference must be 15 MB or smaller.');
    const seconds = wavSeconds(audio.data);
    if (seconds != null && (seconds < H3_AUDIO.minSeconds - 0.05 || seconds > H3_AUDIO.maxSeconds + 0.05)) {
      fail('Each MiniMax H3 sound reference must be ' + H3_AUDIO.minSeconds + ' to ' + H3_AUDIO.maxSeconds + ' seconds long.');
    }
  }
}

module.exports = { H3_AUDIO, H3_AUDIO_CAPABILITY, validateH3Audio };

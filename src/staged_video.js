'use strict';

const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdtemp, open, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readBoxes } = require('./mp4_trim.js');

async function validateMp4(read, size) {
  let offset = 0, metadata = false, media = false;
  let boxes = 0;
  while (offset < size) {
    if (++boxes > 16384) return false;
    const header = await read(offset, Math.min(16, size - offset));
    if (header.length < 8) return false;
    const type = header.toString('latin1', 4, 8);
    if (offset === 0 && type !== 'ftyp') return false;
    let length = header.readUInt32BE(0);
    if (length === 1) {
      if (header.length < 16) return false;
      length = Number(header.readBigUInt64BE(8));
      if (length < 16) return false;
    } else if (length === 0) length = size - offset;
    if (length < 8 || length > size - offset) return false;
    if (type === 'moov') {
      // Validate the index with the existing parser without loading media data.
      if (length > 16 * 1024 * 1024) return false;
      try { readBoxes(await read(offset, length)); }
      catch { return false; }
      metadata = true;
    }
    media ||= type === 'mdat' || type === 'moof';
    offset += length;
  }
  return metadata && media;
}

// Stage before starting a database transaction or publishing to storage.
// The same validated bytes can then be uploaded or read in bounded chunks.
async function stageVideo(body, { contentLength, maxBytes }) {
  if (!body) throw new Error('The video download had no body.');
  const source = typeof body.getReader === 'function' ? Readable.fromWeb(body) : body;
  source.on('error', () => {});
  const advertised = Number(contentLength) || 0;
  const tooLarge = () => new Error('The generated video exceeds the ' + Math.floor(maxBytes / 1048576) + ' MiB download limit.');
  let dir, handle;
  const cleanup = async () => {
    try { await handle?.close(); }
    finally { if (dir) await rm(dir, { recursive: true, force: true }); }
  };
  try {
    if (advertised > maxBytes) throw tooLarge();
    dir = await mkdtemp(path.join(tmpdir(), 'cmm-dope-video-'));
    const filename = path.join(dir, 'video.mp4');
    let size = 0;
    const sha256 = createHash('sha256'), md5 = createHash('md5');
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) return callback(tooLarge());
        sha256.update(chunk);
        md5.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(source, meter, createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
    if (advertised && size !== advertised) throw new Error('The video download length was incomplete.');
    handle = await open(filename, 'r');
    const readChunk = async (offset, length) => {
      const bytes = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(bytes, done, length - done, offset + done);
        if (!bytesRead) throw new Error('The staged video was incomplete.');
        done += bytesRead;
      }
      return bytes;
    };
    if (!(await validateMp4(readChunk, size))) throw new Error('The output did not contain a complete MP4.');
    return { mimeType: 'video/mp4', size, md5: md5.digest('hex'), sha256: sha256.digest('hex'),
      readChunk, openStream: () => createReadStream(filename), cleanup };
  } catch (error) {
    source.destroy();
    await cleanup();
    throw error;
  }
}

module.exports = { stageVideo };

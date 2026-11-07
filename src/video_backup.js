'use strict';

const { Readable, addAbortSignal } = require('node:stream');
const { finished, pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');
const { getVideoOutput, readVideoChunks } = require('./video_outputs.js');
const { configuredStorage, keyFromMarker } = require('./object_storage.js');
const { configuredDrive, driveIdFromMarker } = require('./google_drive.js');

const PAGE_SIZE = 100;

async function* completedVideos(db, userId, signal) {
  let last;
  do {
    signal.throwIfAborted();
    const [rows] = await db.execute(
      "SELECT id, prompt, output_url, created_at FROM generations WHERE user_id = ? AND media_type = 'video' AND status = 'completed'" +
      (last ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '') +
      ' ORDER BY created_at DESC, id DESC LIMIT ' + PAGE_SIZE,
      last ? [userId, last.created_at, last.created_at, last.id] : [userId],
    );
    yield* rows;
    last = rows.length === PAGE_SIZE ? rows.at(-1) : null;
  } while (last);
}

async function openVideo(db, row, signal) {
  if (!row.output_url) throw new Error('No video output.');
  if (row.output_url === 'db:video') {
    const output = await getVideoOutput(db, row.id);
    const size = Number(output?.byte_length);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Video output is unavailable.');
    const chunks = readVideoChunks(db, row.id, size, signal);
    return { stream: Readable.from(chunks, { objectMode: false }), size };
  }

  const key = keyFromMarker(row.output_url);
  const driveId = driveIdFromMarker(row.output_url);
  let response;
  if (key) {
    const storage = await configuredStorage({ requireEnabled: false });
    if (!storage) throw new Error('Video storage is unavailable.');
    response = await storage.get(key, { signal });
  } else if (driveId) {
    const drive = await configuredDrive({ requireEnabled: false });
    response = await drive.getVideo(driveId, { signal });
  } else {
    // Legacy jobs can still point to the provider's own downloadable output.
    response = await fetch(row.output_url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
  }

  const mime = response.headers.get('content-type') || '';
  const length = response.headers.get('content-length');
  if (response.status !== 200 || !response.body || length === '0' || /^(text\/|application\/(json|xml))/i.test(mime)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Video output is unavailable.');
  }
  // Fetch decodes content encodings, so a compressed Content-Length is not
  // the size that ZIP receives.
  const size = !response.headers.has('content-encoding') && length !== null ? Number(length) : undefined;
  return { stream: Readable.fromWeb(response.body), size: Number.isSafeInteger(size) ? size : undefined };
}

async function appendFile(zip, stream, name, signal, size) {
  addAbortSignal(signal, stream);
  const consumed = finished(stream, { cleanup: true });
  zip.addReadStream(stream, name, { compress: false, size });
  await consumed;
}

async function sendVideoBackup(db, res, userId) {
  const controller = new AbortController();
  const { signal } = controller;
  const cancel = () => controller.abort();
  res.once('close', cancel);
  const videos = completedVideos(db, userId, signal);

  try {
    // Run the first query before starting the attachment so database errors
    // can still return a normal HTTP error.
    let next = await videos.next();
    signal.throwIfAborted();
    const zip = new ZipFile();
    zip.on('error', error => zip.outputStream.destroy(error));
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', 'attachment; filename="cmmtools-video-backup.zip"');
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const download = pipeline(zip.outputStream, res);
    // The browser can cancel while the loop is still awaiting a media source.
    download.catch(() => {});
    const unavailable = [];

    try {
      if (next.done) zip.addBuffer(Buffer.from('You have no completed videos to back up.\n'), 'README.txt');
      while (!next.done) {
        signal.throwIfAborted();
        const row = next.value;
        const name = encodeURIComponent(row.id);
        const prompt = Buffer.from(row.prompt || '', 'utf8');
        await appendFile(zip, Readable.from([prompt]), 'prompts/' + name + '.txt', signal, prompt.length);

        let video;
        try {
          video = await openVideo(db, row, signal);
        } catch {
          signal.throwIfAborted();
          unavailable.push(name);
        }
        if (video) await appendFile(zip, video.stream, 'videos/' + name + '.mp4', signal, video.size);
        next = await videos.next();
      }
      if (unavailable.length) {
        const notice = 'These video files could not be opened. Their prompts are included.\n\n' + unavailable.join('\n') + '\n';
        zip.addBuffer(Buffer.from(notice), 'unavailable-videos.txt');
      }
      zip.end();
      await download;
    } catch (error) {
      if (!signal.aborted) console.warn('[video-backup] Archive download interrupted.');
      // Once a ZIP entry starts streaming, a truncated video cannot be
      // removed. Fail the HTTP download instead of returning a damaged ZIP.
      zip.outputStream.destroy(error);
      await download.catch(() => {});
    }
  } finally {
    res.removeListener('close', cancel);
  }
}

module.exports = { sendVideoBackup };

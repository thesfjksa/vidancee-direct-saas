const test = require('node:test');
const assert = require('node:assert/strict');
const { argoMediaModels, isArgoModel } = require('../src/argolink_models.js');
const { quoteGateway, validateReferences } = require('../src/vercel_models.js');
const { ArgoLinkClient } = require('../src/provider/argolink.js');
const { ArgoLinkQueue } = require('../src/argolink_queue.js');

const discovered = argoMediaModels(require('../src/provider/argolink_catalog.json'));
// The stored row as serializeProviderModel returns it (options spread on top).
const model = id => {
  const d = discovered.find(m => m.providerModelId === id);
  assert.ok(d, id);
  return { ...d.options, providerModelId: d.providerModelId, publicModelId: d.publicModelId, label: d.label, mediaType: d.mediaType, provider: 'argolink' };
};
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const mp4 = seconds => { const b = Buffer.alloc(64); b.write('ftypisom', 4); b.write('mvhd', 24); b.writeUInt32BE(1000, 40); b.writeUInt32BE(seconds * 1000, 44); return b; };

test('the catalog snapshot becomes the major ArgoLink image and video models', () => {
  const ids = discovered.map(m => m.providerModelId).sort();
  assert.deepEqual(ids, ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'grok-imagine-image', 'grok-imagine-image-2.0',
    'grok-imagine-video-1.5', 'minimax-h3', 'nano-banana-2', 'nano-banana-2-lite', 'nano-banana-2.1', 'nano-banana-pro',
    'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini', 'seedance-2.5', 'wan-3', 'wan-3-prime']);
  assert.ok(discovered.every(m => isArgoModel(m.publicModelId) && m.options.adapterSupported));
  const s25 = model('seedance-2.5'), s20 = model('seedance-2.0');
  assert.deepEqual([s25.durations[0], s25.durations.at(-1)], [4, 30]);
  assert.deepEqual(s25.resolutions, ['480p', '720p', '1080p']);
  assert.deepEqual(s20.resolutions, ['480p', '720p', '1080p', '4k']);
  assert.equal(s25.adaptiveFrames, true);
  assert.equal(s20.adaptiveFrames, false);
  assert.deepEqual(s25.referenceCapabilities.image.roles, ['start_image', 'end_image', 'image_references']);
  assert.equal(s25.referenceCapabilities.video.max, 10);
  assert.equal(s25.supportsAudio, true);
  assert.deepEqual(model('minimax-h3').resolutions, ['768p', '2k']);
  assert.equal(model('minimax-h3').supportsAudio, false);
  assert.deepEqual(model('wan-3-prime').referenceCapabilities.image.roles, ['image_references']);
  assert.deepEqual([model('grok-imagine-video-1.5').durations[0], model('grok-imagine-video-1.5').durations.at(-1)], [1, 15]);
  assert.deepEqual(model('grok-imagine-image-2.0').imageSizes, ['1K', '1.5K', '2K']);
  assert.deepEqual(model('nano-banana-2-lite').imageSizes, ['1K']);
  assert.ok(!model('grok-imagine-image').aspectRatios.includes('auto'));
  assert.throws(() => argoMediaModels({ items: [] }), /no media models/);
});

test('quotes use ArgoLink USD prices, including billed reference video seconds', () => {
  const quote = (id, input) => quoteGateway(model(id), input, 1);
  assert.equal(quote('seedance-2.0', { duration: 10, resolution: '720p', aspectRatio: '16:9' }).sourceUsd.toFixed(3), '1.100');
  assert.equal(quote('seedance-2.0-mini', { duration: 4, resolution: '720p', aspectRatio: '16:9' }).sourceUsd.toFixed(3), '0.228');
  // A 3-second reference video adds 3 billed seconds; Seedance 2.5 bills every second at 0.598x.
  const withRef = quote('seedance-2.5', { duration: 5, resolution: '720p', aspectRatio: '16:9', videos: [{ data: mp4(3) }] });
  assert.equal(withRef.sourceUsd.toFixed(4), (8 * 0.196 * 0.598).toFixed(4));
  assert.equal(quote('seedance-2.0', { duration: 5, resolution: '720p', aspectRatio: '16:9', videos: [{ data: mp4(3) }] }).sourceUsd.toFixed(2), '0.88');
  assert.equal(quote('minimax-h3', { duration: 5, resolution: '2k', aspectRatio: '16:9' }).sourceUsd.toFixed(3), '0.320');
  assert.equal(quote('nano-banana-pro', { aspectRatio: '16:9', imageSize: '4K' }).sourceUsd, 0.03);
  assert.equal(quote('nano-banana-2', { aspectRatio: '1:1', imageSize: '4K' }).sourceUsd, 0.025);
  assert.equal(quote('grok-imagine-image-2.0', { aspectRatio: '1:1', imageSize: '1.5K' }).sourceUsd, 0.015);
  assert.equal(quote('gpt-image-2', { aspectRatio: '16:9', imageSize: '4K', quality: 'high' }).sourceUsd, 0.02);
  // Customer credits use the admin's credits-per-USD rate, rounded up.
  assert.equal(quoteGateway(model('gpt-image-2'), { aspectRatio: '1:1', imageSize: '1K' }, 6000).cost, 90);
  assert.throws(() => quote('seedance-2.0-fast', { duration: 5, resolution: '1080p', aspectRatio: '16:9' }), /Unsupported resolution/);
  assert.throws(() => validateReferences(model('nano-banana-2'), { images: [], videos: [{ data: mp4(3), mimeType: 'video/mp4' }] }), /Unsupported video references/);
});

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => { const call = { url, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null }; calls.push(call); return handler(call); };
  return { calls, impl };
}

test('image requests use each family\'s parameters and return the decoded image', async () => {
  const { calls, impl } = fakeFetch(call => Response.json({ data: [{ b64_json: png(call.body.size ? 2048 : 1536, call.body.size ? 1152 : 1024).toString('base64') }] }));
  const client = new ArgoLinkClient({ apiKey: 'argo-test-key', fetchImpl: impl });
  const gpt = await client.generateImage(model('gpt-image-2'), { prompt: 'A lighthouse', aspectRatio: '16:9', imageSize: '2K', quality: 'high' });
  assert.equal(gpt.mimeType, 'image/png');
  assert.equal(calls[0].url, 'https://argolink.io/v1/images/generations');
  assert.equal(calls[0].headers.authorization, 'Bearer argo-test-key');
  assert.equal(calls[0].body.size, '2048x1152');
  assert.equal(calls[0].body.quality, 'high');
  assert.match(calls[0].body.prompt, /^A lighthouse\n\nAspect ratio 16:9 composition\.$/);
  await client.generateImage(model('nano-banana-pro'), { prompt: 'A cat', aspectRatio: '3:2', imageSize: '2K' }, [{ url: 'https://app.example/a.png' }]);
  assert.equal(calls[1].url, 'https://argolink.io/v1/images/edits');
  assert.deepEqual([calls[1].body.aspect_ratio, calls[1].body.resolution, calls[1].body.size], ['3:2', '2k', undefined]);
  assert.deepEqual(calls[1].body.images, [{ image_url: 'https://app.example/a.png' }]);
  await client.generateImage(model('grok-imagine-image-2.0'), { prompt: 'A cat', aspectRatio: '3:2', imageSize: '1.5K' }, [{ url: 'https://app.example/a.png' }]);
  assert.deepEqual(calls[2].body.images, [{ type: 'image_url', image_url: { url: 'https://app.example/a.png' } }]);
  assert.equal(calls[2].body.resolution, '1.5k');
  // A wrong shape is refused (the queue refunds it) rather than saved.
  await assert.rejects(client.generateImage(model('nano-banana-2'), { prompt: 'x', aspectRatio: '9:16', imageSize: '1K' }), /different aspect ratio/);
});

test('video requests map frames and references per model and errors carry ArgoLink\'s reason', async () => {
  const client = new ArgoLinkClient({ apiKey: 'k' });
  const start = { role: 'start_image', url: 'https://app.example/s.png', mimeType: 'image/png' };
  const end = { role: 'end_image', url: 'https://app.example/e.png', mimeType: 'image/png' };
  const params = { prompt: 'Day to night', duration: 6, resolution: '720p', aspectRatio: '16:9', generateAudio: false };
  const s25 = client.videoBody(model('seedance-2.5'), params, [start, end]);
  assert.deepEqual([s25.start_image, s25.end_image, s25.aspect_ratio, s25.generate_audio], [{ url: start.url }, { url: end.url }, 'adaptive', false]);
  assert.equal(client.videoBody(model('seedance-2.0'), params, [start]).aspect_ratio, '16:9');
  const grok = client.videoBody(model('grok-imagine-video-1.5'), params, [start, end]);
  assert.deepEqual([grok.image, grok.last_frame, grok.start_image], [{ url: start.url }, { url: end.url }, undefined]);
  const refs = client.videoBody(model('minimax-h3'), { ...params, resolution: '768p' }, [
    { role: 'image_references', url: 'https://app.example/r.png', mimeType: 'image/png' }, { role: 'video', url: 'https://app.example/v.mp4', mimeType: 'video/mp4' }]);
  assert.deepEqual([refs.reference_images, refs.reference_videos, refs.generate_audio], [[{ url: 'https://app.example/r.png' }], [{ url: 'https://app.example/v.mp4' }], undefined]);
  assert.throws(() => client.videoBody(model('seedance-2.0'), params, [start, { role: 'video', url: 'https://x/v.mp4', mimeType: 'video/mp4' }]), /either frames or reference/);

  const { impl } = fakeFetch(call => call.url.endsWith('/generations')
    ? Response.json({ error: { code: 'request_unsupported', message: 'seedance-2.0-mini does not support video resolution 1080p' } }, { status: 400 })
    : Response.json({ code: 'INSUFFICIENT_BALANCE', message: 'no money' }, { status: 402 }));
  const failing = new ArgoLinkClient({ apiKey: 'k', fetchImpl: impl });
  await assert.rejects(failing.startVideo(model('seedance-2.0-mini'), params), /ArgoLink: seedance-2.0-mini does not support video resolution 1080p/);
  await assert.rejects(failing.videoStatus('abc'), /insufficient balance/);
});

test('the queue saves the request id, resumes polling and refunds failed jobs', async () => {
  const writes = [], refunds = [], completed = [];
  const db = { async execute(sql, args) { writes.push([sql, args]); return [{ affectedRows: 1 }]; } };
  const statuses = { a: { status: 'pending', progress: 30 }, b: { status: 'done' }, c: { status: 'failed', error: { message: 'Content review refused the prompt.' } } };
  const client = {
    startVideo: async () => 'req-123',
    videoStatus: async id => statuses[id],
    videoContent: async id => ({ data: Buffer.from('mp4-' + id), mimeType: 'video/mp4' }),
  };
  const queue = new ArgoLinkQueue({ getModel: async () => ({ ...model('seedance-2.0'), ready: true }), refund: async (...a) => refunds.push(a) });
  queue.references = async () => [];
  queue.complete = async (_db, job, output) => completed.push([job.id, output.data.toString()]);
  const options = JSON.stringify({ model: model('seedance-2.0'), duration: 5, resolution: '720p', aspectRatio: '16:9' });
  await queue.submit(db, { id: 'g1', model: 'argo_seedance_2_0', media_type: 'video', prompt: 'x', generation_options: options }, client);
  assert.match(writes[0][0], /status='submitted',provider_operation=\?,provider_job_id=\?/);
  assert.deepEqual(writes[0][1], ['{"requestId":"req-123"}', 'req-123', 'g1']);

  const job = id => ({ id: 'g-' + id, provider_operation: JSON.stringify({ requestId: id }), generation_options: options });
  await queue.pollJob(db, client, job('a'));
  assert.match(writes[1][0], /SET status='processing'/);
  await queue.pollJob(db, client, job('b'));
  assert.deepEqual(completed, [['g-b', 'mp4-b']]);
  await queue.pollJob(db, client, job('c'));
  assert.equal(refunds[0][0], 'g-c');
  assert.match(refunds[0][2], /Content review refused the prompt\. Credits were refunded\.$/);
  assert.equal(queue.provider, 'argolink');
  assert.equal(queue.apiKey({ argoLinkApiKey: 'z', vercelApiKey: 'v' }), 'z');
  assert.ok(queue.videoTimeoutMs > 45 * 60 * 1000);
});

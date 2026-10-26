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

test('HD enhancement: ArgoLink renders low, fal upscales, and a failed upscale refunds only its part', async () => {
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const { argoVideoView, hdPlan } = require('../src/argo_hd.js');
  // Display resolutions and their renders.
  // With fal both resolutions are delivered as 1080p: 720p from a 480p render, 1080p from 720p.
  assert.deepEqual(hdPlan(['480p', '720p', '1080p'], '720p', true), { source: '480p', upscale: true, target: '1080p' });
  assert.deepEqual(hdPlan(['480p', '720p', '1080p'], '1080p', true), { source: '720p', upscale: true, target: '1080p' });
  assert.deepEqual(hdPlan(['768p', '2k'], '720p', true), { source: '768p', upscale: true, target: '1080p' });
  assert.deepEqual(hdPlan(['480p', '720p', '1080p'], '720p', false), { source: '720p', upscale: false });
  assert.deepEqual(hdPlan(['480p', '720p'], '1080p', false), null);
  assert.deepEqual(argoVideoView(model('seedance-2.0'), true).resolutions, ['720p', '1080p']);
  // HD enhancement off for a model: its own resolutions, rendered as they are.
  const raw = argoVideoView(model('seedance-2.0'), true, { hd: false });
  assert.deepEqual(raw.resolutions, model('seedance-2.0').resolutions);
  assert.ok(Object.values(raw.hdPlans).every(p => !p.upscale));
  const { quoteArgoVideo } = require('../src/argo_hd.js');
  const prices = { argoLinkCustomerCreditsPerUsd: 1000, falEnabled: true, falApiKey: 'k', falCustomerCreditsPerUsd: 1000 };
  const req = { resolution: '720p', duration: 5, aspectRatio: '9:16' };
  const hdQuote = quoteArgoVideo(model('seedance-2.0'), req, prices);
  const rawQuote = quoteArgoVideo(model('seedance-2.0'), req, prices, { hd: false });
  assert.equal(hdQuote.sourceResolution, '480p'); assert.ok(hdQuote.enhance);
  assert.equal(rawQuote.sourceResolution, '720p'); assert.equal(rawQuote.enhance, null);
  assert.equal(rawQuote.cost, quoteArgoVideo(model('seedance-2.0'), req, { ...prices, falEnabled: false }).cost);

  const sql = [];
  let row = { user_id: 9, status: 'processing', refunded_at: null, credits_cost: 3000 };
  const conn = { async execute(text, args) { sql.push([text.replace(/\s+/g, ' '), args]); if (text.includes('FOR UPDATE')) return [[row]]; return [{ affectedRows: 1 }]; },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  const qdb = { getConnection: async () => conn, execute: conn.execute };
  const plan = { path: 'fal-ai/bytedance-upscaler/upscale/video', input: { target_resolution: '1080p', enhancement_preset: 'general', fidelity: 'high', target_fps: 24 }, usd: 0.036 };
  const options = { model: model('seedance-2.5'), duration: 5, resolution: '1080p', sourceResolution: '720p', aspectRatio: '9:16', enhance: { sourceResolution: '720p', upscale: plan, credits: 216 } };
  const job = { id: 'v1', media_type: 'video', model: 'argo_seedance_2_5', prompt: 'A fox', generation_options: JSON.stringify(options), provider_operation: JSON.stringify({ requestId: 'r1' }) };
  const falCalls = [];
  let falState = { state: 'pending' };
  const fal = { submit: async (path, input) => { falCalls.push([path, input]); return { requestId: 'f1', statusUrl: 'https://queue.fal.run/x/requests/f1/status', responseUrl: 'https://queue.fal.run/x/requests/f1' }; },
    check: async () => falState, download: async () => ({ data: Buffer.from('ftypHD'), mimeType: 'video/mp4' }) };
  const { ArgoLinkQueue } = require('../src/argolink_queue.js');
  const queue = new ArgoLinkQueue({ falFactory: () => fal });
  queue.settings = { falEnabled: true, falApiKey: 'k' };
  const argo = { videoStatus: async () => ({ status: 'done' }), videoContent: async () => ({ data: Buffer.from('ftyp480'), mimeType: 'video/mp4' }),
    startVideo: async (_m, params) => { argo.started = params.resolution; return 'r1'; } };

  // The render is requested at the source resolution.
  queue.getModel = async () => ({ ...model('seedance-2.5'), ready: true }); queue.references = async () => [];
  await queue.submit({ execute: async () => [{ affectedRows: 1 }] }, { ...job, status: 'submitting' }, argo);
  assert.equal(argo.started, '720p');

  // ArgoLink done: render stored, upscale started from the signed link, job stays processing.
  await queue.pollJob(qdb, argo, job);
  assert.ok(sql.some(([t]) => t.startsWith('INSERT INTO generation_video_outputs')));
  assert.ok(!sql.some(([t]) => t.includes("status='completed'")));
  assert.equal(falCalls[0][0], plan.path);
  assert.match(falCalls[0][1].video_url, /^https:\/\/cmmtools\.site\/provider-outputs\/v1\?sig=/);
  assert.equal(falCalls[0][1].target_resolution, '1080p');
  const op = JSON.parse(sql.at(-1)[1][0]);
  assert.deepEqual([op.stage, op.fal.requestId], ['enhance', 'f1']);

  // Upscale done: the upscaled video replaces the render and the job completes.
  sql.length = 0; falState = { state: 'done', url: 'https://v3.fal.media/hd.mp4' };
  await queue.pollJob(qdb, argo, { ...job, provider_operation: JSON.stringify(op) });
  assert.ok(sql.some(([t]) => t.startsWith('DELETE FROM generation_video_chunks')));
  assert.equal(sql.find(([t]) => t.includes('INSERT INTO generation_video_chunks'))[1][2].toString(), 'ftypHD');
  assert.ok(sql.some(([t,args]) => t.includes("SET status='completed',output_url=?") && args[0]==='db:video'));

  // Upscale failed: the render is delivered and only the 216 upscale credits are refunded.
  sql.length = 0; falState = { state: 'failed', error: 'busy' };
  await queue.pollJob(qdb, argo, { ...job, provider_operation: JSON.stringify(op) });
  const done = sql.find(([t]) => t.includes('credits_cost=credits_cost-?'));
  assert.equal(done[1][0], 216);
  assert.match(done[1][1], /original resolution\. 216 credits were refunded\./);
  assert.deepEqual(sql.find(([t]) => t.startsWith('UPDATE users SET credits'))[1], [216, 9]);
  assert.equal(sql.find(([t]) => t.includes('INSERT INTO credit_transactions'))[1][2], 216);

  // Without a fal key the render is delivered the same way.
  sql.length = 0; queue.settings = {};
  await queue.pollJob(qdb, argo, job);
  assert.ok(sql.some(([t]) => t.includes('credits_cost=credits_cost-?')));
});

test('a retryable ArgoLink failure is resubmitted once, then refunded', async () => {
  const { ArgoLinkQueue } = require('../src/argolink_queue.js');
  const writes = [], refunds = [];
  const qdb = { async execute(sql, args) { writes.push([sql, args]); return [{ affectedRows: 1 }]; } };
  const queue = new ArgoLinkQueue({ refund: async (...a) => refunds.push(a) });
  queue.getModel = async () => ({ ...model('seedance-2.5'), ready: true }); queue.references = async () => [];
  let started = 0;
  const failed = retryable => ({ videoStatus: async () => ({ status: 'failed', error: { code: 'generation_failed', message: 'The result could not be generated.', retryable } }),
    startVideo: async (_m, params) => { started++; assert.equal(params.resolution, '480p'); return 'r2'; } });
  const options = JSON.stringify({ model: model('seedance-2.5'), duration: 5, resolution: '720p', sourceResolution: '480p', aspectRatio: '9:16' });
  const job = { id: 'j1', media_type: 'video', model: 'argo_seedance_2_5', prompt: 'p', generation_options: options, provider_operation: JSON.stringify({ requestId: 'r1' }) };

  await queue.pollJob(qdb, failed(true), job);
  assert.deepEqual([started, refunds.length], [1, 0]);
  assert.deepEqual(JSON.parse(writes.at(-1)[1][0]), { requestId: 'r2', retried: true, firstRequestId: 'r1' });
  // The second failure is refunded, and so is a failure ArgoLink does not mark retryable.
  await queue.pollJob(qdb, failed(true), { ...job, provider_operation: writes.at(-1)[1][0] });
  await queue.pollJob(qdb, failed(false), job);
  assert.deepEqual([started, refunds.length], [1, 2]);
  assert.match(refunds[0][2], /The result could not be generated\. Credits were refunded\./);
});

test('Seedance references are uploaded to ArgoLink storage; a failed upload keeps the signed links', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.method, init.headers?.['content-type'], init.body]);
    if (url.endsWith('/v1/media/uploads')) return new Response(JSON.stringify({ upload_url: 'https://store.argolink.io/put/1', media_url: 'https://media.argolink.io/1.png' }), { status: 200 });
    return new Response('', { status: 200 });
  };
  const client = new ArgoLinkClient({ apiKey: 'k', fetchImpl });
  const image = png(1122, 1402);
  assert.equal(await client.uploadMedia(model('seedance-2.5'), { data: image, mimeType: 'image/png' }), 'https://media.argolink.io/1.png');
  assert.deepEqual(JSON.parse(calls[0][3]), { model: 'seedance-2.5', type: 'image', content_type: 'image/png', size_bytes: image.length });
  assert.deepEqual(calls[1].slice(0, 3), ['https://store.argolink.io/put/1', 'PUT', 'image/png']);
  assert.equal(calls[1][3], image);

  const logs = [], sent = [];
  const db = { async execute(sql) {
    if (sql.includes('media_data FROM generation_media')) return [[{ position_index: 0, media_kind: 'image', mime_type: 'image/png', media_data: image }]];
    return [{ affectedRows: 1 }];
  } };
  const queue = new ArgoLinkQueue({ getModel: async () => ({ ...model('seedance-2.5'), ready: true }) });
  queue.log = (_job, event) => logs.push(event);
  queue.references = async () => [{ url: 'https://cmmtools.site/provider-media/g1/0?sig=x', mimeType: 'image/png', role: 'image_references' }];
  const options = JSON.stringify({ model: model('seedance-2.5'), duration: 5, resolution: '720p', sourceResolution: '480p', aspectRatio: '9:16' });
  const job = { id: 'g1', model: 'argo_seedance_2_5', media_type: 'video', prompt: 'x', generation_options: options };
  const argo = upload => ({ uploadMedia: upload, videoBody: () => ({}), startVideo: async (_m, _p, refs) => { sent.push(refs.map(r => r.url)); return 'r1'; } });
  await queue.submit(db, job, argo(async () => 'https://media.argolink.io/1.png'));
  await queue.submit(db, job, argo(async () => { throw new Error('ArgoLink storage rejected the upload (HTTP 403).'); }));
  assert.deepEqual(sent, [['https://media.argolink.io/1.png'], ['https://cmmtools.site/provider-media/g1/0?sig=x']]);
  assert.ok(logs.includes('argolink.upload') && logs.includes('argolink.upload_failed'));
});

test('two worker processes polling the same job act on it only once', async () => {
  const { ArgoLinkQueue } = require('../src/argolink_queue.js');
  const held = new Set();
  const row = { id: 'j9', status: 'processing', refunded_at: null, media_type: 'video', provider_operation: JSON.stringify({ requestId: 'r1' }) };
  const conn = () => ({
    async query(sql, args) {
      if (sql.startsWith('SELECT GET_LOCK')) { if (held.has(args[0])) return [[{ acquired: 0 }]]; held.add(args[0]); return [[{ acquired: 1 }]]; }
      if (sql.startsWith('SELECT RELEASE_LOCK')) { held.delete(args[0]); return [[{}]]; }
      if (sql.startsWith('SELECT * FROM generations')) return [[row]];
      throw new Error(sql);
    }, release() {} });
  const db = { getConnection: async () => conn() };
  const queue = new ArgoLinkQueue();
  let polls = 0, release;
  const gate = new Promise(r => { release = r; });
  queue.pollJob = async () => { polls++; await gate; };
  const first = queue.exclusive(db, row, fresh => queue.pollJob(db, null, fresh));
  const second = queue.exclusive(db, row, fresh => queue.pollJob(db, null, fresh));
  await new Promise(r => setImmediate(r));
  release(); await Promise.all([first, second]);
  assert.equal(polls, 1);
  assert.equal(held.size, 0);
  // A job finished by the other process is left alone.
  row.status = 'completed';
  await queue.exclusive(db, row, () => { polls++; });
  assert.equal(polls, 1);
});

test('Seedance 2.5 renders on fal.ai while ArgoLink is out of credits, then continues to HD enhancement', async () => {
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const { falSeedanceRequest, falSeedanceUsd, FAL_SEEDANCE_25 } = require('../src/seedance_fal.js');
  const ref = (role, mimeType, n) => ({ role, mimeType, url: 'https://cmmtools.site/provider-media/g/' + n + '?sig=s' });
  const params = { prompt: 'A fox', resolution: '480p', duration: 5, aspectRatio: '9:16', generateAudio: false };

  // One fal endpoint per request shape; duration is fal's string enum and audio is explicit.
  assert.deepEqual(falSeedanceRequest(params, []), { path: FAL_SEEDANCE_25.text,
    input: { prompt: 'A fox', resolution: '480p', duration: '5', generate_audio: false, codec: 'H264', aspect_ratio: '9:16' } });
  const frames = falSeedanceRequest(params, [ref('start_image', 'image/png', 0), ref('end_image', 'image/png', 1)]);
  assert.equal(frames.path, 'bytedance/seedance-2.5/image-to-video');
  assert.deepEqual([frames.input.image_url, frames.input.end_image_url, frames.input.aspect_ratio], [ref('', '', 0).url, ref('', '', 1).url, undefined]);
  const refs = falSeedanceRequest({ ...params, aspectRatio: '5:4' }, [ref('image_references', 'image/jpeg', 0), ref('video', 'video/mp4', 1)]);
  assert.equal(refs.path, 'bytedance/seedance-2.5/reference-to-video');
  assert.deepEqual([refs.input.image_urls, refs.input.video_urls, refs.input.aspect_ratio], [[ref('', '', 0).url], [ref('', '', 1).url], 'auto']);
  assert.throws(() => falSeedanceRequest(params, [ref('start_image', 'image/png', 0), ref('image_references', 'image/png', 1)]), /either frames or reference files/);
  // fal's estimate follows ArgoLink's quote for the same seconds: 5 s at 480p is 5 x $0.2205.
  assert.equal(falSeedanceUsd(model('seedance-2.5'), { resolution: '480p', renderUsd: 5 * 0.0874 }).toFixed(4), (5 * 0.2205).toFixed(4));

  const writes = [], refunds = [], falCalls = [], marks = [];
  const conn = { async execute(text, args) { writes.push([text.replace(/\s+/g, ' '), args]); if (text.includes('FOR UPDATE')) return [[{ status: 'processing', refunded_at: null }]];
    if (text.includes('media_data FROM generation_media')) return [[{ position_index: 0, mime_type: 'image/png', media_data: Buffer.from('png') }]]; return [{ affectedRows: 1 }]; },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  const db = { getConnection: async () => conn, execute: conn.execute };
  let falState = { state: 'pending' };
  const fal = { submit: async (path, input) => { falCalls.push([path, input]); return { requestId: 'f' + falCalls.length, statusUrl: 'https://queue.fal.run/x/requests/f/status', responseUrl: 'https://queue.fal.run/x/requests/f' }; },
    check: async () => falState, download: async () => ({ data: Buffer.from('ftypfal'), mimeType: 'video/mp4' }) };
  let out = false;
  const credits = { isOut: () => out, markOut: source => { marks.push(source); out = true; } };
  const queue = new ArgoLinkQueue({ falFactory: () => fal, credits, refund: async (...a) => refunds.push(a) });
  queue.settings = { falEnabled: true, falApiKey: 'k' };
  queue.log = () => {};
  queue.getModel = async () => ({ ...model('seedance-2.5'), ready: true });
  queue.references = async () => [ref('image_references', 'image/png', 0)];
  const upscale = { path: 'fal-ai/bytedance-upscaler/upscale/video', input: { target_resolution: '1080p' }, usd: 0.036 };
  const options = { model: model('seedance-2.5'), duration: 5, resolution: '720p', sourceResolution: '480p', aspectRatio: '9:16', renderUsd: 5 * 0.0874, enhance: { upscale, credits: 218 } };
  const job = { id: 'g1', user_id: 3, model: 'argo_seedance_2_5', media_type: 'video', prompt: 'A fox', status: 'submitting', generation_options: JSON.stringify(options) };
  let argoStarts = 0;
  const broke = { uploadMedia: async () => 'https://media.argolink.io/1.png', videoBody: () => ({}),
    startVideo: async () => { argoStarts++; throw Object.assign(new Error('ArgoLink has insufficient balance.'), { providerStatus: 402 }); } };

  // ArgoLink refuses for balance: ArgoLink is marked out and the same request goes to fal, with the
  // files from ArgoLink's storage (Seedance cannot fetch the app's signed links, on fal either).
  await queue.submit(db, job, broke);
  assert.deepEqual([argoStarts, marks], [1, ['argolink']]);
  assert.equal(falCalls[0][0], 'bytedance/seedance-2.5/reference-to-video');
  assert.deepEqual(falCalls[0][1].image_urls, ['https://media.argolink.io/1.png']);
  assert.equal(falCalls[0][1].resolution, '480p');
  const saved = writes.at(-1);
  assert.match(saved[0], /SET status='submitted',provider_operation=\?/);
  assert.deepEqual(JSON.parse(saved[1][0]), { stage: 'fal', fal: { requestId: 'f1', statusUrl: 'https://queue.fal.run/x/requests/f/status', responseUrl: 'https://queue.fal.run/x/requests/f' }, path: falCalls[0][0] });
  assert.equal(saved[1][2].toFixed(4), (5 * 0.2205 + 0.036).toFixed(4));

  // While ArgoLink is marked out, the next Seedance 2.5 job skips it (its files are still uploaded).
  await queue.submit(db, job, broke);
  assert.deepEqual([argoStarts, falCalls.length], [1, 2]);
  assert.deepEqual(falCalls[1][1].image_urls, ['https://media.argolink.io/1.png']);
  // If the upload fails, fal gets the signed links rather than no job at all.
  await queue.submit(db, job, { ...broke, uploadMedia: async () => { throw new Error('upload down'); } });
  assert.deepEqual(falCalls[2][1].image_urls, [ref('', '', 0).url]);
  falCalls.pop();

  // Other models keep ArgoLink's refusal (the job is refunded as before), and without fal so does Seedance 2.5.
  out = false;
  queue.getModel = async () => ({ ...model('seedance-2.0'), ready: true });
  await assert.rejects(queue.submit(db, { ...job, generation_options: JSON.stringify({ ...options, model: model('seedance-2.0') }) }, broke), /insufficient balance/);
  queue.getModel = async () => ({ ...model('seedance-2.5'), ready: true });
  queue.settings = {}; out = false;
  await assert.rejects(queue.submit(db, job, broke), /insufficient balance/);
  assert.equal(falCalls.length, 2);
  queue.settings = { falEnabled: true, falApiKey: 'k' };

  // A job ArgoLink fails later for lack of balance moves to fal too.
  out = false; marks.length = 0;
  const lateFail = { uploadMedia: broke.uploadMedia, videoStatus: async () => ({ status: 'failed', error: { code: 'insufficient_balance', message: 'Wallet balance too low.', retryable: true } }) };
  await queue.pollJob(db, lateFail, { ...job, status: 'submitted', provider_operation: JSON.stringify({ requestId: 'r1' }) });
  assert.deepEqual([marks, falCalls.length, refunds.length], [['argolink'], 3, 0]);
  assert.deepEqual(falCalls[2][1].image_urls, ['https://media.argolink.io/1.png']);

  // If fal refuses that job too, it is refunded instead of being retried on every poll.
  const refusing = { ...fal, submit: async () => { throw new Error('fal.ai has insufficient balance.'); } };
  const strict = new ArgoLinkQueue({ falFactory: () => refusing, credits, refund: async (...a) => refunds.push(a) });
  Object.assign(strict, { settings: queue.settings, log: () => {}, references: queue.references });
  await strict.pollJob(db, lateFail, { ...job, status: 'submitted', provider_operation: JSON.stringify({ requestId: 'r1' }) });
  assert.equal(refunds.length, 1);
  assert.match(refunds[0][2], /Wallet balance too low\. Credits were refunded\.$/);
  refunds.length = 0;

  // Polling the fal render: pending, then done -> stored and handed to the HD upscaler.
  const falJob = { ...job, status: 'submitted', provider_operation: JSON.stringify({ stage: 'fal', fal: { requestId: 'f1', statusUrl: 'https://queue.fal.run/x/requests/f/status' } }) };
  writes.length = 0;
  await queue.pollJob(db, null, falJob);
  assert.match(writes[0][0], /SET status='processing'/);
  falState = { state: 'done', url: 'https://v3.fal.media/out.mp4' };
  await queue.pollJob(db, null, falJob);
  assert.ok(writes.some(([t]) => t.startsWith('INSERT INTO generation_video_outputs')));
  assert.equal(falCalls.at(-1)[0], upscale.path);
  assert.match(falCalls.at(-1)[1].video_url, /\/provider-outputs\/g1\?sig=/);
  assert.equal(JSON.parse(writes.at(-1)[1][0]).stage, 'enhance');

  // Without HD enhancement the render completes the job; a failed render is refunded with fal's reason.
  writes.length = 0;
  await queue.pollJob(db, null, { ...falJob, generation_options: JSON.stringify({ ...options, enhance: null }) });
  assert.ok(writes.some(([t]) => t.includes("SET status='completed',output_url=?")));
  falState = { state: 'failed', error: 'Content flagged' };
  await queue.pollJob(db, null, falJob);
  assert.match(refunds[0][2], /Content flagged\. Credits were refunded\.$/);
});

test('prompt limits: a provider\'s stated limit, otherwise the app maximum', () => {
  const { promptLimit } = require('../src/vercel_models.js');
  // Seedance on ArgoLink states no limit; 8,000 was the app's old default.
  assert.equal(promptLimit({ provider: 'argolink', inputLimits: { text: { max_chars: 8000 } } }), 50000);
  assert.equal(promptLimit({ provider: 'argolink', inputLimits: { text: { max_chars: 7000 } } }), 7000);
  assert.equal(promptLimit({ provider: 'argolink', inputLimits: { text: { max_chars: 20000 } } }), 20000);
  assert.equal(promptLimit({}), 50000);
  // 888API states no limit; 4,096 was the app's old value for every 888API model.
  assert.equal(promptLimit({ provider: 'api888', inputLimits: { text: { max_chars: 4096 } } }), 20000);
  assert.equal(promptLimit({ provider: 'api888', inputLimits: { text: { max_chars: 20000 } } }), 20000);
  assert.equal(promptLimit({ provider: 'api888', providerModelId: 'seedance2.5-301010-wool', inputLimits: { text: { max_chars: 20000 } } }), 8000);
  assert.equal(promptLimit({ provider: 'api888', providerModelId: 'seedance2.5-301010-wool-1080p', inputLimits: { text: { max_chars: 4096 } } }), 8000);
});

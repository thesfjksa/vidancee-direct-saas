const test = require('node:test');
const assert = require('node:assert/strict');
const { yottaMediaModels, isYottaModel } = require('../src/yotta_models.js');
const { yottaVideoView, quoteArgoVideo } = require('../src/argo_hd.js');
const { YottaClient } = require('../src/provider/yotta.js');

const discovered = yottaMediaModels(require('../src/provider/yotta_catalog.json'));
// The stored row as serializeProviderModel returns it (options spread on top).
const model = key => {
  const d = discovered.find(m => m.providerModelId === key);
  assert.ok(d, key);
  return { ...d.options, providerModelId: d.providerModelId, publicModelId: d.publicModelId, label: d.label, mediaType: d.mediaType, provider: 'yotta' };
};
const settings = fal => ({ falEnabled: fal, falApiKey: fal ? 'k' : '', falCustomerCreditsPerUsd: 6720, yottaCustomerCreditsPerUsd: 6720 });
const quote = (m, resolution, fal = true, extra = {}) => quoteArgoVideo(m, { duration: 5, resolution, aspectRatio: '16:9', ...extra }, settings(fal), { view: yottaVideoView, creditsPerUsd: 6720, ...extra.opts });

test('the Yotta catalog snapshot becomes Wan 3.0 and Wan 2.7 for Video Studio', () => {
  assert.deepEqual(discovered.map(m => m.publicModelId), ['yotta_wan_3_0', 'yotta_wan_2_7']);
  assert.ok(discovered.every(m => isYottaModel(m.publicModelId) && m.options.adapterSupported));
  const w3 = model('wan3.0'), w27 = model('wan2.7');
  assert.deepEqual([w3.resolutions, w3.durations[0], w3.durations.at(-1), w3.supportsAudio], [['480p', '720p', '1080p'], 2, 30, true]);
  assert.deepEqual([w27.resolutions, w27.durations.at(-1), w27.supportsAudio], [['720p', '1080p'], 15, false]);
  assert.deepEqual(w3.aspectRatios, ['16:9', '9:16', '1:1', '4:3', '3:4']);
  assert.deepEqual(w3.referenceCapabilities.image.roles, ['start_image', 'image_references']);
  assert.deepEqual(w3.yotta, { t2v: 'wan3.0-t2v', i2v: 'wan3.0-i2v', r2v: 'wan3.0-r2v', framesAspectRatio: true });
  assert.equal(w27.yotta.framesAspectRatio, false);
  // Yotta's current per-second prices.
  assert.deepEqual(w27.pricing.video_duration_pricing.map(t => [t.resolution, t.cost_per_second]), [['720p', 0.055], ['1080p', 0.0825]]);
  assert.equal(w3.pricing.video_duration_pricing.find(t => t.resolution === '480p' && t.audio === false).cost_per_second, 0.035);
});

test('480p renders natively; 720p and 1080p render lower and are upscaled by fal', () => {
  const w3 = model('wan3.0'), w27 = model('wan2.7');
  assert.deepEqual(yottaVideoView(w3, true).hdPlans, {
    '480p': { source: '480p', upscale: false },
    '720p': { source: '480p', upscale: true, target: '1080p' },
    '1080p': { source: '720p', upscale: true, target: '1080p' },
  });
  // Wan 2.7 has no 480p render: 720p is native, 1080p comes from 720p.
  assert.deepEqual(yottaVideoView(w27, true).hdPlans, { '720p': { source: '720p', upscale: false }, '1080p': { source: '720p', upscale: true, target: '1080p' } });
  // Without fal (or with HD enhance off) every resolution is rendered as chosen.
  assert.deepEqual(Object.values(yottaVideoView(w3, false).hdPlans).map(p => p.source), ['480p', '720p', '1080p']);
  assert.deepEqual(Object.values(yottaVideoView(w3, true, { hd: false }).hdPlans).every(p => !p.upscale), true);
  // 5 s 16:9, 6,720 credits per USD: 480p $0.175; 720p = 480p render + $0.036 upscale; 1080p = 720p render + upscale.
  assert.deepEqual(['480p', '720p', '1080p'].map(r => quote(w3, r).cost), [1176, 1176 + 242, 2352 + 242]);
  assert.deepEqual(['480p', '720p', '1080p'].map(r => quote(w3, r, false).cost), [1176, 2352, 4704]);
  assert.deepEqual(['720p', '1080p'].map(r => quote(w27, r).cost), [1848, 1848 + 242]);
  const q = quote(w3, '1080p');
  assert.deepEqual([q.resolution, q.sourceResolution, q.enhance.upscale.input.target_resolution], ['1080p', '720p', '1080p']);
  assert.throws(() => quote(w27, '480p'), /Unsupported resolution/);
});

test('Yotta requests use the text, image or reference route and report Yotta\'s answer', async () => {
  const w3 = model('wan3.0'), w27 = model('wan2.7');
  const client = new YottaClient({ apiKey: 'k' });
  const params = { prompt: 'A kite', resolution: '480p', duration: 5, aspectRatio: '9:16', generateAudio: true };
  const ref = (role, n) => ({ role, mimeType: 'image/png', url: 'https://cmmtools.site/provider-media/g/' + n + '?sig=s' });
  assert.deepEqual(client.videoRequest(w3, params, []), { category: 'text-to-video',
    body: { model: 'wan3.0-t2v', parameters: { prompt: 'A kite', resolution: '480p', duration: 5, enhance_prompt: false, generate_audio: true, aspect_ratio: '9:16' } } });
  const frame = client.videoRequest(w3, params, [ref('start_image', 0)]);
  assert.deepEqual([frame.category, frame.body.model, frame.body.parameters.first_frame, frame.body.parameters.aspect_ratio], ['image-to-video', 'wan3.0-i2v', ref('', 0).url, 'adaptive']);
  const frame27 = client.videoRequest(w27, { ...params, resolution: '720p' }, [ref('start_image', 0)]);
  assert.deepEqual([frame27.body.model, 'aspect_ratio' in frame27.body.parameters, 'generate_audio' in frame27.body.parameters], ['wan2.7-i2v', false, false]);
  const refs = client.videoRequest(w3, params, [ref('image_references', 0), ref('image_references', 1)]);
  assert.deepEqual([refs.category, refs.body.model, refs.body.parameters.reference_items], ['reference-to-video', 'wan3.0-r2v', [{ url: ref('', 0).url, type: 'image' }, { url: ref('', 1).url, type: 'image' }]]);
  assert.throws(() => client.videoRequest(w3, params, [ref('start_image', 0), ref('image_references', 1)]), /either a start frame or reference images/);

  const calls = [];
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let next = () => answer(200, { code: 10000, message: 'success', data: { request_id: 'req-1' } });
  const api = new YottaClient({ apiKey: 'k', fetchImpl: async (url, init) => { calls.push([url, init.method, init.headers['X-API-KEY'], init.body && JSON.parse(init.body)]); return next(); } });
  assert.deepEqual(await api.startVideo(w3, params, []), { requestId: 'req-1', category: 'text-to-video' });
  assert.deepEqual(calls[0].slice(0, 3), ['https://gateway.yottalabs.ai/api/maas/text-to-video/generations', 'POST', 'k']);
  next = () => answer(200, { code: 10000, data: { status: 'processing' } });
  assert.deepEqual(await api.videoStatus({ requestId: 'req-1', category: 'text-to-video' }), { status: 'pending' });
  assert.equal(calls[1][0], 'https://gateway.yottalabs.ai/api/maas/text-to-video/generations/req-1');
  next = () => answer(200, { code: 10000, data: { status: 'completed', output_url: 'https://cdn.yotta.example/v.mp4', duration: 5 } });
  assert.deepEqual(await api.videoStatus({ requestId: 'req-1', category: 'text-to-video' }), { status: 'done', url: 'https://cdn.yotta.example/v.mp4' });
  next = () => answer(200, { code: 10000, data: { status: 'failed', error_message: 'Content moderation' } });
  assert.deepEqual(await api.videoStatus({ requestId: 'req-1', category: 'text-to-video' }), { status: 'failed', error: 'Content moderation' });
  next = () => answer(401, { code: 10003, message: 'unauthorized', data: null });
  await assert.rejects(api.startVideo(w3, params, []), /Yotta rejected the API key/);
  await assert.rejects(api.verifyKey(), /rejected the API key/);
  next = () => answer(200, { code: 10001, message: 'duration out of range', data: null });
  await assert.rejects(api.startVideo(w3, params, []), /Yotta: duration out of range/);
  // A good key: an unknown request is not an authorization failure.
  next = () => answer(200, { code: 50000, message: 'request not exist', data: null });
  assert.equal(await api.verifyKey(), true);
});

test('the Yotta queue saves the request, then stores, upscales or refunds the result', async () => {
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const { YottaQueue } = require('../src/yotta_queue.js');
  const sql = [], refunds = [], falCalls = [];
  const conn = { async execute(text, args) { sql.push([text.replace(/\s+/g, ' '), args]); if (text.includes('FOR UPDATE')) return [[{ status: 'processing', refunded_at: null }]]; return [{ affectedRows: 1 }]; },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  const db = { getConnection: async () => conn, execute: conn.execute };
  const fal = { submit: async (path, input) => { falCalls.push([path, input]); return { requestId: 'f1', statusUrl: 'https://queue.fal.run/x/requests/f1/status', responseUrl: 'https://queue.fal.run/x/requests/f1' }; } };
  const queue = new YottaQueue({ falFactory: () => fal, refund: async (...a) => refunds.push(a) });
  Object.assign(queue, { settings: { falEnabled: true, falApiKey: 'k' }, log: () => {}, references: async () => [], getModel: async () => ({ ...model('wan3.0'), ready: true }) });
  assert.deepEqual([queue.provider, queue.apiKey({ yottaApiKey: 'y', argoLinkApiKey: 'a' }), queue.sourceEnabled({ yottaEnabled: true })], ['yotta', 'y', true]);
  const w3 = model('wan3.0');
  const options = { ...quote(w3, '720p'), model: w3 };
  const job = { id: 'g1', user_id: 2, model: 'yotta_wan_3_0', media_type: 'video', prompt: 'A kite', status: 'submitting', generation_options: JSON.stringify(options) };
  let started;
  let status = { status: 'pending' };
  const client = { videoRequest: () => null, startVideo: async (_m, params) => { started = params; return { requestId: 'req-9', category: 'text-to-video' }; },
    videoStatus: async () => status, download: async () => ({ data: Buffer.from('ftypyotta'), mimeType: 'video/mp4' }) };

  // 720p is rendered at 480p; the request is saved before the first poll.
  await queue.submit(db, job, client);
  assert.equal(started.resolution, '480p');
  assert.match(sql.at(-1)[0], /SET status='submitted',provider_operation=\?/);
  assert.deepEqual(JSON.parse(sql.at(-1)[1][0]), { requestId: 'req-9', category: 'text-to-video' });

  const polled = { ...job, status: 'submitted', provider_operation: JSON.stringify({ requestId: 'req-9', category: 'text-to-video' }) };
  sql.length = 0;
  await queue.pollJob(db, client, polled);
  assert.match(sql[0][0], /SET status='processing'/);
  // Done: the render is stored and handed to fal for the 1080p upscale.
  status = { status: 'done', url: 'https://cdn.yotta.example/v.mp4' };
  await queue.pollJob(db, client, polled);
  assert.ok(sql.some(([t]) => t.startsWith('INSERT INTO generation_video_outputs')));
  assert.equal(falCalls[0][0], options.enhance.upscale.path);
  assert.match(falCalls[0][1].video_url, /\/provider-outputs\/g1\?sig=/);
  assert.equal(JSON.parse(sql.at(-1)[1][0]).stage, 'enhance');
  // 480p needs no upscale: the render completes the job.
  sql.length = 0;
  await queue.pollJob(db, client, { ...polled, generation_options: JSON.stringify({ ...quote(w3, '480p'), model: w3 }) });
  assert.ok(sql.some(([t]) => t.includes("SET status='completed',output_url=?")));
  // A failed job is refunded with Yotta's reason.
  status = { status: 'failed', error: 'Content moderation' };
  await queue.pollJob(db, client, polled);
  assert.match(refunds[0][2], /could not complete this request: Content moderation\. Credits were refunded\.$/);
});

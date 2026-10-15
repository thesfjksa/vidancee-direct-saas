const test = require('node:test');
const assert = require('node:assert/strict');
const { yottaMediaModels, isYottaModel, validateYottaReferences, wavSeconds, yottaReferenceCapabilities } = require('../src/yotta_models.js');
const { validateReferences } = require('../src/vercel_models.js');
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
  assert.deepEqual(w3.yotta, { family: 'wan3.0', t2v: 'wan3.0-t2v', i2v: 'wan3.0-i2v', r2v: 'wan3.0-r2v', framesAspectRatio: true });
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
  assert.throws(() => client.videoRequest(w3, params, [ref('start_image', 0), ref('image_references', 1)]), /either a start frame or reference files/);

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

test('Wan prices are capped at least 30% below Higgsfield', () => {
  const { wanCreditCap, applyWanCap, CUSTOMER_USD_PER_CREDIT, HIGGSFIELD_USD_PER_CREDIT, HIGGSFIELD_CREDITS_PER_SECOND } = require('../src/wan_pricing.js');
  const w3 = model('wan3.0'), w27 = model('wan2.7');
  const capped = (m, r) => applyWanCap(m.publicModelId, quote(m, r));
  // 5 s clips: Wan 3.0 480p and Wan 2.7 720p come down; the rest were already below the cap.
  // Wan 3.0 has no profit: the credits sell for exactly the render + upscale cost.
  assert.deepEqual(['480p', '720p', '1080p'].map(r => capped(w3, r).cost), [588, 709, 1297]);
  const { noProfitCredits } = require('../src/wan_pricing.js');
  for (const [m, r] of [[w3, '480p'], [w3, '720p'], [w3, '1080p'], [w27, '720p'], [w27, '1080p']]) {
    const q = capped(m, r);
    assert.ok(Math.abs(q.cost * CUSTOMER_USD_PER_CREDIT - q.sourceUsd) < CUSTOMER_USD_PER_CREDIT, r + ' sells at cost');
    assert.equal(q.cost, noProfitCredits(q.sourceUsd));
  }
  assert.deepEqual(['720p', '1080p'].map(r => capped(w27, r).cost), [924, 1045]);
  for (const [m, family] of [[w3, 'wan-3.0'], [w27, 'wan-2.7']]) {
    for (const r of Object.keys(HIGGSFIELD_CREDITS_PER_SECOND[family])) {
      for (const seconds of [2, 5, 15]) {
        const ours = applyWanCap(m.publicModelId, quote(m, r, true, { duration: seconds })).cost * CUSTOMER_USD_PER_CREDIT;
        const theirs = HIGGSFIELD_CREDITS_PER_SECOND[family][r] * seconds * HIGGSFIELD_USD_PER_CREDIT;
        assert.ok(ours <= theirs * 0.7 + 1e-9, family + ' ' + r + ' ' + seconds + ' s is at least 30% cheaper');
      }
    }
  }
  // The upscale refund shrinks with the price; non-Wan models are not capped.
  const q = capped(w27, '720p');
  assert.deepEqual([q.wanCap, q.listCost, q.enhance], [true, 1848, null]);
  assert.equal(q.cost, 924);
  const hd = applyWanCap('argo_wan_3_prime', { cost: 9000, resolution: '1080p', duration: 5, enhance: { credits: 300 } });
  assert.deepEqual([hd.cost, hd.enhance.credits], [4965, Math.floor(300 * 4965 / 9000)]);
  assert.equal(wanCreditCap('argo_seedance_2_5', '720p', 5), null);
  assert.equal(wanCreditCap('argo_wan_3', '720p', 5), 1448);
});

test('Wan 3.0 and Wan 2.7 take reference videos and sound', () => {
  const w3 = model('wan3.0'), w27 = model('wan2.7');
  const c3 = w3.referenceCapabilities, c27 = w27.referenceCapabilities;
  assert.deepEqual([c3.image.max, c3.video.max, c3.audio.max, c3.totalMax, c3.video.roles, c3.audio.roles], [10, 5, 5, 15, ['video_references'], ['audio_references']]);
  assert.deepEqual([c27.image.max, c27.video.max, c27.audio.max, c27.totalMax, c27.audio.roles], [5, 5, 1, 5, ['audio_track']]);
  // Rows saved before this change get the same rules from their family.
  assert.deepEqual(yottaReferenceCapabilities({ family: 'wan3.0', t2v: 'a', i2v: 'b', r2v: 'c' }), c3);

  const client = new YottaClient({ apiKey: 'k' });
  const params = { prompt: '@Image1 sings @Audio1', resolution: '480p', duration: 5, aspectRatio: '16:9', generateAudio: true };
  const ref = (role, mimeType, n) => ({ role, mimeType, url: 'https://cmmtools.site/provider-media/g/' + n + '?sig=s' });
  const img = ref('image_references', 'image/png', 0), vid = ref('video_references', 'video/mp4', 1), snd = ref('audio_references', 'audio/mpeg', 2);
  const r3 = client.videoRequest(w3, params, [img, vid, snd]);
  assert.deepEqual([r3.category, r3.body.model, r3.body.parameters.reference_items], ['reference-to-video', 'wan3.0-r2v',
    [{ url: img.url, type: 'image' }, { url: vid.url, type: 'video' }, { url: snd.url, type: 'audio' }]]);
  assert.equal(client.videoRequest(w3, params, [snd]).body.parameters.reference_items[0].type, 'audio');
  assert.throws(() => client.videoRequest(w3, params, [ref('start_image', 'image/png', 0), snd]), /not with a start frame/);

  const track = ref('audio_track', 'audio/wav', 3), p27 = { ...params, resolution: '720p' };
  const t27 = client.videoRequest(w27, p27, [track]);
  assert.deepEqual([t27.body.model, t27.body.parameters.audio_url], ['wan2.7-t2v', track.url]);
  const f27 = client.videoRequest(w27, p27, [ref('start_image', 'image/png', 0), track]);
  assert.deepEqual([f27.body.model, f27.body.parameters.first_frame, f27.body.parameters.audio_url], ['wan2.7-i2v', ref('', '', 0).url, track.url]);
  const v27 = client.videoRequest(w27, p27, [img, vid, track]);
  assert.deepEqual([v27.body.model, v27.body.parameters.reference_items, 'audio_url' in v27.body.parameters], ['wan2.7-r2v',
    [{ url: img.url, type: 'image' }, { url: vid.url, type: 'video', reference_audio: track.url }], false]);
  assert.throws(() => client.videoRequest(w27, p27, [img, track]), /voice a reference video/);
});

test('reference video and sound uploads are checked before credits are taken', () => {
  const w3 = model('wan3.0'), w27 = model('wan2.7');
  const file = (mimeType, data = Buffer.alloc(100)) => ({ mimeType, data, filename: 'f' });
  const wav = seconds => { const b = Buffer.alloc(44 + 8000 * seconds); b.write('RIFF', 0); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt32LE(8000, 28); b.write('data', 36); b.writeUInt32LE(8000 * seconds, 40); return b; };
  assert.equal(wavSeconds(wav(3)), 3);
  assert.equal(wavSeconds(Buffer.from('ID3 not a wav file at all, just some bytes padding padding')), null);
  // Formats, counts and sizes.
  validateReferences(w3, { audios: [file('audio/mpeg'), file('audio/wav')], videos: [file('video/mp4')] });
  assert.throws(() => validateReferences(w3, { audios: [file('audio/ogg')] }), /Unsupported reference audio format/);
  assert.throws(() => validateReferences(w3, { audios: Array.from({ length: 6 }, () => file('audio/mpeg')) }), /too many files/);
  assert.throws(() => validateReferences(w27, { audios: [file('audio/mpeg'), file('audio/mpeg')] }), /too many files/);
  assert.throws(() => validateReferences(w3, { videos: [file('video/webm')] }), /Unsupported reference video format/);
  // Which references go together and how long they may be.
  const order = role => JSON.stringify([{ kind: 'fresh', index: 0, role }]);
  assert.throws(() => validateYottaReferences(w3, { audios: [file('audio/mpeg')], referenceOrder: order('start_image'), duration: 5 }), /not with a start frame/);
  validateYottaReferences(w27, { audios: [file('audio/mpeg')], referenceOrder: order('start_image'), duration: 5 });
  assert.throws(() => validateYottaReferences(w27, { audios: [file('audio/mpeg')], referenceOrder: order('image_references'), duration: 5 }), /voice a reference video/);
  assert.throws(() => validateYottaReferences(w27, { videos: [file('video/mp4')], duration: 12 }), /up to 10 seconds/);
  validateYottaReferences(w27, { videos: [file('video/mp4')], duration: 10 });
  const seconds = n => () => n;
  assert.throws(() => validateYottaReferences(w3, { videos: [file('video/mp4'), file('video/mp4')], duration: 5 }, { mp4Seconds: seconds(8) }), /15 seconds long in total/);
  assert.throws(() => validateYottaReferences(w3, { videos: [file('video/mp4')], duration: 25 }, { mp4Seconds: seconds(10) }), /up to 20 s/);
  validateYottaReferences(w3, { videos: [file('video/mp4')], duration: 20 }, { mp4Seconds: seconds(10) });
  assert.throws(() => validateYottaReferences(w3, { audios: [file('audio/wav', wav(9)), file('audio/wav', wav(9))], duration: 5 }), /Sound references can be 15 seconds/);
});

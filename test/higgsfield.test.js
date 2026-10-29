const test = require('node:test');
const assert = require('node:assert/strict');
const { higgsfieldMediaModels, isHiggsfieldModel, validateHiggsfieldReferences, fetchHiggsfieldTiers, WAN_3 } = require('../src/higgsfield_models.js');
const { validateReferences } = require('../src/vercel_models.js');
const { wanVideoView, quoteArgoVideo } = require('../src/argo_hd.js');
const { HiggsfieldClient } = require('../src/provider/higgsfield.js');

// Per-second USD prices as a price sync would store them (example values).
const TIERS = [
  { resolution: '480p', audio: false, cost_per_second: 0.05 }, { resolution: '480p', audio: true, cost_per_second: 0.055 },
  { resolution: '720p', audio: false, cost_per_second: 0.1 }, { resolution: '720p', audio: true, cost_per_second: 0.11 },
  { resolution: '1080p', audio: false, cost_per_second: 0.2 }, { resolution: '1080p', audio: true, cost_per_second: 0.22 },
];
// The stored row as serializeProviderModel returns it (options spread on top).
const model = (tiers = TIERS) => {
  const [d] = higgsfieldMediaModels(tiers);
  return { ...d.options, providerModelId: d.providerModelId, publicModelId: d.publicModelId, label: d.label, mediaType: d.mediaType, provider: 'higgsfield' };
};
const settings = fal => ({ falEnabled: fal, falApiKey: fal ? 'k' : '', falCustomerCreditsPerUsd: 6720, higgsfieldCustomerCreditsPerUsd: 6720 });
const quote = (m, resolution, fal = true, extra = {}) => quoteArgoVideo(m, { duration: 5, resolution, aspectRatio: '16:9', ...extra }, settings(fal), { view: wanVideoView, creditsPerUsd: 6720 });
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Wan 3.0 on Higgsfield is one Video Studio model, hidden until its prices are synced', () => {
  const w3 = model();
  assert.equal(w3.publicModelId, 'hf_wan_3_0');
  assert.equal(isHiggsfieldModel(w3.publicModelId), true);
  assert.equal(isHiggsfieldModel('argo_wan_3'), false);
  assert.deepEqual([w3.resolutions, w3.durations[0], w3.durations.at(-1), w3.supportsAudio, w3.adapterSupported], [['480p', '720p', '1080p'], 2, 30, true, true]);
  assert.deepEqual(w3.aspectRatios, ['16:9', '9:16', '1:1', '4:3', '3:4']);
  assert.deepEqual(w3.referenceCapabilities.image.roles, ['start_image', 'end_image', 'image_references']);
  assert.deepEqual([w3.referenceCapabilities.image.max, w3.referenceCapabilities.video.max, w3.referenceCapabilities.audio.max], [10, 5, 5]);
  assert.deepEqual(w3.higgsfield.paths, WAN_3.paths);
  // No prices yet: not offered, with the reason shown in Admin.
  const unpriced = model([]);
  assert.equal(unpriced.adapterSupported, false);
  assert.match(unpriced.setupReason, /sync prices/);
});

test('prices are read from Higgsfield estimates per resolution, with and without sound', async () => {
  const asked = [];
  const tiers = await fetchHiggsfieldTiers(async (path, input) => { asked.push([path, input.resolution, input.generate_audio, input.duration]); return { usd: (input.resolution === '480p' ? 0.25 : input.resolution === '720p' ? 0.5 : 1) * (input.generate_audio ? 1.1 : 1) }; });
  assert.equal(asked.length, 6);
  assert.ok(asked.every(([path, , , seconds]) => path === 'alibaba/wan-3.0/text-to-video' && seconds === 5));
  assert.deepEqual(tiers.find(t => t.resolution === '720p' && !t.audio), { resolution: '720p', audio: false, cost_per_second: 0.1 });
  assert.equal(tiers.find(t => t.resolution === '1080p' && t.audio).cost_per_second.toFixed(3), '0.220');
  await assert.rejects(fetchHiggsfieldTiers(async () => ({ usd: 0 })), /no price for Wan 3\.0/);
});

test('480p renders natively; 720p and 1080p render lower and are upscaled by fal', () => {
  const w3 = model();
  assert.deepEqual(wanVideoView(w3, true).hdPlans, {
    '480p': { source: '480p', upscale: false },
    '720p': { source: '480p', upscale: true, target: '1080p' },
    '1080p': { source: '720p', upscale: true, target: '1080p' },
  });
  // Without fal (or with HD enhance off) every resolution is rendered as chosen.
  assert.deepEqual(Object.values(wanVideoView(w3, false).hdPlans).map(p => p.source), ['480p', '720p', '1080p']);
  assert.ok(Object.values(wanVideoView(w3, true, { hd: false }).hdPlans).every(p => !p.upscale));
  // 5 s 16:9 without sound at 6,720 credits per USD: 480p is $0.25; 720p is the 480p render + fal's
  // $0.036 upscale (242 credits); 1080p the 720p render + upscale.
  const silent = { generateAudio: false };
  assert.deepEqual(['480p', '720p', '1080p'].map(r => quote(w3, r, true, silent).cost), [1680, 1680 + 242, 3360 + 242]);
  assert.deepEqual(['480p', '720p', '1080p'].map(r => quote(w3, r, false, silent).cost), [1680, 3360, 6720]);
  // Sound uses the "with sound" price, and is on when not stated.
  assert.equal(quote(w3, '480p', true, { generateAudio: true }).cost, 1848); // 0.055 x 5 s x 6,720
  assert.equal(quote(w3, '480p').generateAudio, true);
  assert.equal(quote(w3, '480p').cost, 1848);
  const q = quote(w3, '1080p');
  assert.deepEqual([q.resolution, q.sourceResolution, q.enhance.upscale.input.target_resolution], ['1080p', '720p', '1080p']);
});

test('Wan 3.0 on Higgsfield sells at cost, never below it', () => {
  const { applyWanCap, CUSTOMER_USD_PER_CREDIT, noProfitCredits, wanCreditCap } = require('../src/wan_pricing.js');
  const w3 = model();
  for (const r of ['480p', '720p', '1080p']) {
    for (const seconds of [2, 5, 30]) {
      const q = applyWanCap(w3.publicModelId, quote(w3, r, true, { duration: seconds }));
      assert.equal(q.cost, noProfitCredits(q.sourceUsd), r + ' ' + seconds + ' s');
      assert.ok(q.cost * CUSTOMER_USD_PER_CREDIT >= q.sourceUsd - 1e-9, r + ' ' + seconds + ' s is not sold below cost');
    }
  }
  // Higgsfield's own model has no "cheaper than Higgsfield" cap; ArgoLink's Wan keeps it.
  assert.equal(wanCreditCap('hf_wan_3_0', '480p', 5), null);
  assert.equal(wanCreditCap('argo_wan_3', '720p', 5), 1448);
});

test('Higgsfield requests use the text, frame or reference endpoint', () => {
  const w3 = model();
  const client = new HiggsfieldClient({ apiKey: 'id:secret' });
  const params = { prompt: 'A kite', resolution: '480p', duration: 5, aspectRatio: '9:16', generateAudio: true };
  const ref = (role, mimeType, n) => ({ role, mimeType, url: 'https://cdn.higgsfield.example/' + n });
  assert.deepEqual(client.videoRequest(w3, params, []), { path: 'alibaba/wan-3.0/text-to-video',
    input: { prompt: 'A kite', duration: 5, resolution: '480p', generate_audio: true, aspect_ratio: '9:16' } });
  const frames = client.videoRequest(w3, params, [ref('start_image', 'image/png', 0), ref('end_image', 'image/png', 1)]);
  assert.deepEqual([frames.path, frames.input.image_url, frames.input.end_image_url, frames.input.aspect_ratio],
    ['alibaba/wan-3.0/image-to-video', ref('', '', 0).url, ref('', '', 1).url, 'adaptive']);
  const refs = client.videoRequest(w3, { ...params, generateAudio: false },
    [ref('image_references', 'image/png', 0), ref('video_references', 'video/mp4', 1), ref('audio_references', 'audio/mpeg', 2)]);
  assert.deepEqual([refs.path, refs.input.image_urls, refs.input.video_urls, refs.input.audio_urls, refs.input.generate_audio, refs.input.aspect_ratio],
    ['alibaba/wan-3.0/reference-to-video', [ref('', '', 0).url], [ref('', '', 1).url], [ref('', '', 2).url], false, '9:16']);
  assert.throws(() => client.videoRequest(w3, params, [ref('start_image', 'image/png', 0), ref('image_references', 'image/png', 1)]), /either start\/end frames or reference files/);
  assert.throws(() => client.videoRequest(w3, params, [ref('end_image', 'image/png', 0)]), /start frame before an end frame/);
});

test('the Higgsfield client signs requests, uploads files, polls and reports Higgsfield\'s answer', async () => {
  const w3 = model();
  const calls = [];
  let next = () => answer(200, { status: 'queued', request_id: 'req-1', status_url: 'https://api.higgsfield.ai/requests/req-1/status' });
  const api = new HiggsfieldClient({ apiKey: 'id:secret', fetchImpl: async (url, init) => { calls.push([url, init.method, init.headers, init.body]); return next(url, init); } });
  const params = { prompt: 'A kite', resolution: '480p', duration: 5, aspectRatio: '16:9', generateAudio: false };

  assert.deepEqual(await api.startVideo(w3, params, [], 'cmm-g1'), { requestId: 'req-1', statusUrl: 'https://api.higgsfield.ai/requests/req-1/status' });
  assert.deepEqual([calls[0][0], calls[0][1], calls[0][2].authorization, calls[0][2]['idempotency-key']],
    ['https://api.higgsfield.ai/alibaba/wan-3.0/text-to-video', 'POST', 'Key id:secret', 'cmm-g1']);

  next = () => answer(200, { status: 'in_progress', request_id: 'req-1' });
  assert.deepEqual(await api.videoStatus({ statusUrl: 'https://api.higgsfield.ai/requests/req-1/status' }), { status: 'pending' });
  next = () => answer(200, { status: 'completed', request_id: 'req-1', video: { url: 'https://cdn.higgsfield.example/v.mp4' } });
  assert.deepEqual(await api.videoStatus({ statusUrl: 'https://api.higgsfield.ai/requests/req-1/status' }), { status: 'done', url: 'https://cdn.higgsfield.example/v.mp4' });
  next = () => answer(200, { status: 'nsfw', request_id: 'req-1' });
  assert.deepEqual(await api.videoStatus({ statusUrl: 'https://api.higgsfield.ai/requests/req-1/status' }), { status: 'failed', error: 'The content filter blocked this request.' });
  next = () => answer(200, { status: 'failed', request_id: 'req-1', error: 'Generation failed' });
  assert.deepEqual(await api.videoStatus({ statusUrl: 'https://api.higgsfield.ai/requests/req-1/status' }), { status: 'failed', error: 'Generation failed' });
  // A saved status address must be Higgsfield's.
  await assert.rejects(api.videoStatus({ statusUrl: 'https://evil.example/requests/x' }), /unexpected status address/);

  next = () => answer(200, { credits: '8.750', usd: '0.547' });
  { const e = await api.estimate('alibaba/wan-3.0/text-to-video', { prompt: 'x' }); assert.deepEqual([e.credits, e.usd], [8.75, 0.547]); }
  assert.equal(calls.at(-1)[0], 'https://api.higgsfield.ai/estimate/alibaba/wan-3.0/text-to-video');

  // Wan 3.0 answers estimates with a price list rather than numbers (seen live, 17 October 2026).
  const listed = { type: 'description', pricing_description: 'Billed per generated second by resolution: 480p $0.05, 720p $0.10, or 1080p $0.20. Rates shown are before any applicable credits.' };
  next = () => answer(200, listed);
  for (const [resolution, usd] of [['480p', 0.25], ['720p', 0.5], ['1080p', 1]]) {
    const e = await api.estimate('alibaba/wan-3.0/text-to-video', { prompt: 'x', duration: 5, resolution });
    assert.equal(e.usd.toFixed(4), usd.toFixed(4), resolution);
  }
  const tiers = await fetchHiggsfieldTiers((path, input) => api.estimate(path, input));
  assert.deepEqual(tiers.filter(t => !t.audio).map(t => [t.resolution, +t.cost_per_second.toFixed(4)]), [['480p', 0.05], ['720p', 0.1], ['1080p', 0.2]]);
  assert.match(tiers.description, /per generated second/);
  // A description without per-second rates gives no price.
  next = () => answer(200, { type: 'description', pricing_description: 'Priced per request.' });
  assert.ok(!((await api.estimate('alibaba/wan-3.0/text-to-video', { prompt: 'x', duration: 5, resolution: '480p' })).usd > 0));

  // Uploads: an upload address, then a PUT with Higgsfield's headers and without the API key.
  next = url => url.endsWith('/files/generate-upload-url')
    ? answer(200, { public_url: 'https://cdn.higgsfield.example/in.png', upload_url: 'https://storage.example/put', upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'retention=temporary' } })
    : new Response('', { status: 200 });
  assert.equal(await api.upload({ data: Buffer.from('png'), mimeType: 'image/png' }), 'https://cdn.higgsfield.example/in.png');
  const put = calls.at(-1);
  assert.deepEqual([put[0], put[1], put[2]['x-amz-tagging'], 'authorization' in put[2]], ['https://storage.example/put', 'PUT', 'retention=temporary', false]);
  // Exactly one Content-Type, as signed (a second one in other case made the storage answer 403).
  assert.deepEqual(Object.keys(put[2]).filter(k => k.toLowerCase() === 'content-type'), ['content-type']);
  assert.equal(new Headers(put[2]).get('content-type'), 'image/png');
  await assert.rejects(api.upload({ data: Buffer.from('mp3'), mimeType: 'audio/mpeg' }), /does not take audio\/mpeg/);

  // Errors, as Higgsfield documents them.
  next = () => answer(401, { detail: 'Invalid credentials' });
  await assert.rejects(api.startVideo(w3, params, []), /rejected the API key/);
  await assert.rejects(api.verifyKey(), /rejected the API key/);
  next = () => answer(403, { detail: 'Not enough credits' });
  await assert.rejects(api.startVideo(w3, params, []), /insufficient credits/);
  next = () => answer(400, { detail: 'Maximum number of concurrent requests (4) has been reached' });
  await assert.rejects(api.startVideo(w3, params, []), err => /concurrency limit/.test(err.message) && err.retryable === true);
  next = () => answer(422, { detail: [{ loc: ['body', 'duration'], msg: 'must be at most 30' }] });
  await assert.rejects(api.startVideo(w3, params, []), /HTTP 422\): duration: must be at most 30/);
  // A good key: an unknown request answers 404.
  next = () => answer(404, { detail: 'Not found' });
  assert.equal(await api.verifyKey(), true);
  await assert.rejects(new HiggsfieldClient({}).json('https://api.higgsfield.ai/x'), /API key/);
});

test('reference rules: frames do not mix with reference files, and clip lengths are checked', () => {
  const w3 = model();
  const mp4 = seconds => ({ data: Buffer.from(String(seconds)), mimeType: 'video/mp4' });
  const mp4Seconds = data => Number(data.toString());
  const order = roles => JSON.stringify(roles.map((role, index) => ({ kind: 'fresh', index, role })));
  validateHiggsfieldReferences(w3, { referenceOrder: order(['start_image', 'end_image']) });
  validateHiggsfieldReferences(w3, { referenceOrder: order(['image_references']), videos: [mp4(10), mp4(20)] }, { mp4Seconds });
  assert.throws(() => validateHiggsfieldReferences(w3, { referenceOrder: order(['start_image', 'image_references']) }), /either start\/end frames or reference files/);
  assert.throws(() => validateHiggsfieldReferences(w3, { referenceOrder: order(['start_image']), videos: [mp4(5)] }, { mp4Seconds }), /either start\/end frames/);
  assert.throws(() => validateHiggsfieldReferences(w3, { videos: [mp4(20), mp4(11)] }, { mp4Seconds }), /30 seconds long in total/);
  assert.throws(() => validateHiggsfieldReferences(w3, { videos: [mp4(0.5)] }, { mp4Seconds }), /at least 1 second/);
  // Reference video time counts against Wan 3.0's 30 s (30 s + a video failed on Higgsfield, 17 October).
  assert.throws(() => validateHiggsfieldReferences(w3, { duration: 30, videos: [mp4(8)] }, { mp4Seconds }), /runs 8 s, so Wan 3\.0 can make up to 22 s/);
  validateHiggsfieldReferences(w3, { duration: 22, videos: [mp4(8)] }, { mp4Seconds });
  validateHiggsfieldReferences(w3, { duration: 30 }, { mp4Seconds });
  // Counts and formats come from the shared check.
  const img = { mimeType: 'image/png', data: Buffer.from('x') };
  assert.throws(() => validateReferences(w3, { images: Array(11).fill(img), referenceOrder: order(Array(11).fill('image_references')) }), /too many files/);
});

test('the Higgsfield queue uploads references, saves the request, then stores, upscales or refunds the result', async () => {
  process.env.APP_URL = 'https://cmmtools.site'; process.env.PROVIDER_ASSET_SECRET = 'test-secret';
  const { HiggsfieldQueue } = require('../src/higgsfield_queue.js');
  const sql = [], refunds = [], falCalls = [], logs = [];
  const media = [{ position_index: 0, mime_type: 'image/png', media_data: Buffer.from('png') }, { position_index: 1, mime_type: 'audio/mpeg', media_data: Buffer.from('mp3') }];
  const conn = { async execute(text, args) { sql.push([text.replace(/\s+/g, ' '), args]); if (text.includes('FOR UPDATE')) return [[{ status: 'processing', refunded_at: null }]];
    if (text.includes('media_data FROM generation_media')) return [media]; return [{ affectedRows: 1 }]; },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  const db = { getConnection: async () => conn, execute: conn.execute };
  const fal = { submit: async (path, input) => { falCalls.push([path, input]); return { requestId: 'f1', statusUrl: 'https://queue.fal.run/x/requests/f1/status', responseUrl: 'https://queue.fal.run/x/requests/f1' }; } };
  const queue = new HiggsfieldQueue({ falFactory: () => fal, refund: async (...a) => refunds.push(a) });
  const signed = n => 'https://cmmtools.site/provider-media/g1/' + n + '?sig=s';
  Object.assign(queue, { settings: { falEnabled: true, falApiKey: 'k' }, log: (job, event) => logs.push(event),
    references: async () => [{ role: 'image_references', mimeType: 'image/png', url: signed(0) }, { role: 'audio_references', mimeType: 'audio/mpeg', url: signed(1) }],
    getModel: async () => ({ ...model(), ready: true }) });
  assert.deepEqual([queue.provider, queue.apiKey({ higgsfieldApiKey: 'h', argoLinkApiKey: 'a' }), queue.sourceEnabled({ higgsfieldEnabled: true }), queue.maxInflight({})], ['higgsfield', 'h', true, 3]);
  const w3 = model();
  const options = { ...quote(w3, '720p'), model: w3 };
  const job = { id: 'g1', user_id: 2, model: 'hf_wan_3_0', media_type: 'video', prompt: 'A kite', status: 'submitting', generation_options: JSON.stringify(options) };
  let started, startedRefs, key, status = { status: 'pending' };
  const op = { requestId: 'req-9', statusUrl: 'https://api.higgsfield.ai/requests/req-9/status' };
  const client = { videoRequest: () => null, upload: async ({ mimeType }) => 'https://cdn.higgsfield.example/' + mimeType.replace('/', '-'),
    startVideo: async (_m, params, refs, idem) => { started = params; startedRefs = refs; key = idem; return op; },
    videoStatus: async () => status, download: async () => ({ data: Buffer.from('ftyphiggs'), mimeType: 'video/mp4' }) };

  // 720p is rendered at 480p; the PNG goes to Higgsfield storage, the MP3 (not taken there) keeps its signed link.
  await queue.submit(db, job, client);
  assert.equal(started.resolution, '480p');
  assert.deepEqual(startedRefs.map(r => r.url), ['https://cdn.higgsfield.example/image-png', signed(1)]);
  assert.equal(key, 'cmm-g1');
  assert.ok(logs.includes('higgsfield.upload'));
  assert.match(sql.at(-1)[0], /SET status='submitted',provider_operation=\?/);
  assert.deepEqual(JSON.parse(sql.at(-1)[1][0]), op);

  // A failed upload keeps the signed link instead of failing the job.
  await queue.submit(db, job, { ...client, upload: async () => { throw new Error('storage down'); } });
  assert.deepEqual(startedRefs.map(r => r.url), [signed(0), signed(1)]);
  assert.ok(logs.includes('higgsfield.upload_failed'));

  const polled = { ...job, status: 'submitted', provider_operation: JSON.stringify(op) };
  sql.length = 0;
  await queue.pollJob(db, client, polled);
  assert.match(sql[0][0], /SET status='processing'/);
  // Done: the render is stored and handed to fal for the 1080p upscale.
  status = { status: 'done', url: 'https://cdn.higgsfield.example/v.mp4' };
  await queue.pollJob(db, client, polled);
  assert.ok(sql.some(([t]) => t.startsWith('INSERT INTO generation_video_outputs')));
  assert.equal(falCalls[0][0], options.enhance.upscale.path);
  assert.match(falCalls[0][1].video_url, /\/provider-outputs\/g1\?sig=/);
  assert.equal(JSON.parse(sql.at(-1)[1][0]).stage, 'enhance');
  // 480p needs no upscale: the render completes the job.
  sql.length = 0;
  await queue.pollJob(db, client, { ...polled, generation_options: JSON.stringify({ ...quote(w3, '480p'), model: w3 }) });
  assert.ok(sql.some(([t]) => t.includes("SET status='completed',output_url=?")));
  // A failed job is refunded with Higgsfield's reason.
  status = { status: 'failed', error: 'The content filter blocked this request.' };
  await queue.pollJob(db, client, polled);
  assert.match(refunds[0][2], /could not complete this request: The content filter blocked this request\. Credits were refunded\.$/);
  // An operation saved without a status address cannot be resumed.
  await assert.rejects(queue.pollJob(db, client, { ...polled, provider_operation: JSON.stringify({ requestId: 'x' }) }), /could not be resumed/);
});

test('only retired Atlas, Yotta and CreatePulse jobs are refunded; current Vidancee and Higgsfield jobs survive', async () => {
  const { GenerationWorker } = require('../src/worker_admin_settings.js');
  const w = new GenerationWorker();
  let query = '', moved = '';
  await w.retireRemovedSources({ query: async sql => { query = sql; return [[]]; }, execute: async sql => { moved = sql; return [{ affectedRows: 0 }]; } });
  assert.match(query, /provider IN \('atlascloud','yotta','createpulse'\)/);
  assert.doesNotMatch(query, /higgsfield|vidancee/);
  // Legacy queued MiniMax H3 work can still be migrated; new Vidancee Omni Flash
  // is never refunded by retired-source cleanup.
  assert.match(moved, /SET provider='vgenv'.*provider IN \('vidancee','createpulse'\) AND model='minimax_h3' AND status='queued'/);
  w.stop?.();
});

test('the Higgsfield key is saved as KEY_ID:KEY_SECRET', async () => {
  const settings = require('../src/settings.js');
  await assert.rejects(settings.updateProviderSettings({ higgsfieldApiKey: 'only-one-part' }), /KEY_ID:KEY_SECRET/);
  await assert.rejects(settings.updateProviderSettings({ higgsfieldApiKey: 'a b:c' }), /KEY_ID:KEY_SECRET/);
});

test('Higgsfield is switched on for every customer once', async () => {
  const src = require('fs').readFileSync(require.resolve('../server.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function enableHiggsfieldForCustomersOnce'), src.indexOf('async function getUserProviderAccess'));
  const store = new Map(), sql = [], logs = [];
  const run = new Function('getSettingValue', 'setSettingValue', 'getPool', 'logActivity', 'HIGGSFIELD_ALL_ON_SETTING', fn + '; return enableHiggsfieldForCustomersOnce();');
  const deps = [async k => store.get(k) || '', async (k, v) => store.set(k, v), () => ({ execute: async q => { sql.push(q); return [{ affectedRows: 3 }]; } }), e => logs.push(e), 'higgsfield_access_all_on_at'];
  assert.equal(await run(...deps), 3);
  assert.match(sql[0], /DELETE FROM user_provider_access WHERE provider='higgsfield' AND enabled=0/);
  assert.equal(await run(...deps), 0); // only once
  assert.equal(sql.length, 1);
  assert.match(logs[0].message, /3 had it off/);
});

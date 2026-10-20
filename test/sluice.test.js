'use strict';
const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/provider/sluice_catalog.json');
const { sluiceMediaModels, isSluiceModel } = require('../src/sluice_models.js');
const { quoteGateway } = require('../src/vercel_models.js');
const { SluiceClient } = require('../src/provider/sluice.js');
const { normalizeCartoonRequest } = require('../src/cartoon.js');

const models = sluiceMediaModels(catalog);
const byId = id => { const m = models.find(x => x.providerModelId === id); return m && { ...m, ...m.options, provider: 'sluice' }; };

test('catalog maps the three Seedance Lite models', () => {
  for (const id of ['sl_seedance_2_5', 'sl_seedance_2_0', 'sl_seedance_2_0_fast']) assert.ok(isSluiceModel(id));
  assert.equal(models.length, 3);
});

test('prices are at cost (6720 credits per USD) with a $0.10 image surcharge', () => {
  const m = byId('seedance-2.0') || models.find(x => /2\.0$|2_0$/.test(x.publicModelId || x.id));
  const plain = quoteGateway(m, { duration: 10, resolution: '720p' }, 6720);
  const withImg = quoteGateway(m, { duration: 10, resolution: '720p', previewHasReferences: true }, 6720);
  const cost = q => (typeof q === 'object' ? q.cost : q);
  assert.equal(cost(plain), Math.ceil(0.0288 * 10 * 6720));
  assert.equal(cost(withImg) - cost(plain), 672);
});

test('client builds the request body with frames and ratio hint', () => {
  const c = new SluiceClient({ apiKey: 'slu_live_x' });
  const body = c.videoRequest({ sluice: { model: 'seedance-2.5' } }, { prompt: 'hi', duration: 15, resolution: '720p', aspectRatio: '9:16' },
    [{ role: 'start_image', mimeType: 'image/png', data: Buffer.from('abc') }, { role: 'image_references', mimeType: 'image/png', url: 'https://x/a.png' }]);
  assert.equal(body.model, 'seedance-2.5');
  assert.match(body.prompt, /9:16 vertical/);
  assert.match(body.first_frame.data_uri, /^data:image\/png;base64,/);
  assert.deepEqual(body.references, [{ url: 'https://x/a.png' }]);
});

test('client maps 402 and job polling', async () => {
  const res = (status, obj) => new Response(JSON.stringify(obj), { status });
  const c402 = new SluiceClient({ apiKey: 'k', fetchImpl: async () => res(402, { error: { code: 'insufficient_balance' } }) });
  await assert.rejects(c402.balance(), /insufficient balance/);
  const ok = new SluiceClient({ apiKey: 'k', fetchImpl: async () => res(200, { job: { id: 'job_1', status: 'succeeded', video_url: 'https://cdn/x.mp4' } }) });
  assert.deepEqual(await ok.videoStatus({ requestId: 'job_1' }), { status: 'done', url: 'https://cdn/x.mp4' });
});

test('Cartoon Studio accepts Seedance Lite', () => {
  const { CARTOON_STYLES } = require('../src/cartoon.js');
  const style = (Array.isArray(CARTOON_STYLES) ? CARTOON_STYLES[0] : Object.values(CARTOON_STYLES)[0]).id;
  assert.equal(normalizeCartoonRequest({ cartoonStyle: style, model: 'sl_seedance_2_0' }).studio, 'cartoon');
});

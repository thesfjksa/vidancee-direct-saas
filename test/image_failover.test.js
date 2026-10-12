const test = require('node:test');
const assert = require('node:assert/strict');
const { argoMediaModels } = require('../src/argolink_models.js');

// provider_models reads the pool when first loaded, so the test pool goes in first.
const argoRows = argoMediaModels(require('../src/provider/argolink_catalog.json')).map((m, i) => ({
  id: i + 1, provider: 'argolink', provider_model_id: m.providerModelId, public_model_id: m.publicModelId, label: m.label,
  media_type: m.mediaType, tool_name: '', input_schema: '{}', options_json: JSON.stringify(m.options), enabled: 1, available: 1, price_override: null }));
let status = {}, access = [], refCount = 0;
const writes = [];
const db = {
  async query(sql, args = []) {
    if (sql.includes('FROM provider_models')) return [argoRows.filter(r => r.media_type === (args[1] || r.media_type))];
    if (sql.includes('FROM app_settings')) return [[{ setting_value: JSON.stringify(status) }]];
    if (sql.includes('FROM generation_images')) return [[{ total: refCount }]];
    throw new Error('Unexpected SQL ' + sql);
  },
  async execute(sql, args) {
    if (sql.includes('FROM user_provider_access')) return [access];
    writes.push([sql, args]); return [{ affectedRows: 1 }];
  },
};
Object.assign(require('../src/db.js'), { getPool: () => db, dbConfigured: () => true });
const { modelFamily } = require('../src/model_families.js');
const failover = require('../src/image_failover.js');
const { VercelQueue } = require('../src/vercel_queue.js');

const settings = { argoLinkEnabled: true, argoLinkApiKey: 'k' };

test('model families match the same model across sources', () => {
  assert.equal(modelFamily('Nano Banana Pro (Gemini 3 Pro Image)'), modelFamily('Nano Banana Pro'));
  assert.equal(modelFamily('Gemini 3.1 Flash Image (Nano Banana 2)'), 'nano banana 2');
  assert.equal(modelFamily('Gemini 3.1 Flash Lite Image (Nano Banana 2 Lite)'), 'nano banana 2 lite');
  assert.equal(modelFamily('Gemini Nano Banana 2.1'), 'nano banana 2.1');
  assert.equal(modelFamily('Nano Banana (Gemini 2.5 Flash Image)'), 'nano banana');
  assert.equal(modelFamily('GPT Image 2.5 Flare'), modelFamily('gpt image 2.5 flare'));
  assert.notEqual(modelFamily('GPT Image 2'), modelFamily('GPT Image 2.5 Flare'));
});

test('new requests go to ArgoLink only while the first source is out of credits', async () => {
  const body = { aspectRatio: '16:9', imageSize: '2K', quality: 'medium' };
  const run = (source, label, extra = {}) => failover.submissionFailover(db, { source, label, body, settings, access: { argolink: true }, ...extra });
  status = {};
  assert.equal(await run('vercel', 'Nano Banana Pro (Gemini 3 Pro Image)'), null);
  status = { outOfCredits: { vercel: Date.now() + 60000 } };
  const swap = await run('vercel', 'Nano Banana Pro (Gemini 3 Pro Image)');
  assert.equal(swap.model.publicModelId, 'argo_nano_banana_pro');
  assert.deepEqual([swap.body.imageSize, swap.body.quality], ['2K', undefined]); // Nano Banana has no quality switch
  assert.equal(await run('smartaipi', 'GPT Image 2'), null); // SmartAIPI still has credits
  assert.equal(await run('vercel', 'FLUX 3 Image'), null); // no ArgoLink copy
  assert.equal(await run('vercel', 'Nano Banana Pro', { access: { argolink: false } }), null);
  assert.equal(await run('vercel', 'Nano Banana Pro', { settings: { argoLinkEnabled: true } }), null);
  status = { outOfCredits: { vercel: Date.now() - 1 } };
  assert.equal(await run('vercel', 'Nano Banana Pro'), null); // the mark expired
});

test('a claimed job moves to ArgoLink and keeps its customer price', async () => {
  writes.length = 0; access = []; refCount = 1;
  const job = { id: 'g1', user_id: 3, provider: 'smartaipi', media_type: 'image', model: 'gpt_image_2_studio', aspect_ratio: '3:2', image_quality: 'high', generation_options: null };
  assert.equal(await failover.moveImageJobToArgo(db, job, settings), true);
  const [sql, args] = writes[0];
  assert.match(sql, /SET provider='argolink',model=\?,generation_options=\?,image_quality=\?,provider_cost=\?/);
  assert.doesNotMatch(sql, /credits_cost/);
  assert.equal(args[0], 'argo_gpt_image_2');
  assert.equal(JSON.parse(args[1]).model.providerModelId, 'gpt-image-2');
  assert.deepEqual([args[2], args[3], args[4], args[5]], ['high', 0.015, 'g1', 'smartaipi']);
  // Not moved: customer has no ArgoLink access, too many references, or no equivalent model.
  access = [{ enabled: 0 }];
  assert.equal(await failover.moveImageJobToArgo(db, job, settings), false);
  access = []; refCount = 5;
  assert.equal(await failover.moveImageJobToArgo(db, { ...job, provider: 'vercel', generation_options: JSON.stringify({ model: { label: 'Grok Imagine Image' } }) }, settings), false);
  refCount = 0;
  assert.equal(await failover.moveImageJobToArgo(db, { ...job, provider: 'vercel', generation_options: JSON.stringify({ model: { label: 'Seedream 5.0 Lite' } }) }, settings), false);
  assert.equal(await failover.moveImageJobToArgo(db, { ...job, media_type: 'video' }, settings), false);
});

test('the AI Gateway queue hands an image job to ArgoLink when it runs out of credits', async () => {
  const marks = [], moves = [];
  let out = false;
  const queue = new VercelQueue({ getModel: async () => ({ ready: true }), failover: {
    isOut: () => out, markOut: key => { marks.push(key); out = true; }, move: async (_db, job) => { moves.push(job.id); return true; } } });
  queue.references = async () => [];
  queue.complete = async () => { throw new Error('should not complete'); };
  const job = { id: 'j1', media_type: 'image', model: 'studio_gw_x', prompt: 'p', generation_options: JSON.stringify({ model: { providerModelId: 'google/x' } }) };
  const broke = { generateImage: async () => { throw Object.assign(new Error('AI Gateway has insufficient credits.'), { providerStatus: 402 }); } };
  await queue.submit({}, job, broke);
  assert.deepEqual([marks, moves], [['vercel'], ['j1']]);
  // While marked, later jobs move without calling the gateway at all.
  let called = false;
  await queue.submit({}, { ...job, id: 'j2' }, { generateImage: async () => { called = true; } });
  assert.deepEqual([called, moves], [false, ['j1', 'j2']]);
  // Other failures are not treated as a credit problem.
  out = false;
  await assert.rejects(queue.submit({}, { ...job, id: 'j3' }, { generateImage: async () => { throw new Error('Network timeout'); } }), /Network timeout/);
  assert.deepEqual(marks, ['vercel']);
});

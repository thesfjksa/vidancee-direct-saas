const test = require('node:test');
const assert = require('node:assert/strict');
const { SmartAipiClient, smartAipiBaseUrl } = require('../src/provider/smartaipi.js');
const { SMART_IMAGE_MODELS, defaultSmartImageConfig, normalizeSmartImageConfig, publicSmartImagePricing, smartImageQuote } = require('../src/smartaipi_images.js');
const { GenerationWorker } = require('../src/worker_admin_settings.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const model = SMART_IMAGE_MODELS[0].id;
const settings = () => ({ smartAipiEnabled: true, smartAipiApiKey: 'test-only', smartAipiCreditsPerUsd: 100, smartAipiModels: defaultSmartImageConfig() });

test('catalog is provider-neutral, price-gated and uses the configured credit multiplier', () => {
  const s = settings();
  assert.equal(publicSmartImagePricing(s).length, 5); // GPT Image 1 price intentionally unconfigured.
  const square = smartImageQuote(model, '1:1', s);
  const landscape = smartImageQuote(model, '3:2', s);
  assert.equal(square.sourceUsd, 0.0265);
  assert.equal(square.cost, 6.63);
  assert.equal(landscape.cost, 9.94);
  assert.equal(landscape.size, '1536x1024');
  assert.equal(publicSmartImagePricing(s)[0].costByAspectRatio['3:2'], landscape.cost);
  assert.equal(JSON.stringify(publicSmartImagePricing(s)).includes('smartaipi'), false);
  s.smartAipiEnabled = false; assert.deepEqual(publicSmartImagePricing(s), []);
  s.smartAipiEnabled = true; s.smartAipiApiKey = ''; assert.deepEqual(publicSmartImagePricing(s), []);
  s.smartAipiApiKey = 'test-only'; s.smartAipiModels[model].enabled = false;
  assert.throws(() => smartImageQuote(model, '1:1', s), /not enabled/);
  assert.throws(() => smartImageQuote(SMART_IMAGE_MODELS[1].id, '16:9', s), /aspect ratio/);
  assert.throws(() => normalizeSmartImageConfig({ [model]: { enabled: true, sourceUsd: -1 } }), /price/);
  assert.throws(() => normalizeSmartImageConfig({ unknown: { enabled: true, sourceUsd: 1 } }), /Unknown/);
});

test('text generation maps all six IDs to the documented authenticated JSON endpoint', async () => {
  for (const spec of SMART_IMAGE_MODELS) {
    const client = new SmartAipiClient({ apiKey: 'test-only', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.smartaipi.com/v1/images/generations');
      assert.equal(options.headers.Authorization, 'Bearer test-only');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { model: spec.apiModel, prompt: 'A flower', size: '1024x1536', quality: 'medium', n: 1 });
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    }});
    const output = await client.generateImage({ model: spec.id, prompt: 'A flower', aspectRatio: '2:3' });
    assert.equal(output.mimeType, 'image/png'); assert.deepEqual(output.data, png);
  }
});

test('reference edits send base64 bytes and enforce one valid reference before any paid call', async () => {
  let calls = 0;
  const client = new SmartAipiClient({ apiKey: 'test-only', fetchImpl: async (url, options) => {
    calls += 1; assert.equal(url, 'https://api.smartaipi.com/v1/images/edits');
    assert.equal(JSON.parse(options.body).image, png.toString('base64'));
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  }});
  await client.generateImage({ model, prompt: 'Edit', aspectRatio: '1:1', images: [{ data: png }] });
  await assert.rejects(client.generateImage({ model, prompt: 'Edit', aspectRatio: '1:1', images: [{ data: png }, { data: png }] }), /one reference/);
  await assert.rejects(client.generateImage({ model, prompt: 'Edit', aspectRatio: '1:1', images: [{ data: Buffer.from('text') }] }), /valid PNG/);
  assert.equal(calls, 1);
});

test('model connection check is GET-only and failures never disclose upstream bodies', async () => {
  const client = new SmartAipiClient({ apiKey: 'test-only', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.smartaipi.com/v1/models'); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    return Response.json({ data: [{ id: 'gpt-image-2' }] });
  }});
  assert.deepEqual(await client.listModels(), ['gpt-image-2']);
  client.fetchImpl = async () => Response.json({ error: 'test-only secret echo' }, { status: 401 });
  await assert.rejects(client.listModels(), error => /HTTP 401/.test(error.message) && !/secret|test-only/.test(error.message));
  client.fetchImpl = async () => Response.json({ data: [{ b64_json: Buffer.from('<script>x</script>').toString('base64') }] });
  await assert.rejects(client.generateImage({ model, prompt: 'X', aspectRatio: '1:1' }), /unsupported image/);
  assert.throws(() => smartAipiBaseUrl('http://api.smartaipi.com/v1'), /HTTPS/);
  assert.throws(() => smartAipiBaseUrl('https://user:secret@api.smartaipi.com/v1'), /credentials/);
});

test('timeout aborts without retrying a potentially billed request', async () => {
  let calls = 0;
  const client = new SmartAipiClient({ apiKey: 'test-only', timeoutMs: 10, fetchImpl: async (url, options) => {
    calls += 1;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }});
  await assert.rejects(client.generateImage({ model, prompt: 'X', aspectRatio: '1:1' }), /timed out/);
  assert.equal(calls, 1);
});

function storageDb({ failures = 0, row = { status: 'processing', refunded_at: null } } = {}) {
  const events = [];
  return { events,
    async execute() { return [[]]; },
    async getConnection() { return {
      async beginTransaction() { events.push('begin'); }, async rollback() { events.push('rollback'); }, async commit() { events.push('commit'); }, release() { events.push('release'); },
      async execute(sql, args) {
        if (sql.startsWith('SELECT')) return [[row].filter(Boolean)];
        if (sql.startsWith('INSERT')) { if (failures-- > 0) throw new Error('Simulated storage outage'); assert.deepEqual(args[2], png); events.push('image'); }
        if (sql.startsWith('UPDATE')) { assert.match(sql, /output_url='db:image'/); events.push('completed'); }
        return [{ affectedRows: 1 }];
      },
    }; },
  };
}

test('worker stores bytes and completion atomically and retries only storage', async () => {
  const worker = new GenerationWorker(); let calls = 0; let refunds = 0;
  worker.refundSmartImage = async () => refunds++;
  const client = { async generateImage() { calls++; return { mimeType: 'image/png', data: png }; } };
  const db = storageDb({ failures: 1 });
  await worker.processSmartImage(db, { id: 'job', model, prompt: 'X', aspect_ratio: '1:1' }, client);
  assert.deepEqual(db.events, ['begin', 'rollback', 'release', 'begin', 'image', 'completed', 'commit', 'release']);
  assert.equal(calls, 1); assert.equal(refunds, 0);
  await worker.processSmartImage(storageDb({ row: { status: 'failed', refunded_at: 'now' } }), { id: 'refunded', model }, client);
  assert.equal(refunds, 0);
});

test('worker refunds failures without retrying upstream; paused/disabled workers submit nothing', async () => {
  const worker = new GenerationWorker(); let refunds = 0; let calls = 0;
  worker.refundSmartImage = async (id, status, message) => { refunds++; assert.equal(status, 'failed'); assert.match(message, /refunded/); };
  const client = { async generateImage() { calls++; throw new Error('Simulated request failure'); } };
  await worker.processSmartImage(storageDb(), { id: 'failed', model }, client);
  assert.equal(calls, 1); assert.equal(refunds, 1);
  const unavailableDb = { async getConnection() { throw new Error('should not touch queue'); } };
  await worker.submitSmartImages(unavailableDb);
  worker.allowProviderCharges = true; worker.smartAipi = client; worker.smartAipiEnabled = false;
  await worker.submitSmartImages(unavailableDb);
});

test('worker claims with shared lock, access filter and inflight capacity; slow API does not block polls', async () => {
  const worker = new GenerationWorker(); const events = []; let resolveRender;
  worker.allowProviderCharges = true; worker.smartAipiEnabled = true; worker.smartAipiModels = defaultSmartImageConfig(); worker.smartAipiMaxInflight = 2;
  worker.smartAipi = { async generateImage() { return new Promise(resolve => { resolveRender = resolve; }); } };
  worker.refundSmartImage = async () => { throw new Error('Unexpected refund'); };
  const db = storageDb(); let claims = 0;
  const storageConnection = db.getConnection.bind(db);
  db.getConnection = async () => {
    if (events.includes('released')) return storageConnection();
    return {
      async query(sql) {
        if (sql.includes('GET_LOCK')) { events.push('lock'); return [[{ acquired: 1 }]]; }
        if (sql.includes('RELEASE_LOCK')) { events.push('unlock'); return [[{}]]; }
        if (sql.includes('COUNT')) return [[{ total: 1 }]];
        assert.match(sql, /COALESCE\(a.enabled,1\)=1/); assert.match(sql, /u.status='active'/);
        return [[{ id: 'job', model, prompt: 'X', aspect_ratio: '1:1' }, { id: 'second', model }]];
      },
      async execute() { claims++; return [{ affectedRows: 1 }]; }, release() { events.push('released'); },
    };
  };
  await worker.submitSmartImages(db); // Must return while render is still waiting.
  assert.equal(claims, 1); assert.deepEqual(events, ['lock', 'unlock', 'released']);
  assert.equal(worker.smartImageTasks.size, 1);
  resolveRender({ data: png, mimeType: 'image/png' });
  await Promise.all(worker.smartImageTasks);
  assert.ok(db.events.includes('commit'));
});

test('interrupted requests are refunded after expiry, with no resubmit and no overwrite of a completed job', async () => {
  const worker = new GenerationWorker(); const refunded = [];
  worker.refundSmartImage = async id => refunded.push(id);
  const db = {
    async query(sql) { assert.match(sql, /INTERVAL 10 MINUTE/); return [[{ id: 'interrupted', status: 'processing' }, { id: 'finished-race', status: 'processing' }, { id: 'refund-retry', status: 'submit_error' }]]; },
    async execute(sql, [id]) { assert.match(sql, /AND status='processing'/); return [{ affectedRows: id === 'finished-race' ? 0 : 1 }]; },
  };
  await worker.syncSmartImages(db);
  assert.deepEqual(refunded, ['interrupted', 'refund-retry']);
});

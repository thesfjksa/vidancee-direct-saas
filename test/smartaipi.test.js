const test = require('node:test');
const assert = require('node:assert/strict');
const { SmartAipiClient, smartAipiBaseUrl } = require('../src/provider/smartaipi.js');
const { DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD, SMART_IMAGE_MODELS, SMART_IMAGE_SIZES, SMART_IMAGE_QUALITIES, smartImageRatios, smartImageRequestSpec, defaultSmartImageConfig, normalizeSmartImageConfig, publicSmartImagePricing, smartImageQuote } = require('../src/smartaipi_images.js');
const { GenerationWorker } = require('../src/worker_admin_settings.js');
const { deflateSync } = require('node:zlib');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const model = SMART_IMAGE_MODELS[0].id;
const settings = () => ({ smartAipiEnabled: true, smartAipiApiKey: 'test-only', smartAipiCustomerCreditsPerUsd: DEFAULT_SMART_CUSTOMER_CREDITS_PER_USD, smartAipiModels: defaultSmartImageConfig() });

// Real, decodable PNG fixtures at the requested size, rather than a 1x1 image
// that would hide an upstream service ignoring the selected canvas.
function canvasPng(width, height) {
  function chunk(type, data) {
    const name = Buffer.from(type), content = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, content, suffix]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR',header), chunk('IDAT',deflateSync(Buffer.alloc((width+1)*height))), chunk('IEND',Buffer.alloc(0))]);
}

test('catalog is provider-neutral, price-gated and uses the configured credit multiplier', () => {
  const s = settings();
  assert.equal(publicSmartImagePricing(s).length, 5); // GPT Image 1 price intentionally unconfigured.
  const square = smartImageQuote(model, '1:1', s);
  const landscape = smartImageQuote(model, '3:2', s);
  assert.equal(square.sourceUsd, 0.0265);
  assert.equal(square.cost, 160);
  assert.equal(landscape.cost, 240);
  assert.equal(landscape.size, '1536x1024');
  assert.equal(publicSmartImagePricing(s)[0].costByAspectRatio['3:2'], landscape.cost);
  assert.equal(JSON.stringify(publicSmartImagePricing(s)).includes('smartaipi'), false);
  s.smartAipiEnabled = false; assert.deepEqual(publicSmartImagePricing(s), []);
  s.smartAipiEnabled = true; s.smartAipiApiKey = ''; assert.deepEqual(publicSmartImagePricing(s), []);
  s.smartAipiApiKey = 'test-only'; s.smartAipiModels[model].enabled = false;
  assert.throws(() => smartImageQuote(model, '1:1', s), /not enabled/);
  assert.throws(() => smartImageQuote(SMART_IMAGE_MODELS[3].id, '16:9', s), /aspect ratio/);
  assert.throws(() => normalizeSmartImageConfig({ [model]: { enabled: true, sourceUsd: -1 } }), /price/);
  assert.throws(() => normalizeSmartImageConfig({ unknown: { enabled: true, sourceUsd: 1 } }), /Unknown/);
});

test('SmartAIPI uses 160-credit baseline conversion and whole credits independently of global markup', () => {
  const s = settings();
  const oldMultiplier = process.env.CUSTOMER_CREDIT_MULTIPLIER;
  try {
    process.env.CUSTOMER_CREDIT_MULTIPLIER = '11';
    for (const spec of SMART_IMAGE_MODELS.slice(0, 3)) {
      assert.equal(smartImageQuote(spec.id, '1:1', s, 'low').cost, 19);
      assert.equal(smartImageQuote(spec.id, '1:1', s, 'medium').cost, 160);
      assert.equal(smartImageQuote(spec.id, '1:1', s, 'high').cost, 637);
    }
    delete s.smartAipiCustomerCreditsPerUsd; s.smartAipiCreditsPerUsd = 100;
    assert.equal(smartImageQuote(model, '1:1', s).cost, 160);
    s.smartAipiCustomerCreditsPerUsd = 10000;
    assert.equal(smartImageQuote(model, '1:1', s).cost, 265);
    for (const rate of [0, -1, Infinity, NaN]) {
      s.smartAipiCustomerCreditsPerUsd = rate;
      assert.throws(() => smartImageQuote(model, '1:1', s), /valid credit price/);
    }
  } finally {
    if (oldMultiplier === undefined) delete process.env.CUSTOMER_CREDIT_MULTIPLIER;
    else process.env.CUSTOMER_CREDIT_MULTIPLIER = oldMultiplier;
  }
});

test('the same 160-credit conversion applies to every SmartAIPI image model and quality', () => {
  const s = settings();
  s.smartAipiModels[SMART_IMAGE_MODELS[4].id] = { enabled: true, sourceUsd: 0.02, qualitySourceUsd: { low: 0.01, medium: 0.02, high: 0.03 } };
  const squarePrices = [[19,160,637],[19,160,637],[19,160,637],[28,103,405],[61,121,182],[16,34,109]];
  for (const [i,spec] of SMART_IMAGE_MODELS.entries()) {
    for (const [q,quality] of SMART_IMAGE_QUALITIES.entries()) {
      assert.equal(smartImageQuote(spec.id,'1:1',s,quality).cost,squarePrices[i][q]);
      assert.equal(publicSmartImagePricing(s).find(m=>m.id===spec.id).costByQuality[quality]['1:1'],squarePrices[i][q]);
    }
  }
  assert.equal(smartImageQuote(model,'9:16',s,'medium').cost,203);
  assert.equal(smartImageQuote(model,'3:2',s,'medium').cost,240);
  assert.equal(smartImageQuote(model,'3:1',s,'medium').cost,120);
});

test('model-specific presets and all three qualities map to valid API sizes', async () => {
  for (const spec of SMART_IMAGE_MODELS) {
    const ratios = smartImageRatios(spec.id);
    assert.equal(ratios.length, spec.freeformSizes ? 11 : 3);
    for (const ratio of ratios) for (const quality of SMART_IMAGE_QUALITIES) {
      const request = smartImageRequestSpec(spec.id, ratio, quality);
      const [width, height] = request.size.split('x').map(Number);
      const [a, b] = ratio.split(':').map(Number);
      assert.equal(width * b, height * a);
      assert.equal(width % 16, 0); assert.equal(height % 16, 0);
      assert.ok(width * height >= 655360 && width * height <= 8294400);
      assert.ok(Math.max(width, height) <= 3840 && Math.max(width, height) / Math.min(width, height) <= 3);
      const client = new SmartAipiClient({ apiKey: 'test-only', fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.size, SMART_IMAGE_SIZES[ratio]); assert.equal(body.quality, quality); assert.equal(body.model, spec.apiModel);
        assert.equal(body.output_format, 'png');
        assert.ok(body.prompt.startsWith('Test\n\nCanvas requirement:'));
        assert.ok(body.prompt.includes('aspect ratio of '+ratio));
        return Response.json({ data: [{ b64_json: canvasPng(width,height).toString('base64') }] });
      }});
      await client.generateImage({ model: spec.id, prompt: 'Test', aspectRatio: ratio, quality });
    }
  }
  assert.throws(() => smartImageRequestSpec(model, '4:1'), /aspect ratio/);
  for (const quality of ['auto', 'ultra', '', null, {}]) assert.throws(() => smartImageRequestSpec(model, '1:1', quality), /quality/);
});

test('quality estimates preserve legacy overrides and reject disabled or invalid rates', () => {
  const s = settings();
  s.smartAipiModels = normalizeSmartImageConfig({ [model]: { enabled: true, sourceUsd: 0.053 } });
  assert.equal(s.smartAipiModels[model].sourceUsd, 0.053);
  assert.equal(s.smartAipiModels[model].qualitySourceUsd.low, 0.006);
  assert.ok(Math.abs(s.smartAipiModels[model].qualitySourceUsd.high - 0.211) < 1e-12);
  assert.equal(smartImageQuote(model, '1:1', s).cost, 320);
  assert.equal(smartImageQuote(model, '16:9', s, 'low').cost, 46);
  assert.equal(smartImageQuote(model, '9:16', s, 'high').cost, 1613);
  s.smartAipiModels = normalizeSmartImageConfig({ [model]: { enabled: true, qualitySourceUsd: { low: 0.003, medium: 0, high: 0.1055 } } });
  const published = publicSmartImagePricing(s).find(m => m.id === model);
  assert.deepEqual(published.qualities, ['low', 'high']); assert.equal(published.defaultQuality, 'low');
  assert.equal(published.costByQuality.high['9:16'], smartImageQuote(model, '9:16', s, 'high').cost);
  assert.throws(() => smartImageQuote(model, '1:1', s, 'medium'), /enabled price/);
  for (const qualitySourceUsd of [{ high: -1 }, { high: Infinity }, { ultra: 1 }, []]) {
    assert.throws(() => normalizeSmartImageConfig({ [model]: { enabled: true, qualitySourceUsd } }), /price|pricing/);
  }
});

test('text generation maps all six IDs to the documented authenticated JSON endpoint', async () => {
  const outputBytes = canvasPng(1024,1536);
  for (const spec of SMART_IMAGE_MODELS) {
    const client = new SmartAipiClient({ apiKey: 'test-only', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.smartaipi.com/v1/images/generations');
      assert.equal(options.headers.Authorization, 'Bearer test-only');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.deepEqual({ ...body, prompt: 'A flower' }, { model: spec.apiModel, prompt: 'A flower', size: '1024x1536', quality: 'medium', output_format: 'png', n: 1 });
      assert.ok(body.prompt.startsWith('A flower\n\nCanvas requirement:'));
      assert.match(body.prompt, /portrait \(vertical\)/);
      return Response.json({ data: [{ b64_json: outputBytes.toString('base64') }] });
    }});
    const output = await client.generateImage({ model: spec.id, prompt: 'A flower', aspectRatio: '2:3' });
    assert.equal(output.mimeType, 'image/png'); assert.deepEqual(output.data, outputBytes);
    assert.deepEqual([output.width,output.height],[1024,1536]);
  }
});

test('reference edits send base64 bytes and enforce one valid reference before any paid call', async () => {
  let calls = 0;
  const client = new SmartAipiClient({ apiKey: 'test-only', fetchImpl: async (url, options) => {
    calls += 1; assert.equal(url, 'https://api.smartaipi.com/v1/images/edits');
    assert.equal(JSON.parse(options.body).image, png.toString('base64'));
    assert.equal(JSON.parse(options.body).output_format, 'png');
    return Response.json({ data: [{ b64_json: canvasPng(1024,1024).toString('base64') }] });
  }});
  await client.generateImage({ model, prompt: 'Edit', aspectRatio: '1:1', images: [{ data: png }] });
  await assert.rejects(client.generateImage({ model, prompt: 'Edit', aspectRatio: '1:1', images: [{ data: png }, { data: png }] }), /one reference/);
  await assert.rejects(client.generateImage({ model, prompt: 'Edit', aspectRatio: '1:1', images: [{ data: Buffer.from('text') }] }), /valid PNG/);
  assert.equal(calls, 1);
});

test('4:5 generation and edits enforce a portrait canvas and reject a landscape response without retrying', async () => {
  for (const spec of SMART_IMAGE_MODELS.slice(0,3)) for (const images of [[],[{data:png}]]) {
    let calls = 0;
    const client = new SmartAipiClient({ apiKey:'test-only', fetchImpl:async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.size,'1024x1280');assert.equal(body.model,spec.apiModel);
      assert.ok(body.prompt.startsWith('A cinematic wide landscape\n\n'));
      assert.match(body.prompt,/portrait \(vertical\).*aspect ratio of 4:5/);
      assert.match(body.prompt,/takes precedence/);
      return Response.json({data:[{b64_json:canvasPng(1536,1024).toString('base64')}]});
    }});
    await assert.rejects(client.generateImage({model:spec.id,prompt:'A cinematic wide landscape',aspectRatio:'4:5',images}), error => error.code==='IMAGE_ASPECT_RATIO_MISMATCH' && /1536x1024/.test(error.message));
    assert.equal(calls,1);
  }
  const client = new SmartAipiClient({ apiKey:'test-only', fetchImpl:async () => Response.json({data:[{b64_json:canvasPng(832,1040).toString('base64')}]}) });
  const output = await client.generateImage({model,prompt:'Portrait',aspectRatio:'4:5'});
  assert.deepEqual([output.width,output.height],[832,1040]);
  client.fetchImpl = async () => Response.json({data:[{b64_json:png.toString('base64')}]});
  await assert.rejects(client.generateImage({model,prompt:'X',aspectRatio:'4:5'}),/invalid canvas dimensions/);
  client.fetchImpl = async () => Response.json({data:[{b64_json:canvasPng(1024,1024).subarray(0,25).toString('base64')}]});
  await assert.rejects(client.generateImage({model,prompt:'X',aspectRatio:'1:1'}),/valid PNG canvas/);
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
  const qualities = [];
  const client = { async generateImage(input) { calls++; qualities.push(input.quality); return { mimeType: 'image/png', data: png }; } };
  const db = storageDb({ failures: 1 });
  await worker.processSmartImage(db, { id: 'job', model, prompt: 'X', aspect_ratio: '1:1', image_quality: 'high' }, client);
  assert.deepEqual(qualities, ['high']);
  assert.deepEqual(db.events, ['begin', 'rollback', 'release', 'begin', 'image', 'completed', 'commit', 'release']);
  assert.equal(calls, 1); assert.equal(refunds, 0);
  await worker.processSmartImage(storageDb({ row: { status: 'failed', refunded_at: 'now' } }), { id: 'refunded', model }, client);
  assert.equal(refunds, 0); assert.deepEqual(qualities, ['high', 'medium']);
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

test('a returned aspect-ratio mismatch refunds the image reservation and is never saved as completed or regenerated', async () => {
  const worker = new GenerationWorker(); let calls=0,refunds=0;
  const db = storageDb();
  worker.refundSmartImage = async (id,status,message) => {
    refunds++;assert.equal(id,'wrong-shape');assert.equal(status,'failed');
    assert.match(message,/wrong aspect ratio.*4:5/);assert.match(message,/Credits were refunded/);assert.match(message,/Reuse prompt/);
  };
  const client = new SmartAipiClient({apiKey:'test-only',fetchImpl:async () => {
    calls++;return Response.json({data:[{b64_json:canvasPng(1536,1024).toString('base64')}]});
  }});
  await worker.processSmartImage(db,{id:'wrong-shape',model,prompt:'Test',aspect_ratio:'4:5'},client);
  assert.equal(calls,1);assert.equal(refunds,1);assert.deepEqual(db.events,[]);
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
    async query(sql) { assert.match(sql, /updated_at < DATE_SUB\(UTC_TIMESTAMP\(\),INTERVAL 3 MINUTE\)/); return [[{ id: 'interrupted', status: 'processing' }, { id: 'finished-race', status: 'processing' }, { id: 'refund-retry', status: 'submit_error' }]]; },
    async execute(sql, [id]) { assert.match(sql, /AND status='processing'/); return [{ affectedRows: id === 'finished-race' ? 0 : 1 }]; },
  };
  await worker.syncSmartImages(db);
  assert.deepEqual(refunded, ['interrupted', 'refund-retry']);
});

test('GPT image requests still running in this worker send a heartbeat and are never expired', async () => {
  const worker = new GenerationWorker(); const refunded = []; const sql = [];
  worker.refundSmartImage = async id => refunded.push(id);
  worker.smartImageJobIds.add('running-here');
  const db = {
    async query(text, args) { sql.push([text, args]);
      if (text.startsWith('UPDATE generations SET updated_at')) return [{ affectedRows: 1 }];
      return [[{ id: 'running-here', status: 'processing' }, { id: 'abandoned', status: 'processing' }]]; },
    async execute(text, [id]) { return [{ affectedRows: 1 }]; },
  };
  await worker.syncSmartImages(db);
  assert.deepEqual(sql[0][1], [['running-here']]);
  assert.deepEqual(refunded, ['abandoned']);
});

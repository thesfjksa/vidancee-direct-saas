const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiPromptEnhancer, PromptEnhancementGate, normalizeEnhancement, GEMINI_ENHANCER_MODEL } = require('../src/prompt_enhancer.js');
const key = 'test-gemini-key-not-real';
const output = prompt => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Private reasoning' }, { text: prompt }] } }] });

test('Gemini maps image/video instructions, preserves input language and sends text only', async () => {
  for (const mediaType of ['image', 'video']) {
    let calls = 0;
    const client = new GeminiPromptEnhancer({ apiKey: key, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
      assert.equal(options.headers['x-goog-api-key'], key); assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.match(body.systemInstruction.parts[0].text, mediaType === 'image' ? /one still image/ : /coherent video shot/);
      assert.match(body.systemInstruction.parts[0].text, /Preserve the original/);
      const data = JSON.parse(body.contents[0].parts[0].text);
      assert.equal(data.prompt, 'بچہ ناچ رہا ہے — no text');
      assert.equal(data.imageReferences, 1); assert.equal(data.aspectRatio, '9:16');
      assert.equal(data.durationSeconds, mediaType === 'video' ? 10 : undefined);
      assert.equal(data.images, undefined); assert.equal(data.model, undefined);
      assert.equal(body.generationConfig.maxOutputTokens, 2048);
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
      return output('An enhanced scene');
    }});
    assert.deepEqual(await client.enhance({ prompt: 'بچہ ناچ رہا ہے — no text', mediaType, aspectRatio: '9:16', duration: 10, imageReferences: 1, images: ['must not forward'] }), { prompt: 'An enhanced scene', mediaType });
    assert.equal(calls, 1);
  }
});

test('both generation paths use a thinking level accepted by Gemini 3.8 Flash', async () => {
  const accepted = new Set(['low', 'medium', 'high']);
  let calls = 0;
  const client = new GeminiPromptEnhancer({ apiKey: key, fetchImpl: async (url, options) => {
    calls++;
    const level = JSON.parse(options.body).generationConfig.thinkingConfig.thinkingLevel;
    // Simulate the documented provider rejection which the old minimal request hit.
    if (!accepted.has(level)) return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unsupported thinking level' } }, { status: 400 });
    return output('Enhanced prompt');
  }});
  for (const mediaType of ['image', 'video']) {
    assert.equal((await client.enhance({ prompt: 'Cinematic dawn', mediaType })).prompt, 'Enhanced prompt');
  }
  assert.equal(calls, 2);
});

test('provider failure messages identify HTTP categories without exposing response bodies', async () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500, 503]) {
    let calls = 0;
    const client = new GeminiPromptEnhancer({ apiKey: key, fetchImpl: async () => {
      calls++;
      return Response.json({ error: { message: key + ' private prompt private provider details' } }, { status });
    }});
    await assert.rejects(client.enhance({ prompt: 'A sunrise', mediaType: 'image' }), e => {
      assert.equal(e.statusCode, status === 429 ? 429 : 502);
      assert.match(e.message, new RegExp('HTTP ' + status));
      assert.equal(e.message.includes(key), false);
      assert.equal(e.message.includes('private'), false);
      if (status === 429) assert.match(e.message, /quota or rate limit/);
      if (status === 503) assert.match(e.message, /temporarily unavailable/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('invalid inputs and blocked/truncated/empty/oversized output cannot reach generation', async () => {
  const client = new GeminiPromptEnhancer({ apiKey: key, fetchImpl: async () => { throw Error('must not call'); } });
  for (const input of [null, [], { prompt: 'x', mediaType: 'audio' }, { prompt: '', mediaType: 'image' }, { prompt: {}, mediaType: 'image' }, { prompt: 'x'.repeat(8001), mediaType: 'image' }]) {
    assert.throws(() => normalizeEnhancement(input), e => e.statusCode === 400);
    await assert.rejects(client.enhance(input), e => e.statusCode === 400);
  }
  for (const body of [
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Truncated' }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Reasoning only' }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x'.repeat(8001) }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: key }] } }] },
  ]) {
    client.fetchImpl = async () => Response.json(body);
    await assert.rejects(client.enhance({ prompt: 'Original', mediaType: 'image' }), e => [422, 502].includes(e.statusCode));
  }
});

test('connection check is read-only; failures and timeouts never echo secrets or retry', async () => {
  const client = new GeminiPromptEnhancer({ apiKey: key, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(url.endsWith('/' + GEMINI_ENHANCER_MODEL), true);
    return Response.json({ name: 'models/' + GEMINI_ENHANCER_MODEL, supportedGenerationMethods: ['generateContent'] });
  }});
  assert.deepEqual(await client.check(), { connected: true, model: GEMINI_ENHANCER_MODEL });
  client.fetchImpl = async () => Response.json({ error: key }, { status: 401 });
  await assert.rejects(client.check(), e => e.statusCode === 502 && !e.message.includes(key));
  client.fetchImpl = async () => { throw Error('Network error ' + key); };
  await assert.rejects(client.check(), e => !e.message.includes(key));
  let calls = 0;
  client.timeoutMs = 10;
  client.fetchImpl = async (url, options) => {
    calls++;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  };
  await assert.rejects(client.enhance({ prompt: 'A sunrise', mediaType: 'image' }), e => e.statusCode === 504);
  assert.equal(calls, 1);
});

test('request gate bounds user/global concurrency and rate, releases failures and expires idle users', async () => {
  let now = 0; let release;
  const gate = new PromptEnhancementGate({ now: () => now, perMinute: 2, maxInflight: 1 });
  const first = gate.run(1, () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(gate.run(1, async () => {}), e => e.statusCode === 429);
  await assert.rejects(gate.run(2, async () => {}), e => e.statusCode === 429);
  release(); await first;
  await assert.rejects(gate.run(1, async () => { throw Error('Failure'); }), /Failure/);
  assert.equal(gate.inflight, 0);
  await assert.rejects(gate.run(1, async () => {}), e => e.statusCode === 429);
  now = 60000;
  await gate.run(2, async () => {});
  assert.equal(gate.users.has(1), false);
  await gate.run(1, async () => {});
});

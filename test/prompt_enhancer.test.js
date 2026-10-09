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
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
      return output('An enhanced scene');
    }});
    assert.deepEqual(await client.enhance({ prompt: 'بچہ ناچ رہا ہے — no text', mediaType, aspectRatio: '9:16', duration: 10, imageReferences: 1, images: ['must not forward'] }), { prompt: 'An enhanced scene', mediaType });
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

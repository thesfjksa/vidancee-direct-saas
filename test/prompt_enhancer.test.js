const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiPromptEnhancer, PromptEnhancementGate, PromptEnhancementJobs, normalizeEnhancement, GEMINI_ENHANCER_MODEL, ENHANCEMENT_TIMEOUT_MS } = require('../src/prompt_enhancer.js');
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
  for (const status of [400, 401, 402, 403, 404, 429, 500, 503, 504]) {
    let calls = 0;
    const client = new GeminiPromptEnhancer({ apiKey: key, retryDelaysMs: [1, 1], fetchImpl: async () => {
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
    assert.equal(calls, status === 503 ? 3 : 1);
  }
});

test('explicit 503 rejections recover within the same background job and stop after success', async () => {
  let calls = 0;
  const requests = [];
  const client = new GeminiPromptEnhancer({ apiKey: key, retryDelaysMs: [1, 2], fetchImpl: async (url, options) => {
    calls++; requests.push({ url, body: options.body });
    return calls < 3 ? Response.json({ error: 'Unavailable' }, { status: 503 }) : output('A recovered sunrise');
  }});
  const jobs = new PromptEnhancementJobs();
  const input = { prompt: 'A sunrise', mediaType: 'image', requestId: '00000000-0000-4000-8000-000000000001' };
  const first = jobs.start(1, input, () => client.enhance(input));
  assert.equal(first.status, 'processing');
  assert.deepEqual(jobs.start(1, input, () => { throw Error('Must reuse existing job'); }), first);
  for (let i = 0; i < 50 && jobs.get(1, first.jobId).status === 'processing'; i++) await new Promise(r => setTimeout(r, 2));
  const done = jobs.get(1, first.jobId);
  assert.equal(done.status, 'completed'); assert.equal(done.prompt, 'A recovered sunrise');
  assert.equal(calls, 3); assert.deepEqual(requests[0], requests[1]); assert.deepEqual(requests[1], requests[2]);
  assert.deepEqual(jobs.getByRequest(1, input.requestId), done);
  assert.deepEqual(jobs.start(1, input, () => client.enhance(input)), done); assert.equal(calls, 3);
});

test('503 retry waits share one deadline; subsequent connection failures and metadata checks are never retried', async () => {
  let calls = 0;
  const client = new GeminiPromptEnhancer({ apiKey: key, timeoutMs: 10, retryDelaysMs: [50, 50], fetchImpl: async () => {
    calls++; return Response.json({ error: key }, { status: 503 });
  }});
  await assert.rejects(client.enhance({ prompt: 'A sunrise', mediaType: 'image' }), e => e.statusCode === 504);
  assert.equal(calls, 1);
  calls = 0; client.timeoutMs = 200; client.retryDelaysMs = [1, 1];
  client.fetchImpl = async () => { calls++; if (calls === 1) return Response.json({}, { status: 503 }); throw Error('Connection lost '+key); };
  await assert.rejects(client.enhance({ prompt: 'A sunrise', mediaType: 'video' }), e => /could not connect/.test(e.message) && !e.message.includes(key));
  assert.equal(calls, 2);
  calls = 0; client.fetchImpl = async () => { calls++; return Response.json({}, { status: 503 }); };
  await assert.rejects(client.check(), /HTTP 503/); assert.equal(calls, 1);
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

test('slow responses get a two-minute allowance, but stalled bodies still abort without retries', async () => {
  const client = new GeminiPromptEnhancer({ apiKey: key });
  assert.equal(ENHANCEMENT_TIMEOUT_MS,120000); assert.equal(client.timeoutMs,120000);
  // Scaled timings exercise both a delayed success and the body-reading deadline.
  client.timeoutMs=200;
  client.fetchImpl=async()=>{await new Promise(r=>setTimeout(r,60));return output('A slowly enhanced scene');};
  assert.equal((await client.enhance({prompt:'A sunrise',mediaType:'image'})).prompt,'A slowly enhanced scene');
  let aborted=false,calls=0;
  client.timeoutMs=10;
  client.fetchImpl=async(url,options)=>{
    calls++;
    return {ok:true,body:{async *[Symbol.asyncIterator](){
      await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('aborted','AbortError'));}));
    }}};
  };
  await assert.rejects(client.enhance({prompt:'A sunrise',mediaType:'video'}),e=>e.statusCode===504);
  assert.equal(aborted,true);assert.equal(calls,1);
});

test('background jobs return immediately, isolate owners and deduplicate reconnects and completed requests',async()=>{
  let now=0,release,calls=0;
  const gate=new PromptEnhancementGate({now:()=>now,perMinute:2});
  const jobs=new PromptEnhancementJobs({gate,now:()=>now,retentionMs:10});
  const input={prompt:'A sunrise',mediaType:'image',requestId:'00000000-0000-4000-8000-000000000001'};
  const task=()=>{calls++;return new Promise(r=>{release=r;});};
  const first=jobs.start(1,input,task);assert.equal(first.status,'processing');
  await new Promise(r=>setImmediate(r));
  assert.equal(calls,1);assert.equal(gate.inflight,1);
  assert.deepEqual(jobs.start(1,input,task),first);assert.equal(calls,1);
  assert.deepEqual(jobs.getByRequest(1,input.requestId),first);assert.equal(jobs.getByRequest(2,input.requestId),null);assert.equal(jobs.getByRequest(1,'missing'),null);
  assert.equal(jobs.get(2,first.jobId),null);assert.equal(JSON.stringify(first).includes(input.prompt),false);
  assert.throws(()=>jobs.start(1,{...input,prompt:'Different'},task),e=>e.statusCode===409);
  assert.throws(()=>jobs.start(1,{...input,requestId:'bad'},task),e=>e.statusCode===400);
  assert.throws(()=>jobs.start(1,{...input,requestId:'00000000-0000-4000-8000-000000000002'},task),e=>e.statusCode===429);
  release({prompt:'Enhanced sunrise',mediaType:'image'});await new Promise(r=>setImmediate(r));
  const done=jobs.get(1,first.jobId);assert.equal(done.status,'completed');assert.equal(done.prompt,'Enhanced sunrise');
  assert.equal(gate.inflight,0);assert.deepEqual(jobs.start(1,input,task),done);assert.equal(calls,1);
  now=10;assert.equal(jobs.get(1,first.jobId),null);assert.equal(jobs.requests.size,0);assert.equal(jobs.getByRequest(1,input.requestId),null);
});

test('background failures stay available without exposing secrets or automatically restarting',async()=>{
  const gate=new PromptEnhancementGate(),jobs=new PromptEnhancementJobs({gate,maxEntries:1});
  const input={prompt:'A sunrise',mediaType:'video',requestId:'00000000-0000-4000-8000-000000000001'};
  let calls=0;
  const client=new GeminiPromptEnhancer({apiKey:key,timeoutMs:10,fetchImpl:async(url,options)=>{
    calls++;return new Promise((r,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  }});
  const job=jobs.start(1,input,()=>client.enhance(input));
  await new Promise(r=>setTimeout(r,30));
  const failed=jobs.get(1,job.jobId);assert.equal(failed.status,'failed');assert.equal(failed.statusCode,504);
  assert.match(failed.error,/timed out/);assert.equal(gate.inflight,0);
  assert.deepEqual(jobs.start(1,input,()=>client.enhance(input)),failed);assert.equal(calls,1);
  assert.throws(()=>jobs.start(2,{...input,requestId:'00000000-0000-4000-8000-000000000002'},()=>{}),e=>e.statusCode===429);
  const other=new PromptEnhancementJobs();
  const unexpected=other.start(2,input,()=>{throw Object.assign(Error(key),{statusCode:400});});
  await new Promise(r=>setImmediate(r));
  assert.equal(JSON.stringify(other.get(2,unexpected.jobId)).includes(key),false);
});

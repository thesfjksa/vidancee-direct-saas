const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const client = html.slice(html.indexOf('const enhancedPromptCache='), html.indexOf('async function createImageGeneration()'));
const requestId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-000000000002';
const processing = { jobId, status: 'processing' };
const completed = { jobId, status: 'completed', prompt: 'Enhanced sunrise', mediaType: 'image' };
const httpError = status => Object.assign(new Error('HTTP '+status), { status });
const timeout = () => new DOMException('Timed out', 'TimeoutError');

function harness(respond) {
  let clock = 0;
  const calls = [], deadlines = [];
  const elements = {
    imagePrompt: { value: 'A sunrise' }, imageRatio: { value: '1:1' },
    imagePromptEnhancer: { checked: true }, imageEnhancerNote: {},
  };
  const ctx = vm.createContext({
    config: { promptEnhancer: { timeoutMs: 120000 } },
    $: id => elements[id], imageReferenceItems: ['reference'], referenceItems: [], videoReferenceItems: [],
    crypto: { randomUUID: () => requestId },
    Date: { now: () => clock },
    setTimeout: (callback, ms) => { clock += ms; callback(); },
    AbortSignal: { timeout: ms => { deadlines.push(ms); return {}; } },
    api: async (path, options = {}) => { calls.push({ path, options }); return respond(path, options, () => { clock += 20000; }); },
  });
  vm.runInContext(client, ctx);
  const message = {};
  return { ctx, calls, deadlines, elements, message, run: () => ctx.prepareGenerationPrompt('image', message), pending: () => vm.runInContext('pendingEnhancementRequests.image', ctx) };
}

test('a lost initial response recovers the accepted job with GET, without another paid POST', async () => {
  const h = harness((path, options) => {
    if (options.method === 'POST') throw timeout();
    assert.equal(path, '/api/prompts/enhance/requests/'+requestId);
    return completed;
  });
  assert.equal(await h.run(), 'Enhanced sunrise');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.deadlines, [30000, 20000]);
  assert.equal(h.elements.imagePrompt.value, 'Enhanced sunrise');
  assert.equal(h.pending(), null);
  assert.equal(await h.run(), 'Enhanced sunrise');
  assert.equal(h.calls.length, 2); // Successful text remains cached for a generation retry.
});

test('recovery tolerates a not-yet-visible request and transient status failures', async () => {
  let reads = 0;
  const h = harness((path, options) => {
    if (options.method === 'POST') throw new TypeError('Connection lost');
    reads++;
    if (reads === 1) throw httpError(404);
    if (reads === 2) return processing;
    assert.equal(path, '/api/prompts/enhance/'+jobId);
    if (reads === 3) throw timeout();
    if (reads === 4) throw httpError(503);
    return completed;
  });
  assert.equal(await h.run(), 'Enhanced sunrise');
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
});

test('an incomplete initial response also recovers through the read-only request lookup', async () => {
  const h = harness((path, options) => {
    if (options.method === 'POST') return { ok: false, error: 'Invalid server response' };
    assert.equal(path, '/api/prompts/enhance/requests/'+requestId);
    return completed;
  });
  assert.equal(await h.run(), 'Enhanced sunrise');
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
});

test('an unconfirmed start preserves the prompt and only retries POST after another user action', async () => {
  let posts = 0;
  const h = harness((path, options, advance) => {
    if (options.method === 'POST') { posts++; if (posts === 1) throw timeout(); return completed; }
    advance(); throw httpError(404);
  });
  await assert.rejects(h.run(), /server did not confirm/);
  assert.equal(h.elements.imagePrompt.value, 'A sunrise');
  assert.equal(posts, 1); assert.equal(h.pending().requestId, requestId);
  assert.equal(h.pending().recovering, false);
  assert.equal(await h.run(), 'Enhanced sunrise');
  assert.equal(posts, 2);
  for (const call of h.calls.filter(c => c.options.method === 'POST')) {
    assert.equal(JSON.parse(call.options.body).requestId, requestId);
  }
});

test('billing, quota and completed job failures remain distinct from connection timeouts', async () => {
  for (const status of [402, 429]) {
    const h = harness(() => { throw httpError(status); });
    await assert.rejects(h.run(), e => e.status === status);
    assert.equal(h.calls.length, 1); assert.equal(h.pending(), null);
    assert.equal(h.elements.imagePrompt.value, 'A sunrise');
  }
  const h = harness((path, options) => options.method === 'POST' ? processing : { jobId, status: 'failed', error: 'API quota reached (HTTP 429)' });
  await assert.rejects(h.run(), /API quota reached/);
  assert.equal(h.pending(), null); assert.equal(h.elements.imagePrompt.value, 'A sunrise');
});

test('an interrupted polling connection resumes the known job on retry without POST', async () => {
  let disconnected = true;
  const h = harness((path, options, advance) => {
    if (options.method === 'POST') return processing;
    if (disconnected) { advance(); throw timeout(); }
    return completed;
  });
  await assert.rejects(h.run(), /Connection to the site was interrupted/);
  assert.equal(h.pending().jobId, jobId);
  assert.equal(h.elements.imagePrompt.value, 'A sunrise');
  disconnected = false;
  assert.equal(await h.run(), 'Enhanced sunrise');
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
});

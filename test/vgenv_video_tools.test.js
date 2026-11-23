'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VgenvClient } = require('../src/provider/vgenv.js');
const { prepareVideoTool, validateSourceQuote } = require('../src/vgenv_video_tools.js');

function box(type, ...data) {
  const body = Buffer.concat(data);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4);
  return Buffer.concat([header, body]);
}

function mp4(audio = true) {
  const duration = Buffer.alloc(20);
  duration.writeUInt32BE(1000, 12);
  duration.writeUInt32BE(12000, 16);
  const track = type => box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(type))));
  return Buffer.concat([
    box('ftyp', Buffer.from('isom', 'ascii')), box('mdat', Buffer.from([1])),
    box('moov', box('mvhd', duration), track('vide'), ...(audio ? [track('soun')] : [])),
  ]);
}

function input(tool, audio = true) {
  return {
    tool, duration: 6, aspectRatio: '9:16', permission: 'accepted', preserveAudio: 'true',
    images: [{ mimeType: 'image/jpeg', data: Buffer.from([1]) }],
    videos: [{ mimeType: 'video/mp4', data: mp4(audio) }],
    instructions: tool === 'object-swap' ? 'Replace the bottle by the sink.' : '',
  };
}

test('edits validate consent, media and actual time range before charging', () => {
  const request = input('character-swap');
  assert.equal(prepareVideoTool({ ...request, motionStart: 6 }).options.motionStart, 6);
  assert.throws(() => prepareVideoTool({ ...request, motionStart: 7 }), /time range/);
  assert.throws(() => prepareVideoTool({ ...request, permission: '' }), /permission/);
  assert.throws(() => prepareVideoTool(input('motion-control', false)), /no source audio/);
  assert.equal(prepareVideoTool({ ...input('motion-control', false), preserveAudio: false }).options.preserveAudio, false);
  assert.throws(() => prepareVideoTool({ ...input('object-swap'), instructions: '' }), /Describe the object/);
  assert.throws(() => prepareVideoTool({ ...input('object-swap'), motionStart: 3 }), /valid start time/);
  assert.throws(() => prepareVideoTool({ ...request, videos: [{ mimeType: 'video/mp4', data: Buffer.from('not MP4') }] }), /could not be read/);
});

test('provider quotes and paid submissions use the same supported V3 payload for each tool', async () => {
  const calls = [];
  const client = new VgenvClient({ apiKey: 'test-only' });
  client.request = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body), headers: options.headers });
    return { id: 'video-1', status: 'preparing', price: { currency: 'USD', amount_micros: 18000 } };
  };
  for (const tool of ['character-swap', 'motion-control', 'object-swap']) {
    const { generation, quote, options } = prepareVideoTool(input(tool));
    const params = {
      ...generation, model: 'base', referenceImageUrls: ['https://media.example/image.jpg'],
      referenceVideoAssetId: 'asset_source', idempotencyKey: 'job-' + tool,
      videoEdit: { ...options, replacement: quote.tool.replacement },
    };
    const price = await client.quoteVideoEdit(params);
    validateSourceQuote(price, tool, generation.duration);
    const created = await client.generateVideo(params);
    assert.equal(created.id, 'video-1');
    const [quoted, submitted] = calls.splice(0);
    assert.equal(quoted.path, '/v3/videos/quote');
    assert.equal(submitted.path, '/v3/videos');
    assert.equal(submitted.headers['Idempotency-Key'], 'job-' + tool);
    assert.deepEqual(quoted.body, submitted.body);
    assert.deepEqual(submitted.body.reference_video, { asset_id: 'asset_source' });
    assert.equal(submitted.body.reference_images.length, 1);
    assert.equal(submitted.body.preserve_source_audio, true);
    if (tool === 'object-swap') {
      assert.equal(submitted.body.creation_intent, undefined);
      assert.match(submitted.body.prompt, /Replace the bottle by the sink/);
    } else {
      assert.equal(submitted.body.creation_intent, 'person_replacement');
      assert.equal(submitted.body.prompt_optimization, undefined);
    }
  }
  assert.throws(() => validateSourceQuote({ currency: 'USD', price: 0.20 }, 'object-swap', 6), /price changed/);
  assert.throws(() => validateSourceQuote({ currency: 'UNKNOWN', price: 0.01 }, 'object-swap', 6), /usable price/);
});

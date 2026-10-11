const test = require('node:test');
const assert = require('node:assert/strict');
const { attachReusedImageReferences } = require('../src/reference_reuse.js');

const SOURCE = '7abb32c0-621f-4920-a790-5a7a2e13e824';
function fakeDb(rows) {
  const calls = [];
  return { calls, async execute(sql, args) {
    calls.push(args);
    const [generationId, userId, ...ids] = args;
    return [rows.filter(row => row.generation_id === generationId && row.user_id === userId && ids.includes(row.id))];
  } };
}
const stored = [
  { id: 1, generation_id: SOURCE, user_id: 7, filename: 'a.jpg', mime_type: 'image/jpeg', image_data: Buffer.from('A') },
  { id: 2, generation_id: SOURCE, user_id: 7, filename: 'b.png', mime_type: 'image/png', image_data: Buffer.from('B') },
];

test('reused and uploaded references keep the customer order', async () => {
  const upload = { filename: 'new.webp', mimeType: 'image/webp', data: Buffer.from('N') };
  const body = { reuseGenerationId: SOURCE, referenceOrder: JSON.stringify([{ kind: 'reused', id: 2 }, { kind: 'upload' }, { kind: 'reused', id: 1 }]), images: [upload] };
  await attachReusedImageReferences(fakeDb(stored), 7, body);
  assert.deepEqual(body.images.map(image => image.data.toString()), ['B', 'N', 'A']);
  assert.equal(body.images[0].mimeType, 'image/png');
  assert.equal(body.referenceOrder, undefined);
});

test('requests without a reference order are untouched and make no query', async () => {
  const db = fakeDb(stored); const body = { images: [] };
  await attachReusedImageReferences(db, 7, body);
  assert.deepEqual(body.images, []);
  assert.equal(db.calls.length, 0);
});

test('another customer cannot reuse references they do not own', async () => {
  const body = { reuseGenerationId: SOURCE, referenceOrder: JSON.stringify([{ kind: 'reused', id: 1 }]), images: [] };
  await assert.rejects(attachReusedImageReferences(fakeDb(stored), 8, body), error => error.statusCode === 400 && /no longer available/.test(error.message));
});

test('malformed orders are rejected', async () => {
  const cases = [
    { referenceOrder: 'not json', images: [] },
    { referenceOrder: JSON.stringify([{ kind: 'upload' }, { kind: 'upload' }]), images: [{}] },
    { reuseGenerationId: SOURCE, referenceOrder: JSON.stringify([{ kind: 'reused', id: 1 }, { kind: 'reused', id: 1 }]), images: [] },
    { reuseGenerationId: 'bad', referenceOrder: JSON.stringify([{ kind: 'reused', id: 1 }]), images: [] },
    { referenceOrder: JSON.stringify(Array.from({ length: 13 }, () => ({ kind: 'upload' }))), images: Array(13).fill({}) },
  ];
  for (const body of cases) await assert.rejects(attachReusedImageReferences(fakeDb(stored), 7, body), error => error.statusCode === 400);
});

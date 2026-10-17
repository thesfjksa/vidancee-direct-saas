const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The studio's @ mention code, run on its own with stand-in reference lists.
const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const client = html.slice(html.indexOf('const MENTION_PROMPTS='), html.indexOf('let mentionState=null;'));

function harness(prompt, lists) {
  const box = { value: prompt, dispatchEvent() {} };
  const ctx = vm.createContext({ $: id => (id === 'prompt' || id === 'imagePrompt' ? box : null), Event: class { constructor(type) { this.type = type; } },
    referenceItems: [], videoReferenceItems: [], audioReferenceItems: [], imageReferenceItems: [], ...lists });
  vm.runInContext(client, ctx);
  return { ctx, box };
}
const ref = (key, role = 'image_references') => ({ key, role, filename: key + '.png', url: 'blob:' + key });

test('references are named per type in list order; frames have no name', () => {
  const { ctx } = harness('', { referenceItems: [ref('a', 'start_image'), ref('b'), ref('c')], videoReferenceItems: [ref('v')], audioReferenceItems: [ref('s', 'audio_references')] });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.mentionEntries('video').map(e => [e.key, e.token]))), [['b', '@Image1'], ['c', '@Image2'], ['v', '@Video1'], ['s', '@Audio1']]);
  assert.equal(ctx.mentionToken('video', 'a'), '');
  const img = harness('', { imageReferenceItems: [ref('x'), ref('y')] });
  assert.deepEqual(JSON.parse(JSON.stringify(img.ctx.mentionEntries('image').map(e => e.token))), ['@Image1', '@Image2']);
});

test('removing or reordering a reference renumbers the mentions in the prompt', () => {
  const h = harness('@Image1 hugs @Image2 while @Audio1 plays, @image2 smiles.', { referenceItems: [ref('a'), ref('b')], audioReferenceItems: [ref('s', 'audio_references')] });
  let before = h.ctx.mentionMap('video');
  h.ctx.referenceItems.splice(0, 1); // remove a
  h.ctx.renumberMentions('video', before);
  // a's mention goes (with one space); b was @Image2 and is now @Image1.
  assert.equal(h.box.value, 'hugs @Image1 while @Audio1 plays, @Image1 smiles.');
  const mid = harness('Then @Image1 waves and @Image2.', { referenceItems: [ref('a'), ref('b')] });
  before = mid.ctx.mentionMap('video');
  mid.ctx.referenceItems.splice(1, 1); // remove b
  mid.ctx.renumberMentions('video', before);
  assert.equal(mid.box.value, 'Then @Image1 waves and.');

  const r = harness('@Image1 then @Image2, not @Image9 or @Video1.', { referenceItems: [ref('a'), ref('b')] });
  before = r.ctx.mentionMap('video');
  r.ctx.referenceItems.reverse(); // reorder
  r.ctx.renumberMentions('video', before);
  // Mentions follow their file; names that point at nothing are left as typed.
  assert.equal(r.box.value, '@Image2 then @Image1, not @Image9 or @Video1.');
});

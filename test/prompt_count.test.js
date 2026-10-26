const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The counter under each prompt box, run on its own with stand-in elements.
const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const client = html.slice(html.indexOf('function updatePromptCount('), html.indexOf('function updatePromptCounts('));

function harness(prompt) {
  const classes = new Set();
  const box = { value: prompt };
  const count = { textContent: '', classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } };
  const ctx = vm.createContext({ $: id => ({ prompt: box, promptCount: count })[id] || null });
  vm.runInContext(client, ctx);
  return { ctx, count, classes };
}

test('the counter shows the model limit and marks a prompt over it', () => {
  const h = harness('x'.repeat(1234));
  h.ctx.updatePromptCount('prompt', 'promptCount', { promptMaxChars: 8000 });
  assert.equal(h.count.textContent, '1,234 / 8,000 characters allowed for this model');
  assert.equal(h.classes.has('over'), false);
  h.ctx.updatePromptCount('prompt', 'promptCount', { promptMaxChars: 1000 });
  assert.equal(h.classes.has('over'), true);
});

test('models without a stated limit show the app-wide 50,000', () => {
  const h = harness('');
  h.ctx.updatePromptCount('prompt', 'promptCount', null);
  assert.equal(h.count.textContent, '0 / 50,000 characters allowed for this model');
});

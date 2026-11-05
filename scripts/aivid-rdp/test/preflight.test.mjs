import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJob, prepareMiniForm } from '../preflight.mjs';

test('validates Mini text-only input before touching the browser', () => {
  assert.deepEqual(validateJob({ prompt: '  A simple scene  ', duration: 15 }),
    { prompt: 'A simple scene', duration: 15, aspectRatio: '16:9' });
  assert.throws(() => validateJob({ prompt: 'x', duration: 16 }), /4 to 15/);
  assert.throws(() => validateJob({ prompt: 'x', duration: 5, images: ['private.jpg'] }), /text-only/);
});

test('preflight stops before browser changes when the session is signed out', async () => {
  let touched = false;
  const page = { url: () => 'https://aivid.dev/', getByRole: () => ({ isVisible: async () => true }),
    getByPlaceholder: () => { touched = true; } };
  await assert.rejects(prepareMiniForm(page, { prompt: 'test', duration: 5 }), /Sign in/);
  assert.equal(touched, false);
});

test('refuses unexpected origins before entering a customer prompt', async () => {
  const page = { url: () => 'https://fake-aivid.dev/' };
  await assert.rejects(prepareMiniForm(page, { prompt: 'test', duration: 5 }), /Unexpected/);
});

test('prepares one Mini form and never clicks Generate', async () => {
  let model = 'Seedance 2.5', prompt = '', duration = '15', ratio = '16:9';
  let generateClicks = 0;
  const page = {
    url: () => 'https://aivid.dev/',
    getByRole: (role, { name }) => {
      if (String(name) === 'Sign In') return { isVisible: async () => false };
      if (String(name) === '/Seedance|MiniMax/') return { first: () => ({ click: async () => {} }) };
      if (String(name) === '/^Seedance 2\\.0 \\(Mini\\)/') return { click: async () => { model = 'Seedance 2.0 (Mini)'; } };
      if (name === 'Seedance 2.0 (Mini)') return { innerText: async () => model };
      if (String(name) === '/^\\d+:\\d+$/') return { innerText: async () => ratio, click: async () => {} };
      if (name === ratio) return { count: async () => 1 };
      if (name === 'Generate') return { click: async () => { generateClicks++; } };
      throw new Error('Unexpected browser control: ' + role + ' ' + name);
    },
    getByPlaceholder: () => ({ fill: async value => { prompt = value; }, inputValue: async () => prompt }),
    locator: () => ({ count: async () => 1, fill: async value => { duration = value; }, inputValue: async () => duration }),
  };
  assert.equal((await prepareMiniForm(page, { prompt: 'hello', duration: 5 })).readyForHumanReview, true);
  assert.equal(generateClicks, 0);
  assert.equal(duration, '5');
  assert.equal(prompt, 'hello');
});

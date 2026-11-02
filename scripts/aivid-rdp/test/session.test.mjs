import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAividSession } from '../session.mjs';

function scenario(stateAt) {
  let time = 0, touches = 0;
  const state = () => stateAt(time);
  const page = {
    isClosed: () => !!state().closed,
    url: () => state().origin || 'https://aivid.dev/',
    getByRole: (_, { name }) => name === 'Sign In'
      ? { isVisible: async () => !!state().signIn }
      : { first: () => ({ isVisible: async () => !!state().model }) },
    getByPlaceholder: () => ({ isVisible: async () => !!state().prompt }),
  };
  return { page, options: { now: () => time, delay: async ms => { time += ms; touches++; } },
    elapsed: () => time, polls: () => touches };
}

test('waits through an initial Sign In frame and delayed automatic session restoration', async () => {
  const s = scenario(t => ({ signIn: t < 3000, prompt: true, model: true }));
  const result = await waitForAividSession(s.page, s.options);
  assert.equal(result.ready, true);
  assert.equal(result.waitedMs, 4000);
});

test('an empty initial page is not treated as authenticated', async () => {
  const s = scenario(t => ({ signIn: false, prompt: t >= 2000, model: t >= 2000 }));
  await waitForAividSession(s.page, s.options);
  assert.equal(s.elapsed(), 3000);
});

test('a short ready-state flicker must settle before the runner proceeds', async () => {
  const s = scenario(t => ({ signIn: t >= 500 && t < 2500, prompt: true, model: true }));
  await waitForAividSession(s.page, s.options);
  assert.equal(s.elapsed(), 3500);
});

test('a genuinely signed-out session gets the full wait and an actionable error', async () => {
  const s = scenario(() => ({ signIn: true, prompt: true, model: true }));
  await assert.rejects(waitForAividSession(s.page, { ...s.options, timeoutMs: 5000 }),
    error => error.code === 'AIVID_SIGNED_OUT' && /after 5 seconds/.test(error.message));
  assert.equal(s.elapsed(), 5000);
});

test('an unavailable form gets a loading error instead of a false sign-in diagnosis', async () => {
  const s = scenario(() => ({ signIn: false, prompt: false, model: false }));
  await assert.rejects(waitForAividSession(s.page, { ...s.options, timeoutMs: 2000 }),
    error => error.code === 'AIVID_PAGE_NOT_READY');
  assert.equal(s.elapsed(), 2000);
});

test('zero credits do not affect session readiness or trigger paid actions', async () => {
  const s = scenario(() => ({ signIn: false, prompt: true, model: true, credits: 0 }));
  // The fake page deliberately offers no fill/click or billing API.
  assert.equal((await waitForAividSession(s.page, s.options)).ready, true);
});

test('closed browsers and unexpected origins stop without waiting or reading form controls', async () => {
  for (const state of [{ closed: true }, { origin: 'https://accounts.google.com/' }]) {
    const s = scenario(() => state);
    await assert.rejects(waitForAividSession(s.page, s.options), /closed|Unexpected/);
    assert.equal(s.polls(), 0);
  }
});

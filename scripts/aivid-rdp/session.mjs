export const SESSION_TIMEOUT_MS = 45_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// AIVID initially renders Sign In while restoring its saved browser session.
// Require a stable, usable form after that button disappears, rather than
// interpreting the first rendered frame as the final authentication state.
export async function waitForAividSession(page, {
  timeoutMs = SESSION_TIMEOUT_MS, stableMs = 1000, pollMs = 250,
  now = Date.now, delay = sleep,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(stableMs) || stableMs < 0
    || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid session wait settings.');
  const started = now();
  let readySince = null, signInVisible = false;
  while (true) {
    if (page.isClosed()) throw new Error('The AIVID browser was closed before its session was ready.');
    if (new URL(page.url()).origin !== 'https://aivid.dev')
      throw new Error('Unexpected page origin while waiting for AIVID. Complete sign-in using AIVID-Login.exe.');
    signInVisible = await page.getByRole('button', { name: 'Sign In', exact: true }).isVisible();
    const promptVisible = await page.getByPlaceholder(/^Describe your video idea/).isVisible();
    const modelVisible = await page.getByRole('button', { name: /Seedance|MiniMax/ }).first().isVisible();
    const time = now();
    if (!signInVisible && promptVisible && modelVisible) {
      if (readySince === null) readySince = time;
      if (time - readySince >= stableMs) return { ready: true, waitedMs: time - started };
    } else readySince = null;
    if (time - started >= timeoutMs) break;
    await delay(Math.min(pollMs, timeoutMs - (time - started)));
  }
  const seconds = Math.round(timeoutMs / 1000);
  const message = signInVisible
    ? `AIVID still shows Sign In after ${seconds} seconds. Use AIVID-Login.exe from this same folder, complete AIVID sign-in, close its Chrome windows and retry.`
    : `AIVID's session or generation form did not finish loading within ${seconds} seconds. Check the visible browser page and connection.`;
  const error = new Error(message);
  error.code = signInVisible ? 'AIVID_SIGNED_OUT' : 'AIVID_PAGE_NOT_READY';
  throw error;
}

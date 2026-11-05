import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForAividSession } from './session.mjs';

export const AIVID_URL = 'https://aivid.dev/';
export const MINI_LABEL = 'Seedance 2.0 (Mini)';

export function launchAividBrowser(chromium, profile) {
  return chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, acceptDownloads: false, chromiumSandbox: true,
  });
}

export function validateJob(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Job must be a JSON object.');
  const prompt = String(value.prompt ?? '').trim();
  const duration = Number(value.duration);
  const ratio = String(value.aspectRatio ?? '16:9');
  if (!prompt || prompt.length > 50000) throw new Error('Prompt must contain 1–50,000 characters.');
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error('Mini duration must be an integer from 4 to 15 seconds.');
  if (!['16:9', '9:16', '1:1'].includes(ratio)) throw new Error('Supported preflight ratios are 16:9, 9:16 and 1:1.');
  if (value.references?.length || value.images?.length || value.videos?.length || value.audios?.length)
    throw new Error('This first preflight supports text-only jobs; reference uploads are not enabled.');
  return { prompt, duration, aspectRatio: ratio };
}

export async function prepareMiniForm(page, job) {
  const input = validateJob(job);
  if (new URL(page.url()).origin !== 'https://aivid.dev') throw new Error('Unexpected generation origin.');
  if (await page.getByRole('button', { name: 'Sign In' }).isVisible())
    throw new Error('Sign in using AIVID-Login.exe first. Close ALL AIVID login Chrome windows, then rerun preflight.');

  await page.getByRole('button', { name: /Seedance|MiniMax/ }).first().click();
  await page.getByRole('button', { name: /^Seedance 2\.0 \(Mini\)/ }).click();
  await page.getByPlaceholder(/^Describe your video idea/).fill(input.prompt);

  const slider = page.locator('input[type="range"][min="4"][max="15"]');
  if (await slider.count() !== 1) throw new Error('AIVID duration control changed; stop for inspection.');
  await slider.fill(String(input.duration));

  const ratioButton = page.getByRole('button', { name: /^\d+:\d+$/ });
  const currentRatio = (await ratioButton.innerText()).trim();
  if (currentRatio !== input.aspectRatio) {
    await ratioButton.click();
    await page.getByRole('button', { name: input.aspectRatio, exact: true }).click();
  }

  if ((await page.getByRole('button', { name: MINI_LABEL, exact: true }).innerText()).trim() !== MINI_LABEL)
    throw new Error('AIVID model selection changed; stop for inspection.');
  if (await slider.inputValue() !== String(input.duration)) throw new Error('AIVID duration did not stick.');
  if ((await page.getByPlaceholder(/^Describe your video idea/).inputValue()) !== input.prompt)
    throw new Error('AIVID prompt did not stick.');
  if ((await page.getByRole('button', { name: input.aspectRatio, exact: true }).count()) !== 1)
    throw new Error('AIVID aspect ratio did not stick.');
  // Deliberately no click on Generate. AIVID charges at submission and may require CAPTCHA.
  return { model: MINI_LABEL, duration: input.duration, aspectRatio: input.aspectRatio, readyForHumanReview: true };
}

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error('Usage: node preflight.mjs C:\\path\\to\\job.json');
  const job = validateJob(JSON.parse(await readFile(resolve(jobFile), 'utf8')));
  const { chromium } = await import('playwright');
  const profile = resolve(process.env.AIVID_RDP_PROFILE || './.aivid-rdp-profile');
  const context = await launchAividBrowser(chromium, profile);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(AIVID_URL, { waitUntil: 'domcontentloaded' });
    process.stdout.write('Waiting up to 45 seconds for AIVID to restore the saved sign-in and load the form...\n');
    await waitForAividSession(page);
    const result = await prepareMiniForm(page, job);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.stdout.write('Review the visible AIVID form and price. This script never submits a paid generation. Press Enter to close.\n');
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { await rl.question(''); } finally { rl.close(); }
  } catch (error) {
    process.stderr.write(error.message + '\n');
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { await rl.question('Browser paused for inspection. Press Enter to close it. '); } finally { rl.close(); }
    throw error;
  } finally { await context.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });



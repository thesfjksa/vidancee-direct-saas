import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIVID_URL, prepareMiniForm, validateJob } from './preflight.mjs';

const API_ORIGIN = 'https://api.aivid.dev';
const RECEIPT_DIR = resolve(process.env.AIVID_RDP_RECEIPTS || './receipts');

export function validateRunnerJob(value) {
  const input = validateJob(value);
  const jobId = String(value.jobId || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(jobId)) throw new Error('jobId must be 8–80 letters, digits, underscores or hyphens.');
  return { jobId, ...input };
}

export function generationResponse(response) {
  try {
    const url = new URL(response.url());
    return url.origin === API_ORIGIN && url.pathname === '/v2/generations' && response.request().method() === 'POST';
  } catch { return false; }
}

function providerId(body) {
  const values = [body?.id, body?.jobId, body?.generationId, body?.data?.id, body?.data?.jobId,
    body?.data?.generationId, body?.generation?.id];
  return values.find(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(v)) || null;
}

export function safeResponse(status, body) {
  // Do not save raw upstream responses: they may include signed URLs, account data or tokens.
  return { httpStatus: Number(status), providerJobId: providerId(body) };
}

export function visibleCreditState(text) {
  const price = String(text).match(/\b(\d+(?:\.\d+)?)\s+Credits?\s*\/\s*Video\b/i);
  const balance = String(text).match(/\b(\d+(?:\.\d+)?)\s+credits\b/i);
  if (!price || !balance) throw new Error('AIVID credit balance or video price is not visible; stop before Generate.');
  return { price: Number(price[1]), balance: Number(balance[1]) };
}

export function receiptPath(jobId, directory = RECEIPT_DIR) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(jobId)) throw new Error('Invalid jobId.');
  return resolve(directory, `${jobId}.json`);
}

export async function reserveClick(job, directory = RECEIPT_DIR) {
  await mkdir(directory, { recursive: true });
  const path = receiptPath(job.jobId, directory);
  const receipt = { jobId: job.jobId, promptSha256: createHash('sha256').update(job.prompt).digest('hex'),
    model: 'Seedance 2.0 (Mini)', duration: job.duration, aspectRatio: job.aspectRatio,
    state: 'submission_uncertain', recordedAt: new Date().toISOString() };
  // A prior receipt, including a crash before the click, requires human reconciliation.
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { path, receipt };
}

export async function saveReceipt(path, receipt) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}

export async function submitOnce(page, job, { directory = RECEIPT_DIR, timeoutMs = 60000, expectedPrice = null } = {}) {
  const input = validateRunnerJob(job);
  const ready = await prepareMiniForm(page, input);
  const credits = visibleCreditState(await page.locator('body').innerText());
  if (expectedPrice !== null && credits.price !== expectedPrice)
    throw new Error('AIVID price changed after owner review; stop before Generate.');
  if (credits.price <= 0 || credits.balance < credits.price)
    throw new Error('Not enough AIVID credits for this video; stop before Generate.');
  const { path, receipt } = await reserveClick(input, directory);
  const responsePromise = page.waitForResponse(generationResponse, { timeout: timeoutMs }).catch(() => null);
  try {
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
  } catch (error) {
    // An automation error does not prove the click was not delivered.
    await saveReceipt(path, { ...receipt, state: 'submission_uncertain', note: 'Generate click outcome unknown' });
    throw new Error('Generate click outcome is unknown. Inspect AIVID history before any retry.', { cause: error });
  }
  const response = await responsePromise;
  if (!response) {
    await saveReceipt(path, { ...receipt, state: 'submission_uncertain', note: 'No generation response observed' });
    return { ...ready, state: 'submission_uncertain', receiptPath: path };
  }
  let body = null;
  try { body = await response.json(); } catch {}
  const observed = safeResponse(response.status(), body);
  // An accepted HTTP response without a known ID is still ambiguous.
  const state = observed.httpStatus >= 200 && observed.httpStatus < 300 && observed.providerJobId
    ? 'accepted' : observed.httpStatus >= 400 && observed.httpStatus < 500 ? 'rejected' : 'submission_uncertain';
  await saveReceipt(path, { ...receipt, ...observed, state, recordedAt: new Date().toISOString() });
  return { ...ready, ...observed, state, receiptPath: path };
}

async function ask(message) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(message); } finally { rl.close(); }
}

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file || (flag && flag !== '--submit'))
    throw new Error('Usage: node runner.mjs trial.job.json [--submit]');
  const job = validateRunnerJob(JSON.parse(await readFile(resolve(file), 'utf8')));
  const submit = flag === '--submit';
  if (submit) {
    // Check before opening the browser; never submit a previously attempted job ID.
    const exists = await access(receiptPath(job.jobId)).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists)
      throw new Error('A receipt already exists for this jobId. Inspect AIVID history; do not retry blindly.');
  }
  const { chromium } = await import('playwright');
  const profile = resolve(process.env.AIVID_RDP_PROFILE || './.aivid-rdp-profile');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, acceptDownloads: false });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(AIVID_URL, { waitUntil: 'domcontentloaded' });
    if (await page.getByRole('button', { name: 'Sign In' }).isVisible())
      throw new Error('Sign in using AIVID-Login.exe first. Close ALL AIVID login Chrome windows, then reopen this runner.');
    if (!submit) {
      console.log(JSON.stringify(await prepareMiniForm(page, job)));
      await ask('No Generate click was made. Review the form, then press Enter to close. ');
      return;
    }
    await prepareMiniForm(page, job);
    const reviewed = visibleCreditState(await page.locator('body').innerText());
    if (reviewed.price <= 0 || reviewed.balance < reviewed.price)
      throw new Error('Not enough AIVID credits for this video; no Generate click was made.');
    console.log('This will click Generate ONCE for job ' + job.jobId + ' at the displayed price of ' + reviewed.price + ' AIVID credits.');
    const confirmation = await ask('Review the browser model, price and account. Type SUBMIT to continue: ');
    if (confirmation !== 'SUBMIT') { console.log('Cancelled before Generate.'); return; }
    const result = await submitOnce(page, job, { expectedPrice: reviewed.price });
    console.log(JSON.stringify(result));
    console.log('Do not retry this jobId. The receipt records the submission state; finished video retrieval is not implemented yet.');
    await ask('Inspect AIVID My Videos if needed, then press Enter to close. ');
  } finally { await context.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });


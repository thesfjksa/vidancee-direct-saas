import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generationResponse, safeResponse, submitOnce, validateRunnerJob, visibleCreditState } from '../runner.mjs';

const job = { jobId: 'trial_job_001', prompt: 'A quiet river at dawn', duration: 15, aspectRatio: '16:9' };

function fakePage({ balance = 5, price = 2, response = null, clickError = null } = {}) {
  let model = 'Seedance 2.5', prompt = '', duration = '15', clicks = 0;
  return {
    url: () => 'https://aivid.dev/',
    get clicks() { return clicks; },
    getByRole: (_, { name }) => {
      if (String(name) === 'Sign In') return { isVisible: async () => false };
      if (String(name) === '/Seedance|MiniMax/') return { first: () => ({ click: async () => {} }) };
      if (String(name) === '/^Seedance 2\\.0 \\(Mini\\)/') return { click: async () => { model = 'Seedance 2.0 (Mini)'; } };
      if (name === 'Seedance 2.0 (Mini)') return { innerText: async () => model };
      if (String(name) === '/^\\d+:\\d+$/') return { innerText: async () => '16:9' };
      if (name === '16:9') return { count: async () => 1 };
      if (name === 'Generate') return { click: async () => { clicks++; if (clickError) throw clickError; } };
      throw new Error('Unexpected role ' + name);
    },
    getByPlaceholder: () => ({ fill: async value => { prompt = value; }, inputValue: async () => prompt }),
    locator: selector => selector === 'body'
      ? { innerText: async () => `${balance} credits\n${price} Credits / Video` }
      : { count: async () => 1, fill: async value => { duration = value; }, inputValue: async () => duration },
    waitForResponse: async predicate => {
      if (response && predicate(response)) return response;
      return null;
    },
  };
}

test('accepts only a text-only job with a stable local id', () => {
  assert.deepEqual(validateRunnerJob(job), job);
  assert.throws(() => validateRunnerJob({ ...job, jobId: '../secret' }), /jobId/);
  assert.throws(() => validateRunnerJob({ ...job, images: ['ref.jpg'] }), /text-only/);
});

test('recognizes only the expected POST response and never retains raw data', () => {
  const response = { url: () => 'https://api.aivid.dev/v2/generations', request: () => ({ method: () => 'POST' }) };
  assert.equal(generationResponse(response), true);
  assert.equal(generationResponse({ ...response, url: () => 'https://other.example/v2/generations' }), false);
  assert.deepEqual(safeResponse(201, { data: { id: '1234567890abcdef12345678', signedUrl: 'secret' } }),
    { httpStatus: 201, providerJobId: '1234567890abcdef12345678' });
  assert.deepEqual(visibleCreditState('0 credits\n2 Credits / Video'), { balance: 0, price: 2 });
});

test('refuses low credit or changed price before recording or clicking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aivid-runner-'));
  try {
    const low = fakePage({ balance: 0 });
    await assert.rejects(submitOnce(low, job, { directory }), /Not enough/);
    assert.equal(low.clicks, 0);
    const changed = fakePage();
    await assert.rejects(submitOnce(changed, job, { directory, expectedPrice: 3 }), /price changed/);
    assert.equal(changed.clicks, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('records an accepted job once and refuses duplicate local id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aivid-runner-'));
  const response = { url: () => 'https://api.aivid.dev/v2/generations', request: () => ({ method: () => 'POST' }),
    status: () => 201, json: async () => ({ data: { id: '1234567890abcdef12345678', secret: 'do-not-save' } }) };
  try {
    const page = fakePage({ response });
    const result = await submitOnce(page, job, { directory });
    assert.equal(page.clicks, 1);
    assert.equal(result.state, 'accepted');
    const receipt = await readFile(result.receiptPath, 'utf8');
    assert.equal(JSON.parse(receipt).providerJobId, '1234567890abcdef12345678');
    assert.equal(receipt.includes('do-not-save'), false);
    assert.equal(receipt.includes(job.prompt), false);
    await assert.rejects(submitOnce(page, job, { directory }), { code: 'EEXIST' });
    assert.equal(page.clicks, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an ambiguous response or click error stays uncertain and cannot be retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aivid-runner-'));
  try {
    const page = fakePage();
    const result = await submitOnce(page, job, { directory });
    assert.equal(result.state, 'submission_uncertain');
    assert.equal(page.clicks, 1);
    await assert.rejects(submitOnce(page, job, { directory }), { code: 'EEXIST' });
    const second = fakePage({ clickError: new Error('connection lost') });
    await assert.rejects(submitOnce(second, { ...job, jobId: 'trial_job_002' }, { directory }), /outcome is unknown/);
    assert.equal(second.clicks, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

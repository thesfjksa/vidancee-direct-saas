import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchAividBrowser } from '../preflight.mjs';

test('runner browser keeps its dedicated profile and explicitly enables Chrome sandboxing', async () => {
  const profile = 'dedicated profile with spaces 测试';
  const expected = {};
  const context = await launchAividBrowser({ launchPersistentContext: async (actualProfile, options) => {
    assert.equal(actualProfile, profile);
    assert.deepEqual(options, {
      channel: 'chrome', headless: false, acceptDownloads: false, chromiumSandbox: true,
    });
    return expected;
  } }, profile);
  assert.equal(context, expected);
});

test('Windows Chrome actually starts without --no-sandbox', { skip: process.platform !== 'win32' }, async () => {
  const { chromium } = await import('playwright');
  const profile = await mkdtemp(join(tmpdir(), 'aivid-sandbox-check-'));
  let context;
  try {
    context = await launchAividBrowser(chromium, profile);
    const page = context.pages()[0] || await context.newPage();
    const session = await context.newCDPSession(page);
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
    assert.equal(args.includes('--no-sandbox'), false);
    assert.equal(args.some(arg => arg.startsWith('--user-data-dir=')), true);
    await session.detach();
  } finally {
    if (context) await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

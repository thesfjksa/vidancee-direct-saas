import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { findChrome, loginArguments, openManualLogin } from '../login.mjs';

test('finds installed Chrome and reports a missing installation', () => {
  assert.equal(findChrome({ LOCALAPPDATA: 'C:\\Users\\Test' }, () => true),
    'C:\\Users\\Test\\Google\\Chrome\\Application\\chrome.exe');
  assert.throws(() => findChrome({}, () => false), /Chrome was not found/);
});

test('manual sign-in uses the dedicated profile without automation or debugging switches', () => {
  const args = loginArguments('profile with spaces 测试');
  assert.deepEqual(args, ['--user-data-dir=' + resolve('profile with spaces 测试'), '--new-window', 'https://aivid.dev/']);
  assert.equal(args.some(arg => /remote-debug|automation|no-sandbox|disable.*security/i.test(arg)), false);
});

test('starts normal Chrome separately and leaves it running for manual authentication', async () => {
  let observed, directory, released = false;
  const result = await openManualLogin({
    platform: 'win32', env: { AIVID_CHROME_PATH: 'C:\\Chrome\\chrome.exe', AIVID_RDP_PROFILE: 'my profile' }, exists: () => true,
    ensureDirectory: async (...args) => { directory = args; },
    start: (...args) => {
      observed = args;
      const child = new EventEmitter(); child.unref = () => { released = true; };
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(result, { opened: true });
  assert.equal(observed[0], 'C:\\Chrome\\chrome.exe');
  assert.deepEqual(observed[2], { detached: true, stdio: 'ignore', shell: false });
  assert.equal(directory[0], resolve('my profile'));
  assert.equal(released, true);
});

test('a Chrome start error is actionable and never triggers a second start', async () => {
  let count = 0;
  await assert.rejects(openManualLogin({ platform: 'win32', env: { AIVID_CHROME_PATH: 'chrome.exe' }, exists: () => true,
    ensureDirectory: async () => {}, start: () => {
      count++;
      const child = new EventEmitter(); setImmediate(() => child.emit('error', new Error('private path'))); return child;
    } }), /Chrome could not be started/);
  assert.equal(count, 1);
});

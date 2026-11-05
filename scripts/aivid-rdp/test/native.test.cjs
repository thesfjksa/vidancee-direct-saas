'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromeArguments, debuggerEndpoint, takeLock, downloadNative } = require('../native.cjs');
const { origin, Transport, loadConfig, saveConfig, readPairingInput } = require('../agent.cjs');
const { Readable } = require('node:stream');
test('Windows dialog pairing input is bounded, validated and never included in errors', async () => {
  const code = 'aabbccddeeff001122334455';
  assert.deepEqual(await readPairingInput(Readable.from(['https://cmmtools.site\r\n', code + '\r\n'])),
    { origin: 'https://cmmtools.site', code: code.toUpperCase() });
  for (const input of ['https://cmmtools.site\nwrong', 'https://cmmtools.site\n' + code + '\nextra', 'x'.repeat(4097)])
    await assert.rejects(readPairingInput(Readable.from([input])), error => { assert.doesNotMatch(error.message, new RegExp(code)); return true; });
  await assert.rejects(readPairingInput(Readable.from(['http://cmmtools.site\n' + code])), /HTTPS/);
});
test('manual login has no automation or debugging flags; automation binds only to loopback', () => {
  const login = chromeArguments('./private-profile');
  assert.doesNotMatch(login.join(' '), /debugging|enable-automation|no-sandbox|disable-web-security|remote-allow-origins/);
  const agent = chromeArguments('./private-profile', true);
  assert.ok(agent.includes('--remote-debugging-address=127.0.0.1')); assert.ok(agent.includes('--remote-debugging-port=0'));
  assert.doesNotMatch(agent.join(' '), /0\.0\.0\.0|enable-automation|no-sandbox|disable-web-security|remote-allow-origins/);
});
test('debugging discovery rejects a non-local or mismatched browser', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-endpoint-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'DevToolsActivePort'), '45678\n/devtools/browser/abc-123\n');
  for (const url of ['ws://evil.test:45678/devtools/browser/abc-123', 'ws://127.0.0.1:45678/devtools/browser/other', 'wss://127.0.0.1:45678/devtools/browser/abc-123'])
    assert.equal(await debuggerEndpoint(root, async () => Response.json({ webSocketDebuggerUrl: url })), null);
  assert.equal(await debuggerEndpoint(root, async () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/browser/abc-123' })), 'ws://127.0.0.1:45678/devtools/browser/abc-123');
});
test('one agent owns the profile, and credentials remain encrypted and origin-bound', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-config-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const release = await takeLock(root); await assert.rejects(takeLock(root), /already running/); await release();
  const codec = async (mode, value) => mode === 'protect' ? Buffer.from(value).toString('base64') : Buffer.from(value, 'base64').toString();
  const token = 'a'.repeat(64);
  await saveConfig(root, { origin: 'https://cmmtools.site', token }, codec);
  assert.doesNotMatch(await fs.readFile(path.join(root, '.aivid-agent.json'), 'utf8'), new RegExp(token));
  assert.equal((await loadConfig(root, codec)).token, token);
  const record = JSON.parse(await fs.readFile(path.join(root, '.aivid-agent.json'), 'utf8')); record.origin = 'https://other.example';
  await fs.writeFile(path.join(root, '.aivid-agent.json'), JSON.stringify(record));
  await assert.rejects(loadConfig(root, codec), /configuration changed/);
});
test('agent sends credentials only in the authorization header and refuses redirects', async () => {
  for (const url of ['http://cmmtools.site', 'https://user:password@cmmtools.site', 'https://cmmtools.site/path', 'https://cmmtools.site/?token=x']) assert.throws(() => origin(url));
  let seen;
  const token = 'b'.repeat(64);
  const client = new Transport('https://cmmtools.site', token, async (url, options) => { seen = { url, options }; return Response.json({ ok: true }); });
  await client.request('/poll', { body: { status: 'ready' } });
  assert.equal(seen.options.headers.authorization, 'Bearer ' + token); assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.url.includes(token), false); assert.equal(seen.options.body.includes(token), false);
});
test('native download validates the MP4 header and deletes only its temporary download', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-download-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'clip.mp4'), data = Buffer.from('0000ftypisom0000'); await fs.writeFile(file, data);
  let deleted = 0;
  const download = { failure: async () => null, path: async () => file, delete: async () => { deleted++; } };
  const page = { waitForEvent: async () => download, getByRole: () => ({ click: async () => {} }) };
  assert.deepEqual((await downloadNative(page)).data, data); assert.equal(deleted, 1);
  await fs.writeFile(file, 'not a video file');
  await assert.rejects(downloadNative(page), /valid MP4/); assert.equal(deleted, 2);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { connectNative, debuggerEndpoint, downloadNative, startEdge } = require('../native.cjs');
// The shared form suite includes deliberate missing-menu waits and delayed
// renders, provider alert checks and native download/profile checks on Windows.
test('real installed Microsoft Edge keeps its profile alive after CDP disconnect and downloads natively', { skip: process.platform !== 'win32', timeout: 240000 }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'CMM AIVID 测试-'));
  const clip = Buffer.from('0000ftypisom0000');
  const server = http.createServer((req, res) => {
    if (req.url === '/clip') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="clip.mp4"' }); return res.end(clip); }
    res.end('<button onclick="location.href=\'/clip\'">Download Video</button>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let remote;
  t.after(async () => {
    if (remote) { const cdp = await remote.context.newCDPSession(remote.page).catch(() => null); if (cdp) await cdp.send('Browser.close').catch(() => {}); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });
  remote = await connectNative(profile, { timeoutMs:60000, start: (dir, options) => startEdge(dir, { ...options, initialUrl: 'about:blank' }) });
  await remote.page.goto('chrome://version/');
  const args = await remote.page.locator('#command_line').innerText();
  assert.doesNotMatch(args, /--no-sandbox|--enable-automation|--disable-web-security|--remote-allow-origins/);
  assert.match(args, /--remote-debugging-address=127\.0\.0\.1/); assert.ok(args.includes(profile));
  await remote.page.goto('http://127.0.0.1:' + server.address().port);
  assert.deepEqual((await downloadNative(remote.page)).data, clip);
  const { AividBrowserlessClient, waitForSession } = require('../../../src/provider/aivid.js');
  await require('../fixtures/form.cjs').checkForm(remote.page, AividBrowserlessClient, waitForSession);
  await require('../fixtures/references.cjs').checkReferenceFlows(remote.context,AividBrowserlessClient);
  await require('../fixtures/collection.cjs').checkCollection(remote.context,AividBrowserlessClient);
  await require('../fixtures/native-download.cjs').checkInlineDownload(remote.context);
  const target=await remote.context.newCDPSession(remote.page);
  const originalTarget=(await target.send('Target.getTargetInfo')).targetInfo.targetId;await target.detach();
  await remote.close();remote=await connectNative(profile);
  const reused=await remote.context.newCDPSession(remote.page);
  assert.equal((await reused.send('Target.getTargetInfo')).targetInfo.targetId,originalTarget,'managed connection reuses its work tab');await reused.detach();
  await remote.page.goto('about:blank#cmmtools-worker'); // Safe paid-form cleanup reuses its tab.
  await remote.close();
  assert.ok(await debuggerEndpoint(profile), 'Microsoft Edge must stay open after detaching');
  remote = await connectNative(profile);
  assert.equal(remote.browser.isConnected(), true);
});

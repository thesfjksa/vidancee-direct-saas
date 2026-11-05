'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { connectNative, debuggerEndpoint, downloadNative, startChrome } = require('../native.cjs');
test('real installed Chrome keeps its profile alive after CDP disconnect and downloads natively', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
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
  remote = await connectNative(profile, { start: (dir, options) => startChrome(dir, { ...options, initialUrl: 'about:blank' }) });
  await remote.page.goto('chrome://version/');
  const args = await remote.page.locator('#command_line').innerText();
  assert.doesNotMatch(args, /--no-sandbox|--enable-automation|--disable-web-security|--remote-allow-origins/);
  assert.match(args, /--remote-debugging-address=127\.0\.0\.1/); assert.ok(args.includes(profile));
  await remote.page.goto('http://127.0.0.1:' + server.address().port);
  assert.deepEqual((await downloadNative(remote.page)).data, clip);
  await remote.page.close(); // The paid-form cleanup must not terminate Chrome.
  await remote.close();
  assert.ok(await debuggerEndpoint(profile), 'Chrome must stay open after detaching');
  remote = await connectNative(profile);
  assert.equal(remote.browser.isConnected(), true);
});

'use strict';
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function findChrome(env = process.env, exists = existsSync) {
  const candidates = [env.AIVID_CHROME_PATH, ...[env.PROGRAMFILES || env.ProgramFiles,
    env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
    .map(root => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))].filter(Boolean);
  const found = candidates.find(exists);
  if (!found) throw new Error('Google Chrome is not available. Use the Chrome already installed on your RDP.');
  return found;
}
function chromeArguments(profile, debug = false, initialUrl = 'https://aivid.dev/') {
  if (!['https://aivid.dev/', 'about:blank'].includes(initialUrl)) throw new Error('Unsupported browser start page.');
  return ['--user-data-dir=' + path.resolve(profile), '--new-window',
    ...(debug ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] : []), initialUrl];
}
async function startChrome(profile, { debug = false, env = process.env, start = spawn, initialUrl = 'https://aivid.dev/' } = {}) {
  await fs.mkdir(profile, { recursive: true });
  const child = start(findChrome(env), chromeArguments(profile, debug, initialUrl), { detached: true, stdio: 'ignore', shell: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve); child.once('error', () => reject(new Error('Chrome could not start. Use a writable folder on your RDP.')));
  });
  child.unref();
}
async function debuggerEndpoint(profile, fetchImpl = fetch) {
  try {
    const [line, target] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    const port = Number(line);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(target)) return null;
    const response = await fetchImpl('http://127.0.0.1:' + port + '/json/version', { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const url = new URL((await response.json()).webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== port || url.pathname !== target || url.username || url.password || url.search || url.hash) return null;
    return 'ws://127.0.0.1:' + port + target;
  } catch { return null; }
}
async function connectNative(profile, { chromium, fetchImpl = fetch, start = startChrome, timeoutMs = 20000 } = {}) {
  let endpoint = await debuggerEndpoint(profile, fetchImpl);
  if (!endpoint) {
    await start(profile, { debug: true });
    const deadline = Date.now() + timeoutMs;
    while (!endpoint && Date.now() < deadline) { await pause(250); endpoint = await debuggerEndpoint(profile, fetchImpl); }
  }
  if (!endpoint) throw new Error('Close the Chrome windows opened by AIVID-Login.exe, then restart AIVID-Agent.exe. Other Chrome windows can stay open.');
  chromium ||= require('playwright-core').chromium;
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error();
    // Closing the paid form after interception must not close Chrome's last
    // window. Keep one blank parking tab, without any customer's data.
    const parking = context.pages().find(p => p.url() === 'about:blank') || await context.newPage();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    for (const old of context.pages()) {
      if (old === page || old === parking) continue;
      try { if (old.url() === 'about:blank' || new URL(old.url()).origin === 'https://aivid.dev') await old.close(); } catch {}
    }
    // With connectOverCDP, close disconnects the Playwright transport. Chrome
    // was launched independently and stays running with its saved profile.
    return { browser, context, page, close: async () => { await browser.close().catch(() => {}); } };
  } catch {
    if (browser) await browser.close().catch(() => {});
    throw new Error('The local AIVID Chrome connection failed. Inspect its window on the RDP.');
  }
}
async function downloadNative(page) {
  let download;
  try {
    const pending = page.waitForEvent('download', { timeout: 60000 }); pending.catch(() => {});
    await page.getByRole('button', { name: 'Download Video', exact: true }).click();
    download = await pending;
    if (await download.failure()) throw new Error();
    const file = await download.path();
    if (!file) throw new Error();
    const size = (await fs.stat(file)).size;
    if (size < 12 || size > 100 * 1024 * 1024) throw new Error();
    const data = await fs.readFile(file);
    if (data.length !== size || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error();
    return { data, mimeType: 'video/mp4' };
  } catch { throw new Error('AIVID did not return a valid MP4 within the download limit. The existing source job will be kept.'); }
  finally { if (download) await download.delete().catch(() => {}); }
}
async function takeLock(root) {
  const file = path.join(root, '.aivid-agent.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await fs.unlink(file).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Another agent lock needs inspection. Close all AIVID agents before removing .aivid-agent.lock.');
      try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { await fs.unlink(file); continue; } }
      throw new Error('An AIVID agent is already running. Keep only one agent open.');
    }
  }
  throw new Error('The AIVID agent lock could not be acquired.');
}
module.exports = { findChrome, chromeArguments, startChrome, debuggerEndpoint, connectNative, downloadNative, takeLock };

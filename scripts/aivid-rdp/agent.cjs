'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { connectNative, downloadNative, takeLock } = require('./native.cjs');
const adapter = require(require('node:fs').existsSync(path.join(__dirname, 'provider/aivid.js')) ? './provider/aivid.js' : '../../src/provider/aivid.js');
const CHUNK = 1024 * 1024, MAX_OUTPUT = 100 * CHUNK;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error('Enter the HTTPS CMMTools address only, for example https://cmmtools.site'), { safe: true }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Object.assign(new Error('Enter the HTTPS CMMTools address only, for example https://cmmtools.site'), { safe: true });
  return url.origin;
}
class Transport {
  constructor(baseUrl, token = '', fetchImpl = fetch) { this.origin = origin(baseUrl); this.token = token; this.fetch = fetchImpl; }
  async request(route, { method = 'POST', body = {}, binary = false } = {}) {
    let response;
    try {
      response = await this.fetch(this.origin + '/api/aivid-rdp' + route, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...(this.token ? { authorization: 'Bearer ' + this.token } : {}),
          ...(method === 'GET' ? {} : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }) },
        ...(method === 'GET' ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
    } catch { throw Object.assign(new Error('Cannot reach CMMTools. Check the RDP internet connection.'), { network: true }); }
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'Agent pairing was rejected. Generate a new code in Admin and pair again.' : 'CMMTools declined the operation. Check Admin and do not resubmit a paid job.'), { statusCode: response.status });
    if (!binary) return response.json();
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 32 * CHUNK) throw new Error('Reference download exceeds its limit.');
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    } finally { await reader.cancel().catch(() => {}); }
  }
}
async function protect(mode, value) {
  const helper = path.join(__dirname, 'AIVID-Protect.exe');
  // Send secrets through stdin, never command-line arguments or shell code.
  return new Promise((resolve, reject) => {
    const child = execFile(helper, [mode], { windowsHide: true, maxBuffer: 65536 }, (error, stdout) => {
      if (error) reject(Object.assign(new Error('Windows could not protect the agent credential for this RDP user.'), { safe: true }));
      else resolve(stdout.trim());
    });
    child.stdin.end(value);
  });
}
async function loadConfig(root, codec = protect) {
  const record = JSON.parse(await fs.readFile(path.join(root, '.aivid-agent.json'), 'utf8'));
  const secret = JSON.parse(await codec('unprotect', record.credential));
  if (origin(record.origin) !== secret.origin || !/^[a-f0-9]{64}$/.test(secret.token)) throw Object.assign(new Error('Agent configuration changed. Pair this RDP user again.'), { safe: true });
  return { origin: secret.origin, token: secret.token };
}
async function saveConfig(root, value, codec = protect) {
  const baseUrl = origin(value.origin);
  const credential = await codec('protect', JSON.stringify({ origin: baseUrl, token: value.token }));
  await fs.writeFile(path.join(root, '.aivid-agent.json'), JSON.stringify({ origin: baseUrl, credential }) + '\n', { mode: 0o600 });
}
class Agent {
  constructor({ root = __dirname, transport, connect, clientFactory, pause = delay } = {}) {
    this.root = root; this.transport = transport; this.pause = pause; this.status = 'starting'; this.stopping = false;
    this.connect = connect || (() => connectNative(path.join(root, '.aivid-rdp-profile')));
    this.clientFactory = clientFactory || (limit => new adapter.AividBrowserlessClient({ connect: this.connect, download: downloadNative, maxSourceCredits: limit }));
  }
  async check() {
    try {
      await this.clientFactory(0).preflight({ prompt: 'A quiet river at dawn', duration: 4, aspectRatio: '16:9', resolution: '480p' });
      this.status = 'ready'; console.log('AIVID session ready. No video was generated.');
    } catch { this.status = 'needs_login'; console.log('AIVID needs attention. Inspect Chrome or stop the agent and use AIVID-Login.exe, then restart.'); }
  }
  async execute(command) {
    const route = '/commands/' + command.id;
    let receipt = null, reserved = false;
    const references = [];
    for (const ref of command.payload.references || []) {
      const data = await this.transport.request(route + '/references/' + ref.index, { method: 'GET', binary: true });
      if (data.length !== ref.size || hash(data) !== ref.sha256) throw new Error('Reference integrity check failed.');
      references.push({ kind: ref.kind, mimeType: ref.mimeType, data });
    }
    const client = this.clientFactory(Number(command.payload.maxSourceCredits) || 0);
    let result;
    if (command.kind === 'preflight') result = await client.preflight(command.payload.value, references);
    else if (command.kind === 'submit') {
      const jobId = command.payload.value.jobId;
      if (!/^[0-9a-f-]{36}$/i.test(jobId || '')) throw new Error('Invalid CMMTools job ID.');
      const dir = path.join(this.root, 'receipts'); await fs.mkdir(dir, { recursive: true });
      receipt = path.join(dir, jobId + '.json');
      result = await client.startVideo(command.payload.value, references, { beforeClick: async ({ price }) => {
        await fs.writeFile(receipt, JSON.stringify({ jobId, commandId: command.id, state: 'submission_uncertain', price }) + '\n', { flag: 'wx', mode: 0o600 });
        await this.transport.request(route + '/reserve', { body: { price } });
        while (Date.now() < command.expiresAt) {
          const status = await this.transport.request(route, { method: 'GET' });
          if (status.state === 'reserved') { reserved = true; return; }
          if (!['running', 'review'].includes(status.state)) break;
          await this.pause(750);
        }
        throw new Error('Server reservation was not confirmed. No Generate click is allowed.');
      } });
      if (receipt && reserved) {
        const temp = receipt + '.tmp';
        await fs.writeFile(temp, JSON.stringify({ jobId, commandId: command.id, state: result.state, ...(result.providerJobId ? { providerJobId: result.providerJobId } : {}) }) + '\n', { mode: 0o600 });
        await fs.rename(temp, receipt);
      }
    } else if (command.kind === 'collect') {
      result = await client.collectVideo(command.payload.providerJobId);
      if (result.state === 'completed') {
        const data = result.output.data;
        if (!Buffer.isBuffer(data) || data.length < 12 || data.length > MAX_OUTPUT || data.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Unsupported output.');
        for (let i = 0; i < Math.ceil(data.length / CHUNK); i++) await this.transport.request(route + '/chunks/' + i, { body: data.subarray(i * CHUNK, (i + 1) * CHUNK) });
        result = { state: 'completed', size: data.length, chunks: Math.ceil(data.length / CHUNK), sha256: hash(data) };
      }
    } else throw new Error('Unknown RDP command.');
    // Result retries only report an existing outcome. They never run the job again.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.transport.request(route + '/result', { body: result }); return; }
      catch (error) { if (!error.network || attempt === 2) throw error; await this.pause(1000); }
    }
  }
  async run() {
    const release = await takeLock(this.root);
    try {
      await this.transport.request('/poll', { body: { status: 'starting' } });
      await this.check();
      while (!this.stopping) {
        try {
          const { command } = await this.transport.request('/poll', { body: { status: this.status } });
          if (command) {
            const previous = this.status;
            this.status = 'busy';
            const timer = setInterval(() => this.transport.request('/poll', { body: { status: 'busy' } }).catch(() => {}), 10000);
            try { await this.execute(command); this.status = 'ready'; console.log('RDP operation finished.'); }
            catch (error) {
              await this.transport.request('/commands/' + command.id + '/result', { body: { error: true } }).catch(() => {});
              this.status = error.network ? previous : 'needs_login';
              console.log('Operation needs review. Check Chrome and Admin; existing paid jobs will not be submitted again.');
            } finally { clearInterval(timer); }
          }
        } catch (error) {
          if (error.statusCode === 401) throw error;
          console.log('Waiting for the CMMTools connection...');
        }
        await this.pause(2000);
      }
    } finally { await release(); }
  }
}
async function main() {
  if (process.platform !== 'win32') throw new Error('Run AIVID-Agent.exe on your Windows RDP.');
  const root = __dirname;
  let config;
  try { config = await loadConfig(root); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
    try {
      const baseUrl = origin((await rl.question('CMMTools HTTPS address [https://cmmtools.site]: ')).trim() || 'https://cmmtools.site');
      const code = (await rl.question('Pairing code from Admin: ')).trim();
      const paired = await new Transport(baseUrl).request('/pair', { body: { code } });
      config = { origin: baseUrl, token: paired.token }; await saveConfig(root, config);
      console.log('RDP paired. Credential protected for this Windows user.');
    } finally { rl.close(); }
  }
  const agent = new Agent({ root, transport: new Transport(config.origin, config.token) });
  process.once('SIGINT', () => { agent.stopping = true; }); process.once('SIGTERM', () => { agent.stopping = true; });
  await agent.run();
}
if (require.main === module) main().catch(error => { console.error(error.safe || error.network || error.statusCode ? error.message : 'The RDP agent stopped. Check Chrome, pairing and the writable agent folder.'); process.exitCode = 1; });
module.exports = { Agent, Transport, origin, loadConfig, saveConfig, protect, main };

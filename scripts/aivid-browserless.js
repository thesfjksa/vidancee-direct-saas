'use strict';

// Run on a trusted operator machine or the application host, never in the
// customer browser. Session files and live URLs grant control of the account.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSession, connectSession, createLoginView } = require('../src/provider/browserless.js');
const { AividBrowserlessClient, validateJob, openLoginPage } = require('../src/provider/aivid.js');
const { SESSION_KEY } = require('../src/aivid_settings.js');
const dir = path.resolve(process.env.AIVID_STATE_DIR || '.aivid-browserless');
const sessionPath = path.join(dir, 'session.json');

async function readSession() { return JSON.parse(await fs.readFile(sessionPath, 'utf8')); }
async function writePrivate(file, value, exclusive = false) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w', mode: 0o600 });
}
async function readJob(file) {
  if (!file) throw new Error('Specify a local job JSON file.');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(value.jobId || '')) throw new Error('jobId must contain 8–80 letters, digits, underscores or hyphens.');
  const references = [];
  for (const ref of value.references || []) references.push({ kind: ref.kind, mimeType: ref.mimeType,
    data: await fs.readFile(path.resolve(path.dirname(file), ref.path)) });
  validateJob(value, references);
  return { value, references };
}

async function main(args = process.argv.slice(2)) {
  const [command, file, flag] = args;
  if (command === 'create-session') {
    // Reserve the local file BEFORE creating any billable cloud resources.
    // A duplicate invocation must not leave an orphaned remote session.
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await fs.open(sessionPath, 'wx', 0o600);
    try {
      const session = await createSession({ token: process.env.BROWSERLESS_API_TOKEN,
        endpoint: process.env.BROWSERLESS_ENDPOINT || undefined, ttl: Number(process.env.BROWSERLESS_SESSION_TTL_MS || 86400000) });
      await handle.writeFile(JSON.stringify(session, null, 2) + '\n');
      console.log('Browserless session saved. Run login next. The session expires at ' + session.expiresAt + '.');
    } finally { await handle.close(); }
    return;
  }
  if (command === 'install-session') {
    const { setSettingValue } = require('../src/settings.js');
    await setSettingValue(SESSION_KEY, JSON.stringify(await readSession()), { secret: true });
    console.log('Browserless session installed in encrypted application settings.');
    await require('../src/db.js').getPool().end(); return;
  }
  const session = await readSession();
  if (command === 'login') {
    const remote = await connectSession(session.connect, { timeoutMs: 120000 });
    try {
      await openLoginPage(remote.page);
      const live = await createLoginView(remote, { timeoutMs: 110000 });
      console.log('Open this private, temporary browser control link. Do not share or put it in logs:\n' + live.liveURL);
      const { createInterface } = require('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { await rl.question('Complete Google/AIVID sign-in yourself, then press Enter here to save and close: '); }
      finally { rl.close(); }
    } finally { await remote.close(); }
    return;
  }
  const client = new AividBrowserlessClient({ connectUrl: session.connect,
    maxSourceCredits: Number(process.env.AIVID_MAX_SOURCE_CREDITS || 0) });
  const { value, references } = await readJob(file);
  const receiptFile = path.join(dir, 'receipts', value.jobId + '.json');
  if (command === 'preflight') { console.log(JSON.stringify(await client.preflight(value, references))); return; }
  if (command === 'submit' && flag === '--submit') {
    let reservation;
    const result = await client.startVideo(value, references, { beforeClick: async ({ price }) => {
      reservation = { jobId: value.jobId, promptSha256: crypto.createHash('sha256').update(value.prompt).digest('hex'),
        state: 'submission_uncertain', price, recordedAt: new Date().toISOString() };
      await writePrivate(receiptFile, reservation, true);
    } });
    if (reservation) {
      const temp = receiptFile + '.tmp'; await writePrivate(temp, { ...reservation, ...result }); await fs.rename(temp, receiptFile);
    }
    console.log(JSON.stringify(result)); return;
  }
  if (command === 'collect') {
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    if (receipt.state !== 'accepted') throw new Error('No accepted provider job ID is recorded. Inspect AIVID history; do not resubmit.');
    const result = await client.collectVideo(receipt.providerJobId);
    if (result.state === 'completed') {
      const output = path.join(dir, value.jobId + '.mp4');
      await fs.writeFile(output, result.output.data, { flag: 'wx', mode: 0o600 });
      console.log('Video saved to ' + output);
    } else console.log(JSON.stringify(result));
    return;
  }
  throw new Error('Usage: node scripts/aivid-browserless.js create-session|login|install-session|preflight job.json|submit job.json --submit|collect job.json');
}

if (require.main === module) main().catch(error => {
  // Never print raw automation errors: they can embed bearer URLs/credentials.
  const safe = /^(AIVID|Browserless|Invalid|Use |Prompt |Mini |Unsupported |An AIVID|A reference|The reference|Specify |jobId|Set an explicit|A durable|No accepted|Usage:)/.test(error.message);
  console.error(safe ? error.message : error.code === 'EEXIST'
    ? 'A session, receipt or output already exists. Do not overwrite or blindly retry a paid job.'
    : 'The operation failed. Check the account, local files and session. No automatic retry was made.');
  process.exitCode = 1;
});

module.exports = { main, readJob, writePrivate };

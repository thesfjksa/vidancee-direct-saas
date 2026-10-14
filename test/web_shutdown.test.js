const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const SERVER = path.join(__dirname, '..', 'server.js');
const env = port => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DB_|^WORKER_/.test(k)));
  return { ...clean, PORT: String(port), HOST: '127.0.0.1', WORKER_ENABLED: 'false', ACTIVITY_LOG: 'off', WEB_SHUTDOWN_GRACE_MS: '3000' };
};
const exited = (child, ms) => Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(new Error('process did not exit')), ms))]);

test('the web process exits on SIGTERM instead of waiting to be killed', async t => {
  const child = spawn(process.execPath, [SERVER], { env: env(0), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !/listening on/.test(out); i++) await new Promise(r => setTimeout(r, 50));
  assert.match(out, /listening on/);
  child.kill('SIGTERM');
  const [code] = await exited(child, 5000);
  assert.equal(code, 0);
});

test('a web process that cannot open its port exits with an error', async t => {
  const blocker = http.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  t.after(() => blocker.close());
  // In production the MySQL pool keeps the process alive; an interval stands in for it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000); require(' + JSON.stringify(SERVER) + ')'],
    { env: env(blocker.address().port), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const [code] = await exited(child, 5000);
  assert.equal(code, 1);
});

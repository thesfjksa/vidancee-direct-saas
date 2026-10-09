const test = require('node:test');
const assert = require('node:assert/strict');
const { GenerationWorker } = require('../src/worker_admin_settings.js');
const { WorkerWakeup } = require('../src/worker_wakeup.js');
const { defaultSmartImageConfig } = require('../src/smartaipi_images.js');
const { spawnSync } = require('node:child_process');

test('standalone polling keeps Node alive until the image cycle runs and shuts down cleanly', () => {
  const root = require('node:path').resolve(__dirname, '..');
  const script = `
    process.env.WORKER_ENABLED='true';
    const db=require('./src/db.js');db.dbConfigured=()=>true;
    const {GenerationWorker}=require('./src/worker_admin_settings.js');
    const worker=new GenerationWorker();
    worker.runOnce=async()=>{};
    worker.runSmartImagesOnce=async()=>{console.log('Image queue polled');worker.stop();};
    worker.start();
  `;
  const child = spawnSync(process.execPath, ['-e', script], { cwd: root, timeout: 3000, encoding: 'utf8' });
  assert.equal(child.error, undefined); assert.equal(child.status, 0);
  assert.match(child.stdout, /Image queue polled/);
});

test('a blocked video-provider cycle does not delay an independent image pickup cycle', async t => {
  const worker = new GenerationWorker(); t.after(() => worker.stop());
  let finishVideo, imageCycles = 0;
  worker.runOnce = () => new Promise(resolve => { finishVideo = resolve; });
  worker.runSmartImagesOnce = async () => { imageCycles++; };
  const video = worker.tick();
  assert.equal(worker.running, true);
  await worker.tickSmartImages();
  assert.equal(imageCycles, 1); assert.equal(worker.running, true);
  assert.equal(worker.smartImageRunning, false);
  assert.ok(worker.lastSmartTickFinishedAt);
  worker.stop(); finishVideo(); await video;
  assert.equal(worker.running, false);
});

test('image pickup uses current paid-source settings even while the video cycle has older settings', async () => {
  const worker = new GenerationWorker();
  worker.allowProviderCharges = true;
  const settings = { smartAipiApiKey: 'test-only', smartAipiBaseUrl: 'https://api.example.com',
    smartAipiModels: defaultSmartImageConfig(), smartAipiEnabled: true, smartAipiMaxInflight: 2, allowProviderCharges: false };
  let cleanup = 0;
  worker.syncSmartImages = async () => { cleanup++; };
  const db = { getConnection() { throw Error('Paused image source must not claim queued work'); } };
  await worker.runSmartImagesOnce(db, settings);
  assert.equal(cleanup, 1); assert.equal(worker.smartAipiEnabled, true);
  assert.equal(worker.smartAipiMaxInflight, 2);
});

test('worker wake is non-blocking, deduplicated, throttled and sends no customer or API credentials', async () => {
  let clock = 0, calls = 0, respond;
  const wake = new WorkerWakeup({ url: 'https://worker.example.com/live', now: () => clock, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://worker.example.com/live');
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.deepEqual(options.headers, { accept: 'application/json' });
    return new Promise(resolve => { respond = resolve; });
  }});
  const first = wake.wake();
  assert.equal(wake.status().running, true); assert.equal(calls, 1);
  const second = wake.wake(); assert.equal(calls, 1);
  respond(Response.json({ ok: true, service: 'mehroz-ai-worker', workerEnabled: true }));
  assert.deepEqual(await first, { ok: true }); assert.deepEqual(await second, { ok: true });
  assert.equal(wake.status().running, false);
  assert.equal((await wake.wake()).skipped, true); assert.equal(calls, 1);
  clock = 15000;
  const next = wake.wake(); assert.equal(calls, 2);
  respond(Response.json({ ok: true, service: 'mehroz-ai-worker', workerEnabled: true }));
  await next;
});

test('worker wake detects disabled consumers and times out without changing queued jobs or leaking errors', async () => {
  const disabled = new WorkerWakeup({ url: 'https://worker.example.com/live', fetchImpl: async () => Response.json({ ok: true, service: 'mehroz-ai-worker', workerEnabled: false }) });
  assert.match((await disabled.wake()).error, /disabled/);
  const timeout = new WorkerWakeup({ url: 'https://worker.example.com/live', timeoutMs: 10, fetchImpl: async (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('private credential and provider response')))) });
  assert.deepEqual(await timeout.wake(), { ok: false, error: 'Worker wake request timed out.' });
  assert.equal(timeout.status().running, false);
  const off = new WorkerWakeup(); assert.equal((await off.wake()).skipped, true);
  const invalid = new WorkerWakeup({ url: 'https://user:private@worker.example.com/live', fetchImpl: () => { throw Error('Must not send embedded credentials'); } });
  assert.equal((await invalid.wake()).ok, false);
  assert.equal(JSON.stringify(invalid.status()).includes('private'), false);
});

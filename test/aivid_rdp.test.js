'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AividRdpClient, AividRdpService, RdpStore, readDevice, publicDevice, DEVICE_KEY, HEARTBEAT_KEY, PAIR_KEY, hash } = require('../src/aivid_rdp.js');
const { Agent } = require('../scripts/aivid-rdp/agent.cjs');
const { validateConfig, publicConfig } = require('../src/aivid_settings.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const jobId = '12345678-1234-4234-9234-123456789012', providerJobId = '6aec589f09c74e1c2ef12900';
const value = { jobId, prompt: 'A quiet river', duration: 4, resolution: '480p', aspectRatio: '16:9' };
class MemoryStore {
  constructor() { this.rows = new Map(); this.chunks = new Map(); }
  async insert(c) { this.rows.set(c.id, { ...c, device_id: c.deviceId, generation_id: c.generationId, state: 'queued', response: {} }); }
  async get(id) { const row = this.rows.get(id); return row ? { ...row } : null; }
  async move(id, from, to, response = {}) {
    const row = this.rows.get(id); if (!row || row.state !== from || row.expiresAt <= Date.now()) return false;
    Object.assign(row, { state: to, response }); return true;
  }
  async cancel(id) { const r = this.rows.get(id); if (r && r.state !== 'done') r.state = 'cancelled'; }
  async claim(deviceId, readOnly, liveOnly = false) {
    const row = [...this.rows.values()].find(r => r.device_id === deviceId && r.state === 'queued' && r.expiresAt > Date.now() && (!readOnly || ['preflight','live'].includes(r.kind)) && (!liveOnly || r.kind === 'live'));
    if (!row || !await this.move(row.id, 'queued', 'running')) return null; return this.get(row.id);
  }
  async chunk(id, i, data) {
    const rows = this.chunks.get(id) || new Map();
    if (rows.has(i) && !rows.get(i).equals(data)) throw new Error('Conflicting chunk');
    rows.set(i, data); this.chunks.set(id, rows);
  }
  async output(id, metadata) {
    const rows = [...(this.chunks.get(id) || new Map())].sort((a, b) => a[0] - b[0]).map(([position_index, media_data]) => ({ position_index, media_data }));
    return RdpStore.prototype.output.call({ db: { execute: async () => [rows] } }, id, metadata);
  }
  async remove(id) { this.rows.delete(id); this.chunks.delete(id); }
}
function fixture() {
  const records = new Map(), store = new MemoryStore();
  const token = 'a'.repeat(64), deviceId = crypto.randomUUID();
  records.set(DEVICE_KEY, JSON.stringify({ deviceId, tokenHash: hash(token) }));
  const read = async (key, fallback) => records.get(key) ?? fallback;
  const write = async (key, value) => records.set(key, value);
  const db = { query: async () => [[]], execute: async () => [[{ total: 0 }]], getConnection: async () => ({
    query: async () => [[{ acquired: 1 }]], release() {} }) };
  const service = new AividRdpService({ db: () => db, read, write, getConfig: async () => ({ mode: 'rdp' }), store });
  const device = { deviceId, tokenHash: hash(token) };
  const transport = { request: async (route, options = {}) => {
    if (route === '/poll') return service.poll(device, options.body.status, options.body.browser || 'edge');
    const parts = route.split('/'), id = parts[2], action = parts[3];
    if (!action) return { state: (await service.command(device, id)).state };
    if (action === 'reserve') return service.reserve(device, id, options.body.price);
    if (action === 'result') return service.result(device, id, options.body);
    if(action==='references')return (await service.reference(device,id,Number(parts[4]))).data;
    if (action === 'chunks') { await service.command(device, id); await store.chunk(id, Number(parts[4]), options.body); return {}; }
    throw new Error('Unexpected transport route');
  } };
  const client = new AividRdpClient({ rdpDevice: device, maxSourceCredits: 3, store, delay: flush });
  return { records, db, store, service, read, write, token, device, transport, client };
}

test('RDP configuration accepts no Browserless key and exposes no agent credential', () => {
  const config = validateConfig({ mode: 'rdp' }, { apiKey: '', endpoint: 'https://production-sfo.browserless.io' });
  assert.equal(config.mode, 'rdp'); assert.equal(config.apiKey, ''); assert.equal(config.enabled, false);
  const status = publicConfig({ ...config, rdpDevice: { deviceId: jobId, tokenHash: 'private-hash' } });
  assert.equal(status.configured, true); assert.equal(status.rdp.paired, true);
  assert.doesNotMatch(JSON.stringify(status), /private-hash/);
});
test('pairing is single-use, expires, and never reuses the admin credential', async () => {
  const f = fixture(); const pairing = await f.service.createPairing();
  assert.match(pairing.code, /^[A-F0-9]{24}$/); assert.doesNotMatch(f.records.get(PAIR_KEY), new RegExp(pairing.code));
  const paired = await f.service.pair(pairing.code);
  assert.match(paired.token, /^[a-f0-9]{64}$/);
  assert.equal((await f.service.authorize('Bearer ' + paired.token)).deviceId, paired.deviceId);
  await assert.rejects(f.service.pair(pairing.code), /Invalid or expired/);
  await assert.rejects(f.service.authorize('Bearer ' + f.token), /authentication/);
  await assert.rejects(f.service.authorize('Bearer admin-token'), /authentication/);
  f.records.set(PAIR_KEY, JSON.stringify({ codeHash: hash(pairing.code), expiresAt: new Date(0).toISOString() }));
  await assert.rejects(f.service.pair(pairing.code), /Invalid or expired/);
});
test('a stale heartbeat cannot restore a replaced RDP agent', async () => {
  const f = fixture(); f.records.set(HEARTBEAT_KEY, JSON.stringify({ deviceId: 'old-device', seenAt: new Date().toISOString(), status: 'ready' }));
  const state = publicDevice(await readDevice(f.read)); assert.equal(state.online, false);
  assert.equal(state.deviceId, f.device.deviceId);
  assert.equal(publicDevice({ ...f.device, seenAt: 'invalid' }).online, false);
  assert.equal(publicDevice({ ...f.device, seenAt: new Date(Date.now() + 60000).toISOString() }).online, false);
});
test('pairing rechecks outstanding work when consuming a previously generated code', async () => {
  const f = fixture(), pairing = await f.service.createPairing();
  f.db.execute = async () => [[{ total: 1 }]];
  await assert.rejects(f.service.pair(pairing.code), /outstanding AIVID jobs/);
  assert.equal((await readDevice(f.read)).deviceId, f.device.deviceId);
  assert.ok(f.records.get(PAIR_KEY), 'the code remains available after the conflicting job is resolved');
});
test('one command can be claimed once, and login-required agents can only claim preflight', async () => {
  const f = fixture();
  await f.store.insert({ id: jobId, deviceId: f.device.deviceId, kind: 'submit', payload: {}, expiresAt: Date.now() + 10000 });
  assert.equal((await f.service.poll(f.device, 'starting', 'edge')).command, null);
  assert.equal((await f.service.poll(f.device, 'needs_login', 'edge')).command, null);
  const claims = await Promise.all([f.service.poll(f.device, 'ready', 'edge'), f.service.poll(f.device, 'ready', 'edge')]);
  assert.equal(claims.filter(c => c.command).length, 1);
  const other = { deviceId: crypto.randomUUID() };
  await assert.rejects(f.service.command(other, jobId), /ended/);
});
test('agent Generate occurs only after the server reservation, and reporting retries never generate twice', { timeout: 10000 }, async t => {
  const f = fixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-agent-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let clicked = 0, reserved = 0, reports = 0;
  const request = f.transport.request;
  f.transport.request = async (route, options) => {
    if (route.endsWith('/result') && reports++ === 0) throw Object.assign(new Error('Unavailable'), { statusCode: 503 });
    return request(route, options);
  };
  const agent = new Agent({ root, transport: f.transport, pause: flush, clientFactory: () => ({ startVideo: async (_value, _refs, hooks) => {
    await hooks.beforeClick({ price: 2 }); assert.equal(reserved, 1); clicked++; return { state: 'accepted', providerJobId };
  } }) });
  const waiting = f.client.startVideo(value, [], { beforeClick: async ({ price }) => { assert.equal(price, 2); reserved++; } });
  await flush(); const { command } = await f.service.poll(f.device, 'ready', 'edge');
  const [, result] = await Promise.all([agent.execute(command), waiting]);
  assert.equal(result.providerJobId, providerJobId); assert.equal(clicked, 1); assert.equal(reports, 2);
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'receipts', jobId + '.json'), 'utf8'));
  assert.equal(receipt.state, 'accepted'); assert.equal(receipt.providerJobId, providerJobId);
  await assert.rejects(agent.execute(command), /EEXIST/); assert.equal(clicked, 1);
});
test('a rejected reservation cannot reach Generate; late callbacks are refused', { timeout: 10000 }, async t => {
  const f = fixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-denied-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let clicked = 0;
  const agent = new Agent({ root, transport: f.transport, pause: flush, clientFactory: () => ({ startVideo: async (_v, _r, hooks) => {
    await hooks.beforeClick({ price: 9 }); clicked++; return { state: 'accepted', providerJobId };
  } }) });
  const waiting = f.client.startVideo(value, [], { beforeClick: async () => { throw new Error('price limit changed'); } });
  waiting.catch(() => {}); await flush(); const { command } = await f.service.poll(f.device, 'ready', 'edge');
  const results = await Promise.allSettled([agent.execute(command), waiting]);
  assert.equal(results.every(r => r.status === 'rejected'), true); assert.equal(clicked, 0);
  await assert.rejects(f.service.reserve(f.device, command.id, 9), /ended/);
});
test('read-only preflight works with zero balance and never requests a paid reservation', { timeout: 10000 }, async () => {
  const f = fixture(); let reservations = 0;
  f.service.reserve = async () => { reservations++; throw new Error(); };
  const agent = new Agent({ transport: f.transport, clientFactory: () => ({ preflight: async () => ({ ready: true, submitted: false, price: 2, balance: 0 }) }) });
  const waiting = f.client.preflight(value); await flush(); const { command } = await f.service.poll(f.device, 'needs_login', 'edge');
  const [, result] = await Promise.all([agent.execute(command), waiting]);
  assert.equal(result.balance, 0); assert.equal(reservations, 0);
});
test('synthetic reference checks transfer verified media without a generation row, receipt or reservation',async()=>{
  const {diagnosticReferences,diagnosticImageReferences}=require('../src/aivid_probe_assets.js');
  for(const refs of [diagnosticReferences(),diagnosticImageReferences()]){
    const f=fixture();let reservations=0,checks=0;
    const counts={image:refs.filter(r=>r.kind==='image').length,video:refs.filter(r=>r.kind==='video').length,audio:refs.filter(r=>r.kind==='audio').length};
    f.service.reserve=async()=>{reservations++;throw new Error('A diagnostic must not reserve')};
    const requested={...value,model:'aivid_seedance_2_0_mini',duration:5};
    const agent=new Agent({transport:f.transport,clientFactory:()=>({checkReferences:async(v,files)=>{
      checks++;assert.equal(files.length,3);files.forEach((r,i)=>assert.deepEqual(r.data,refs[i].data));
      return {ready:true,verified:true,submitted:false,generationBlocked:true,modelId:v.model,duration:v.duration,
        resolution:v.resolution,aspectRatio:v.aspectRatio,uploadedCounts:counts,price:1,balanceBefore:50,balanceAfter:50,secret:'not-returned'};
    }})});
    const waiting=f.client.checkReferences(requested,refs);await flush();const {command}=await f.service.poll(f.device, 'ready', 'edge');
    assert.equal(command.kind,'reference_check');
    const [,result]=await Promise.all([agent.execute(command),waiting]);
    assert.equal(checks,1);assert.equal(reservations,0);assert.equal(result.generationBlocked,true);
    assert.equal(result.balanceAfter,50);assert.doesNotMatch(JSON.stringify(result),/not-returned/);
    assert.deepEqual(result.uploadedCounts,counts);assert.equal(f.store.rows.size,0);
  }
});
test('Premium preflight relay preserves verified model settings and rejects wrong or missing attestations',async()=>{
  const requested={...value,model:'aivid_seedance_2_5',duration:5,resolution:'720p'};
  const good={ready:true,submitted:false,price:14,balance:50,modelId:requested.model,
    duration:5,resolution:'720p',aspectRatio:'16:9'};
  for(const [patch,code] of [[{},null],[{modelId:'aivid_seedance_2_0_mini'},'form_model'],
    [{duration:15},'form_duration'],[{resolution:'480p'},'form_resolution'],
    [{aspectRatio:'9:16'},'form_aspect_ratio'],[{modelId:undefined},'form_model']]){
    const f=fixture(),id=crypto.randomUUID();
    await f.store.insert({id,deviceId:f.device.deviceId,kind:'preflight',expiresAt:Date.now()+10000,payload:{value:requested}});
    await f.service.poll(f.device, 'ready', 'edge');
    await f.service.result(f.device,id,{...good,...patch,secret:'do-not-relay'});
    const response=(await f.store.get(id)).response;
    if(code)assert.deepEqual(response,{error:true,errorCode:code});
    else assert.deepEqual(response,good);
    assert.doesNotMatch(JSON.stringify(response),/do-not-relay/);
  }
});
test('MP4 is transferred in bounded chunks and verified before the existing queue receives it', { timeout: 10000 }, async () => {
  const f = fixture(), data = Buffer.alloc(1024 * 1024 + 20); data.write('ftyp', 4, 'ascii');
  const request = f.transport.request;
  let chunkAttempts = 0;
  f.transport.request = async (route, options) => {
    if (route.includes('/chunks/') && ++chunkAttempts === 1) {
      await request(route, options);
      throw Object.assign(new Error('Lost chunk acknowledgement'), { network: true });
    }
    return request(route, options);
  };
  const agent = new Agent({ pause: flush, transport: f.transport, clientFactory: () => ({ collectVideo: async () => ({ state: 'completed', output: { data, mimeType: 'video/mp4' } }) }) });
  const waiting = f.client.collectVideo(providerJobId); await flush(); const { command } = await f.service.poll(f.device, 'ready', 'edge');
  const [, result] = await Promise.all([agent.execute(command), waiting]);
  assert.equal(result.state, 'completed'); assert.deepEqual(result.output.data, data);
  assert.equal(chunkAttempts, 3);
  assert.equal(f.store.rows.size, 0); assert.equal(f.store.chunks.size, 0);
});
test('collection relay preserves only the approved reason on a failed video', async () => {
  for (const [state, errorCode, expected] of [
    ['failed', 'source_sensitive_content', { state: 'failed', errorCode: 'source_sensitive_content' }],
    ['failed', 'private provider diagnostic', { state: 'failed' }],
    ['pending', 'source_sensitive_content', { state: 'pending' }],
  ]) {
    const f = fixture();
    const agent = new Agent({ transport: f.transport, clientFactory: () => ({
      collectVideo: async () => ({ state, errorCode, message: 'private provider message' }),
    }) });
    const waiting = f.client.collectVideo(providerJobId);
    await flush();
    const { command } = await f.service.poll(f.device, 'ready', 'edge');
    const [, result] = await Promise.all([agent.execute(command), waiting]);
    assert.deepEqual(result, expected);
  }
});
test('invalid, missing or out-of-order MP4 chunks cannot complete an output', async () => {
  const f = fixture(), data = Buffer.from('0000ftypisom0000');
  await f.store.chunk(jobId, 1, data);
  await assert.rejects(f.store.output(jobId, { size: data.length, chunks: 1, sha256: hash(data) }), /Incomplete/);
  f.store.chunks.clear(); await f.store.chunk(jobId, 0, data);
  await assert.rejects(f.store.output(jobId, { size: data.length, chunks: 1, sha256: '0'.repeat(64) }), /Invalid MP4/);
  assert.notEqual(hash(Buffer.from([0xff])), hash(Buffer.from([0xfe])));
});
test('only fixed diagnostic codes reach Admin; raw browser failures stay private', async () => {
  const f = fixture();
  const waiting = f.client.preflight(value); waiting.catch(() => {});
  await flush(); const { command } = await f.service.poll(f.device, 'needs_login', 'edge');
  await f.service.result(f.device, command.id, { error: true, errorCode: 'duration', message: 'SECRET cookie token' });
  await assert.rejects(waiting, error => {
    assert.match(error.message, /\[duration\].*duration slider/); assert.doesNotMatch(error.message, /SECRET|cookie|token/); return true;
  });
  const second = f.client.preflight(value); second.catch(() => {});
  await flush(); const next = (await f.service.poll(f.device, 'needs_login', 'edge')).command;
  await f.service.result(f.device, next.id, { error: true, errorCode: 'SECRET cookie token' });
  await assert.rejects(second, error => { assert.doesNotMatch(error.message, /SECRET|cookie|token/); return true; });
});

test('upload rejection before reservation reports safely without a receipt or paid request',async t=>{
  const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'aivid-no-reserve-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let reservations=0;
  const agent=new Agent({root,transport:f.transport,clientFactory:()=>({startVideo:async()=>({state:'rejected'})})});
  const waiting=f.client.startVideo(value,[],{beforeClick:async()=>{reservations++}});await flush();
  const {command}=await f.service.poll(f.device, 'ready', 'edge');
  await assert.rejects(f.service.result(f.device,command.id,{state:'accepted',providerJobId}),/not reserved/);
  await assert.rejects(f.service.result(f.device,command.id,{state:'submission_uncertain'}),/not reserved/);
  const [,result]=await Promise.all([agent.execute(command),waiting]);
  assert.equal(result.state,'rejected');assert.equal(reservations,0);
  await assert.rejects(fs.stat(path.join(root,'receipts',jobId+'.json')),e=>e.code==='ENOENT');
});

test('offline pairing recovers accepted videos while live agents and uncertain charges remain protected',async()=>{
 const f=fixture();let uncertain=false;
 f.db.execute=async sql=>[[{total:sql.includes("status='submitting' OR")?(uncertain?1:0):1}]];
 const code=await f.service.createPairing();
 const paired=await f.service.pair(code.code);assert.notEqual(paired.deviceId,f.device.deviceId);
 await assert.rejects(f.service.authorize('Bearer '+f.token),/authentication/);
 f.records.set(HEARTBEAT_KEY,JSON.stringify({deviceId:paired.deviceId,status:'ready',seenAt:new Date().toISOString()}));
 await assert.rejects(f.service.createPairing(),/Stop the existing/);
 f.records.delete(HEARTBEAT_KEY);uncertain=true;
 await assert.rejects(f.service.createPairing(),/uncertain submission/);
});

test('a cleanup outage preserves the accepted result after a paid submission', async () => {
  const f = fixture();
  f.store.remove = async () => { throw new Error('Database connection interrupted'); };
  const waiting = f.client.startVideo(value, [], { beforeClick: async () => {} });
  await flush();
  const { command } = await f.service.poll(f.device, 'ready', 'edge');
  await f.service.reserve(f.device, command.id, 2);
  await flush();
  await f.service.result(f.device, command.id, { state: 'accepted', providerJobId });
  assert.deepEqual(await waiting, { state: 'accepted', providerJobId });
});

test('security verification pauses browser checks and leaves queued commands unclaimed', async t => {
  const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'rdp-verification-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await f.store.insert({id:jobId,deviceId:f.device.deviceId,kind:'preflight',payload:{},expiresAt:Date.now()+10000});
  let now=0,checks=0;
  const statuses=[];
  const agent=new Agent({root,now:()=>now,pause:async()=>{now+=30000;},
    transport:{request:async(route,options)=>{
      const status=options.body.status;
      statuses.push(status);
      if(statuses.length===4)agent.stopping=true;
      return f.transport.request(route,options);
    }},clientFactory:()=>({preflight:async()=>{
      checks++;
      throw Object.assign(new Error('Verification required'),{aividCode:'session_verification'});
    }})});
  await agent.run();
  assert.equal(checks,1);
  assert.deepEqual(statuses,['starting','needs_verification','needs_verification','needs_verification']);
  assert.equal((await f.store.get(jobId)).state,'queued');
  const device=await readDevice(f.read);
  assert.equal(publicDevice(device).status,'needs_verification');
  await assert.rejects(new AividRdpClient({rdpDevice:device,store:f.store}).preflight(value),{aividCode:'session_verification'});
  assert.equal(f.store.rows.size,1);
});


test('Windows-only live preview and MP4 retrieval use paired agent RPC without touching paid job flow',async()=>{
 const f=fixture();
 const mp4=Buffer.concat([Buffer.from([0,0,0,16]),Buffer.from('ftyp'),Buffer.alloc(32,8)]);
 const agent=new Agent({transport:f.transport,clientFactory:()=>{throw new Error('Live browser must not use the paid provider adapter.');}});
 agent.live={run:async payload=>payload.action==='download'?{state:'download',data:mp4}:{
   state:'frame',jpeg:'',url:'https://aivid.dev/',notice:'Private Edge profile',fileName:'',
   uploadPending:false,downloadReady:false,secretKey:Buffer.from('test-key').toString('base64')
 }};
 const framePromise=f.client.run('live',{owner:'42',action:'open'},{timeoutMs:15000});
 await flush();
 const first=await f.service.poll(f.device,'ready','edge');
 assert.equal(first.command.kind,'live');
 assert.equal(first.command.payload.owner,'42');
 await agent.execute(first.command);
 const frame=await framePromise;
 assert.equal(frame.state,'frame');
 assert.equal(frame.notice,'Private Edge profile');
 assert.equal(frame.secretKey,Buffer.from('test-key').toString('base64'));
 const downloadPromise=f.client.run('live',{owner:'42',action:'download'},{timeoutMs:15000});
 await flush();
 const next=await f.service.poll(f.device,'ready','edge');
 assert.equal(next.command.kind,'live');
 await agent.execute(next.command);
 const download=await downloadPromise;
 assert.equal(download.state,'download');
 assert.deepEqual(download.output.data,mp4);
 assert.equal(f.store.rows.size,0,'Completed live commands must be deleted with their temporary MySQL chunks.');
});

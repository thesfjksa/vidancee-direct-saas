'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const store = require('../src/customer_api_store.js');
const { createCustomerApi, normalizeInput, publicJob } = require('../src/customer_api.js');

test('request IDs are required and hashes cover settings, ordered references and media bytes', () => {
  assert.throws(() => store.requestContext('k', '', {}, 'video'), { statusCode: 400 });
  assert.throws(() => store.requestContext('k', 'line\nbreak', {}, 'video'), { statusCode: 400 });
  const a = store.requestContext('k', 'request-123', { prompt: 'x', model: 'm' }, 'video');
  const b = store.requestContext('other-key', 'request-123', { model: 'm', prompt: 'x' }, 'video');
  assert.equal(a.requestHash, b.requestHash);
  assert.equal(a.requestKeyHash, b.requestKeyHash);
  assert.notEqual(a.requestHash, store.requestContext('k', 'request-123', { model: 'm', prompt: 'y' }, 'video').requestHash);
  const file = bytes => ({ images: [{ data: Buffer.from(bytes), filename: 'x.png', mimeType: 'image/png' }] });
  assert.notEqual(store.requestContext('k', 'request-123', file('a'), 'video').requestHash, store.requestContext('k', 'request-123', file('b'), 'video').requestHash);
  assert.notEqual(a.requestHash, store.requestContext('k', 'request-123', { prompt: 'x', model: 'm' }, 'image').requestHash);
});
test('public inputs reject billing overrides, internal job metadata, malformed references and conflicting aliases', () => {
  assert.throws(() => normalizeInput({ model: 'm', credits_cost: 0 }), { statusCode: 400 });
  assert.throws(() => normalizeInput({ model: 'm', apiRequest: {} }), { statusCode: 400 });
  assert.throws(() => normalizeInput({ model: 'm', videoUploads: [{ key: 'ignored-upload' }] }), { statusCode: 400 });
  assert.throws(() => normalizeInput({ model: 'm', videos: [{ data: Buffer.from('x'), mimeType: 'video/mp4', filename: 'x.mp4' }] }, 'image'), { statusCode: 400 });
  assert.throws(() => normalizeInput({ model: 'm', videos: ['http://127.0.0.1/'] }), { statusCode: 400 });
  assert.throws(() => normalizeInput({ model: 'm', duration: 5, seconds: 10 }), { statusCode: 400 });
  assert.throws(() => normalizeInput({ model: 'm', generateAudio: 'yes' }), { statusCode: 400 });
  assert.deepEqual(normalizeInput({ model: ' m ', seconds: '5', ratio: '16:9', generateAudio: 'false' }), { model: 'm', duration: 5, aspectRatio: '16:9', generateAudio: false });
});
test('public jobs hide provider prices, raw output links and provider operations', () => {
  const data = publicJob({ id: 'j', model: 'm', status: 'completed', credits_cost: '12', output_url: 'https://secret-vendor.example/output', provider_cost: 1, provider_operation: 'secret' }, 'video');
  assert.equal(data.content_url, '/v1/videos/j/content');
  assert.equal(data.credits_cost, 12);
  for (const name of ['output_url','provider_cost','provider_operation']) assert.equal(data[name], undefined);
});
test('API key creation stores only the secret hash and returns the secret once', async () => {
  let saved; let committed = false;
  const conn = { beginTransaction: async () => {}, commit: async () => { committed = true; }, rollback: async () => {}, release() {},
    execute: async (sql,args) => {
      if (sql.startsWith('SELECT id,status')) return [[{ id: 7, status: 'active' }]];
      if (sql.startsWith('SELECT COUNT')) return [[{ total: 0 }]];
      if (sql.startsWith('INSERT')) { saved = args; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('SELECT id,name')) return [[{ id: saved[0], name: saved[2], key_prefix: saved[4] }]];
      throw new Error(sql);
    } };
  const result = await store.createKey({ getConnection: async () => conn }, 7, { name: 'Production', expiresInDays: 30 });
  assert.match(result.secret, /^cmm_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(saved[3], store.hash(result.secret));
  assert.ok(!saved.includes(result.secret));
  assert.equal(result.key.secret, undefined); assert.equal(committed, true);
  await assert.rejects(store.createKey({}, 7, { name: '', expiresInDays: 0 }), { statusCode: 400 });
});
test('API keys cannot use session cookies as authentication and use a persistent rate limit', async () => {
  await assert.rejects(store.authenticate({}, { headers: { cookie: 'cmm_session=abc' } }), { statusCode: 401 });
  let calls = 0;
  const db = { execute: async(sql,args) => { calls++; if (sql.startsWith('SELECT')) { assert.match(sql,/revoked_at IS NULL/); assert.match(sql,/u.status='active'/); return [[{ id: 7, api_key_id: 'k' }]]; } assert.equal(args[1],120); return [{ affectedRows: 0 }]; } };
  await assert.rejects(store.authenticate(db, { headers: { authorization: 'Bearer cmm_live_' + 'a'.repeat(43) } }), { statusCode: 429 });
  assert.equal(calls, 2);
});
test('key limits roll back creation and metadata never exposes hashes or secrets', async () => {
  let rolledBack=false;
  const conn={beginTransaction:async()=>{},rollback:async()=>{rolledBack=true},release(){},execute:async sql=>{
    if(sql.startsWith('SELECT id,status'))return [[{id:7,status:'active'}]];
    if(sql.startsWith('SELECT COUNT'))return [[{total:10}]];
    throw new Error('Creation should stop before insert');
  }};
  await assert.rejects(store.createKey({getConnection:async()=>conn},7,{name:'Eleventh'}),{statusCode:409});
  assert.equal(rolledBack,true);
  await store.listKeys({execute:async(sql,args)=>{
    assert.equal(args[0],7);assert.doesNotMatch(sql.split('FROM')[0],/key_hash|secret/);
    assert.match(sql,/ORDER BY \(revoked_at IS NULL/,'active keys stay visible ahead of old revoked keys');return [[]];
  }},7);
});
test('revocation is scoped to the issuing customer and missing keys return 404', async () => {
  const db={execute:async(sql,args)=>{assert.match(sql,/id=\? AND user_id=\?/);assert.deepEqual(args,['key-id',7]);return [{affectedRows:0}]}};
  await assert.rejects(store.revokeKey(db,7,'key-id'),{statusCode:404});
});
test('usage shows gross reservations, refunds and net credit usage', async () => {
  const rows=await store.usage({execute:async(sql,args)=>{
    assert.match(sql,/WHERE r.user_id=\?/);assert.deepEqual(args,[7]);return [[{api_key_id:'key',generations:'2',reserved_credits:'210.0000',refunded_credits:'105.0000'}]];
  }},7);
  assert.deepEqual(rows,[{key_id:'key',generations:2,reserved_credits:210,refunded_credits:105,net_credits:105}]);
});
test('idempotency tombstones prevent resubmission after a generation is deleted', async () => {
  const db = { execute: async sql => sql.includes('customer_api_requests') ? [[{ request_hash: 'h', generation_id: 'j' }]] : [[]] };
  await assert.rejects(store.findReplay(db, 7, { requestKeyHash: 'k', requestHash: 'h' }), { statusCode: 410 });
  await assert.rejects(store.findReplay(db, 7, { requestKeyHash: 'k', requestHash: 'other' }), { statusCode: 409 });
});

test('HTTP API authenticates, scopes jobs, quotes and replays before model availability checks', async t => {
  const secret = 'cmm_live_' + 'a'.repeat(43);
  const requests = new Map(); let submissions = 0; let available = true;
  const id = '11111111-1111-4111-8111-111111111111';
  const job = { id, user_id: 7, model: 'video-m', status: 'queued', credits_cost: 105, duration: 5, aspect_ratio: '16:9' };
  const db = { execute: async(sql,args) => {
    if (sql.includes('FROM customer_api_keys k')) return args[0] === store.hash(secret) ? [[{ id: 7, api_key_id: 'key-id', credits: 1000 }]] : [[]];
    if (sql.startsWith('UPDATE customer_api_keys')) return [{ affectedRows: 1 }];
    if (sql.startsWith('SELECT request_hash')) return [requests.has(args[1]) ? [requests.get(args[1])] : []];
    if (sql.startsWith('SELECT * FROM generations')) return [[job]];
    if (sql.startsWith('SELECT credits')) return [[{ credits: 895 }]];
    throw new Error('Unexpected SQL: '+sql);
  } };
  const sendJson = (res,status,body) => { res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body)); };
  const readJson = async req => { const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks).toString()||'{}'); };
  const api = createCustomerApi({ getPool:()=>db,requireDatabase(){},requireUser:async()=>({id:7}),readJson,
    readGenerationRequest:readJson,sendJson,publicOrigin:()=> 'https://cmmtools.site',
    catalog:async()=>({video:available?[{id:'video-m'}]:[],image:[{id:'image-m'}]}),
    quote:async(userId,body)=>{assert.equal(userId,7);assert.equal(body.model,'video-m');return {cost:105,isEstimate:false};},
    submitVideo:async(user,body,req,context)=>{submissions++;requests.set(context.requestKeyHash,{request_hash:context.requestHash,generation_id:id});return job;},
    getVideo:async(userId,jobId)=>{assert.equal(userId,7);return jobId===id?{...job,output_url:'db:video'}:null;},
    listVideos:async(userId)=>{assert.equal(userId,7);return [job];},serveMedia:async(row,req,res)=>{res.writeHead(200,{'content-type':'video/mp4'});res.end('mp4');},
  });
  const server=http.createServer((req,res)=>api.handle(req,res,new URL(req.url,'http://local'),req.url.split('?')[0]));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,body,headers={})=>fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+secret,'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('/v1/models',null,{authorization:''})).status,401);
  assert.equal((await call('/v1/models',null,{authorization:'Bearer cmm_live_'+'b'.repeat(43)})).status,401);
  assert.equal((await (await call('/v1/models')).json()).data[0].id,'video-m');
  assert.equal((await (await call('/v1/balance')).json()).credits,895);
  const payload={model:'video-m',prompt:'sunrise',duration:5,aspectRatio:'16:9'};
  assert.equal((await call('/v1/videos',payload)).status,400);
  assert.equal((await call('/v1/quotes',payload)).status,200);
  let response=await call('/v1/videos',payload,{'idempotency-key':'request-123'});assert.equal(response.status,202);
  available=false;
  response=await call('/v1/videos',payload,{'idempotency-key':'request-123'});assert.equal(response.status,200);assert.equal(response.headers.get('idempotency-replayed'),'true');assert.equal(submissions,1);
  assert.equal((await call('/v1/videos',{...payload,prompt:'different'},{'idempotency-key':'request-123'})).status,409);
  assert.equal((await call('/v1/videos',payload,{'idempotency-key':'new-request'})).status,403);
  assert.equal((await call('/v1/videos/'+id)).status,200);
  assert.equal((await call('/v1/videos/22222222-2222-4222-8222-222222222222')).status,404);
  assert.equal(await (await call('/v1/videos/'+id+'/content')).text(),'mp4');
  assert.equal((await call('/v1/not-real')).status,404);
  assert.equal((await call('/api/developer/keys',{name:'x'})).status,403);
  assert.equal((await call('/api/developer/keys',{name:'x'},{'x-cmmtools-key-management':'1',origin:'https://evil.example'})).status,403);
});

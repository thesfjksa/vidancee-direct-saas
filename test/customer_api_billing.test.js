'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const store=require('../src/customer_api_store.js');
// Exercise the actual image/video charging functions with a transactional
// database double. The user row mutex models SELECT ... FOR UPDATE.
const state={credits:1000,jobs:new Map(),requests:new Map(),debits:0,revoked:false,failRequestInsert:false};
let tail=Promise.resolve();
async function execute(sql,args=[],conn){
  if(sql.includes('FROM users')&&sql.includes('FOR UPDATE')){
    const previous=tail;tail=new Promise(resolve=>{conn.unlock=resolve});await previous;
    conn.before={credits:state.credits,jobs:new Map(state.jobs),requests:new Map(state.requests),debits:state.debits};
    return [[{id:7,status:'active',credits:state.credits,plan_code:'pro',price_rate:1}]];
  }
  if(sql.startsWith('SELECT id FROM customer_api_keys'))return [state.revoked?[]:[{id:'key'}]];
  if(sql.startsWith('SELECT request_hash'))return [state.requests.has(args[1])?[state.requests.get(args[1])]:[]];
  if(sql.startsWith('SELECT * FROM generations'))return [state.jobs.has(args[0])?[state.jobs.get(args[0])]:[]];
  if(sql.includes('SELECT COUNT(*) AS total FROM generations'))return [[{total:state.activeCount||0}]];
  if(sql.includes('INSERT INTO generations')){
    const image=sql.includes("'image'");
    state.jobs.set(args[0],{id:args[0],user_id:args[1],provider:args[2],media_type:image?'image':'video',model:args[5],mode:args[4],
      duration:image?0:args[6],resolution:image?null:args[7],aspect_ratio:image?args[6]:args[8],prompt:image?args[7]:args[9],credits_cost:image?args[8]:args[10],status:'queued'});
    return [{affectedRows:1}];
  }
  if(sql.startsWith('UPDATE users SET credits')){state.credits-=args[0];return [{affectedRows:1}];}
  if(sql.includes('INSERT INTO credit_transactions')){state.debits++;return [{affectedRows:1}];}
  if(sql.startsWith('INSERT INTO customer_api_requests')){
    if(state.failRequestInsert)throw new Error('Simulated database write failure');
    assert.ok(state.jobs.has(args[4]),'request and job share the transaction');
    assert.ok(!state.requests.has(args[1]),'request key remains unique');
    state.requests.set(args[1],{request_hash:args[2],generation_id:args[4]});return [{affectedRows:1}];
  }
  throw new Error('Unexpected SQL: '+sql);
}
const db={execute:(sql,args)=>execute(sql,args),getConnection:async()=>{
  const conn={beginTransaction:async()=>{},execute:(sql,args)=>execute(sql,args,conn),
    commit:async()=>{conn.committed=true;},rollback:async()=>{if(conn.before&&!conn.committed)Object.assign(state,conn.before);},release:()=>conn.unlock?.()};return conn;
}};
require('../src/db.js').getPool=()=>db;
const {createGenerationForUser}=require('../src/generations.js');
const {createImageGenerationForUser}=require('../src/image_generations.js');
const input={model:'test-model',prompt:'A sunrise',duration:5,aspectRatio:'16:9'};
const opts=context=>({provider:'api888',dynamicModel:true,costOverride:100,apiRequest:context});
function reset(){Object.assign(state,{activeCount:0,credits:1000,jobs:new Map(),requests:new Map(),debits:0,revoked:false,failRequestInsert:false});}
test('concurrent video retries reserve the shared balance and debit exactly once',async()=>{
  reset();const ctx=store.requestContext('key','request-video',input,'video');
  const [a,b]=await Promise.all([createGenerationForUser(7,input,opts(ctx)),createGenerationForUser(7,input,opts(ctx))]);
  assert.equal(a.id,b.id);assert.equal(state.jobs.size,1);assert.equal(state.requests.size,1);assert.equal(state.debits,1);assert.equal(state.credits,895);
  state.credits=0;
  assert.equal((await createGenerationForUser(7,input,opts(ctx))).id,a.id,'replay works even after the remaining balance is spent');
  assert.equal(state.debits,1);
});
test('concurrent image retries also debit exactly once',async()=>{
  reset();const ctx=store.requestContext('key','request-image',input,'image');
  const [a,b]=await Promise.all([createImageGenerationForUser(7,input,opts(ctx)),createImageGenerationForUser(7,input,opts(ctx))]);
  assert.equal(a.id,b.id);assert.equal(state.debits,1);assert.equal(state.credits,895);
});
test('conflicting requests and revocation cannot reserve credits or queue a job',async()=>{
  reset();const ctx=store.requestContext('key','same-request',input,'video');
  await createGenerationForUser(7,input,opts(ctx));
  const conflict=store.requestContext('key','same-request',{...input,prompt:'Different'},'video');
  await assert.rejects(createGenerationForUser(7,input,opts(conflict)),{statusCode:409});
  assert.equal(state.debits,1);assert.equal(state.credits,895);
  reset();state.revoked=true;
  await assert.rejects(createGenerationForUser(7,input,opts(ctx)),{statusCode:401});
  assert.equal(state.jobs.size,0);assert.equal(state.credits,1000);
});
test('failure to persist the retry record rolls back the job and credit debit together',async()=>{
  reset();state.failRequestInsert=true;
  const ctx=store.requestContext('key','failed-request',input,'video');
  await assert.rejects(createGenerationForUser(7,input,opts(ctx)),/database write failure/);
  assert.equal(state.credits,1000);assert.equal(state.jobs.size,0);assert.equal(state.debits,0);
});
test('website generation keeps its existing account pricing without an API request',async()=>{
  reset();await createGenerationForUser(7,input,opts(null));
  assert.equal(state.credits,895);assert.equal(state.debits,1);assert.equal(state.requests.size,0);
});

test('Premium price increases and invalid limits cannot create a job or debit the wallet',async()=>{
 for(const [limit,status]of [[104,409],[-1,400],['invalid',400]]){
  reset();await assert.rejects(createGenerationForUser(7,input,{...opts(null),provider:'aivid',maxCustomerCredits:limit}),{statusCode:status});
  assert.equal(state.credits,1000);assert.equal(state.jobs.size,0);assert.equal(state.debits,0);
 }
 reset();await createGenerationForUser(7,input,{...opts(null),provider:'aivid',maxCustomerCredits:105});assert.equal(state.credits,895);assert.equal(state.debits,1);
});

test('provider reference validation fails inside the transaction before any job or wallet write',async()=>{
 reset();let checked=false;
 await assert.rejects(createGenerationForUser(7,input,{...opts(null),provider:'aivid',validatePreparedReferences:refs=>{checked=true;assert.equal(refs.images.length,0);throw new Error('Reference exceeds the adapter limit');}}),/adapter limit/);
 assert.equal(checked,true);assert.equal(state.debits,0);assert.equal(state.jobs.size,0);assert.equal(state.credits,1000);
});

test('Premium waiting queue admits multiple jobs but remains bounded independently of other plans',async()=>{
 reset();state.activeCount=3;
 await createGenerationForUser(7,input,{...opts(null),provider:'aivid'});assert.equal(state.debits,1);
 reset();state.activeCount=20;await assert.rejects(createGenerationForUser(7,input,{...opts(null),provider:'aivid'}),{statusCode:429});assert.equal(state.debits,0);
 reset();state.activeCount=3;await assert.rejects(createGenerationForUser(7,input,opts(null)),{statusCode:429});assert.equal(state.debits,0);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Api888Client}=require('../src/provider/api888.js');

test('catalog recovers a temporary DNS failure without submitting a generation',async()=>{
  let calls=0;
  const client=new Api888Client({apiKey:'test-secret',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://888api.xin/v1/models');
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.authorization,'Bearer test-secret');
    if(++calls<3)throw new TypeError('fetch failed',{cause:{code:'EAI_AGAIN',message:'sensitive details'}});
    return Response.json({data:[{id:'clip'}]});
  }});
  assert.deepEqual(await client.models(),{data:[{id:'clip'}]});
  assert.equal(calls,3);
});

test('connection diagnostics preserve a safe code and never raw credentials or TLS details',async()=>{
  let calls=0;
  const client=new Api888Client({apiKey:'test-secret',fetchImpl:async()=>{
    calls++;
    throw new TypeError('secret error text',{cause:{code:'CERT_HAS_EXPIRED',message:'Bearer test-secret'}});
  }});
  await assert.rejects(client.models(),error=>{
    assert.match(error.message,/CERT_HAS_EXPIRED/);
    assert.equal(error.networkCode,'CERT_HAS_EXPIRED');
    assert.equal(error.attempts,1);
    assert.equal(error.statusCode,502);
    assert.doesNotMatch(JSON.stringify(error),/test-secret|Bearer|secret error/);
    return true;
  });
  assert.equal(calls,1);
});

test('health and status reads use bounded retries while HTTP authentication failures stay distinct',async()=>{
  for(const method of ['modelHealth','modelStatus','pricing']){
    let calls=0;
    const client=new Api888Client({apiKey:'test-secret',fetchImpl:async()=>{
      calls++;
      throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});
    }});
    await assert.rejects(client[method](),error=>error.networkCode==='ECONNRESET'&&error.attempts===3);
    assert.equal(calls,3);
  }
  let calls=0;
  const client=new Api888Client({apiKey:'test-secret',fetchImpl:async()=>{
    calls++;
    return new Response(null,{status:401});
  }});
  await assert.rejects(client.models(),/rejected the configured token/);
  assert.equal(calls,1);
});

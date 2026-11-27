'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {HuiquDiscoveryClient,discoverVideoModels}=require('../src/provider/huiqu_discovery.js');
test('only video candidates are discovered and never marked ready or priced',()=>{
 const list=discoverVideoModels({data:[{id:'sd25-30.10.0-720p',supported_endpoint_types:['openai_video']},{id:'veo-3.1'},{id:'gpt-image-2'},{id:'gemini-omni',supported_endpoint_types:['openai']},{id:'future-model',supported_endpoint_types:['video']},{id:'veo-3.1'},{id:'magi-2',available:false}]});
 assert.deepEqual(list.map(x=>x.providerModelId),['sd25-30.10.0-720p','veo-3.1','future-model']);
 assert.ok(list.every(x=>!x.ready&&!x.pricingVerified&&!x.adapterSupported&&/^huiqu_[a-f0-9]{32}$/.test(x.publicModelId)));
 assert.throws(()=>discoverVideoModels({success:false,data:[]}));
});
test('read-only authenticated discovery uses fixed host and never submits a generation',async()=>{
 const requests=[];
 const client=new HuiquDiscoveryClient({apiKey:'test-key',fetchImpl:async(url,opts)=>{requests.push([url,opts]);return Response.json({data:[{id:'veo-3.1'}]});}});
 assert.equal((await client.models()).length,1);
 assert.equal(requests[0][0],'https://api.bjhuiqu.net/v1/models');
 assert.equal(requests[0][1].method,'GET');
 assert.equal(requests[0][1].headers.authorization,'Bearer test-key');
 assert.equal(requests[0][1].redirect,'error');
 await client.metadata();await client.pricing();
 assert.ok(requests.slice(1).every(x=>!x[1].headers.authorization&&x[1].method==='GET'));
 await assert.rejects(client.get('/v1/videos/generations'),/Invalid/);
});
test('invalid JSON and authorization failure are safe diagnostics',async()=>{
 const a=new HuiquDiscoveryClient({apiKey:'secret',fetchImpl:async()=>new Response('secret',{status:401})});
 await assert.rejects(a.models(),/HTTP 401/);
 const b=new HuiquDiscoveryClient({apiKey:'secret',fetchImpl:async()=>new Response('<html>secret</html>')});
 await assert.rejects(b.models(),/invalid JSON/);
});

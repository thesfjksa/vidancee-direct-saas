'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {vidanceeMediaModels,isVidanceeModel}=require('../src/vidancee_models.js');
const {quoteGateway,modelReady}=require('../src/vercel_models.js');
const {CREDITS_PER_USD}=require('../src/billing.js');
const {VidanceeClient}=require('../src/provider/vidancee.js');
const {VidanceeQueue}=require('../src/vidancee_queue.js');
const [row]=vidanceeMediaModels();
const model={...row,...row.options,provider:'vidancee'};
test('only verified Vidancee Omni Flash choices are offered, 30 base credits',()=>{
 assert.equal(isVidanceeModel('vd_omni_flash'),true);
 assert.equal(row.providerModelId,'Omni-Flash');
 assert.deepEqual(model.durations,[4]);
 assert.deepEqual(model.aspectRatios,['9:16']);
 assert.equal(model.referenceCapabilities.image.supported,false);
 assert.ok(modelReady(model));
 assert.equal(quoteGateway(model,{duration:4,aspectRatio:'9:16'},CREDITS_PER_USD).cost,30);
 assert.throws(()=>quoteGateway(model,{duration:6},CREDITS_PER_USD),/duration/i);
 assert.throws(()=>quoteGateway(model,{duration:4,aspectRatio:'16:9'},CREDITS_PER_USD),/aspect/i);
});
test('login then submit once via Vidancee website CSRF and poll id',async()=>{
 const seen=[];
 const reply=(body,{status=200,headers={}}={})=>new Response(body,{status,headers});
 const responses=[
 reply('<input name="csrf_token" value="login-csrf">',{headers:{'set-cookie':'PHPSESSID=old; Path=/'}}),
 reply('',{status:302,headers:{location:'/studio.php','set-cookie':'PHPSESSID=abc; Path=/'}}),
 reply('<meta name="csrf-token" content="studio-csrf">'),
 reply(JSON.stringify({ok:true,job_id:26394,job_ids:[26394]}),{headers:{'content-type':'application/json'}}),
 reply(JSON.stringify({ok:true,jobs:[{id:26394,status:'completed',output_url:'renders/v26394_test.mp4'}]}))
 ];
 const client=new VidanceeClient({email:'owner@example.test',password:'fake',fetchImpl:async(u,o)=>{seen.push({url:String(u),options:o});return responses.shift();}});
 const out=await client.startVideo(model,{duration:4,aspectRatio:'9:16',prompt:'a man dancing in street'});
 assert.equal(out.requestId,'26394');
 assert.equal(seen[3].options.headers['x-csrf-token'],'studio-csrf');
 assert.equal(seen[3].options.headers.cookie,'PHPSESSID=abc');
 assert.equal(await (async()=>{const body=seen[3].options.body;return body.get('model')})(),'Omni-Flash');
 assert.equal((await client.videoStatus(out)).url,'https://vidancee.com/renders/v26394_test.mp4');
});
test('queue stores accepted operation and never repeats the POST during polling',async()=>{
 const q=new VidanceeQueue({getModel:async()=>({...model,ready:true})});q.references=async()=>[];
 const calls=[];const db={execute:async(sql,args)=>{calls.push({sql,args});return [{affectedRows:1}]}};
 const job={id:23,model:'vd_omni_flash',media_type:'video',prompt:'a man dancing',generation_options:JSON.stringify({model:{providerModelId:'Omni-Flash'},duration:4,aspectRatio:'9:16'})};
 await q.submit(db,job,{startVideo:async()=>({requestId:'26394'})});
 assert.match(calls[0].sql,/status='submitted'/);
 assert.equal(calls[0].args[1],'26394');
 q.stop();
});

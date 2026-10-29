'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {vidanceeMediaModels,isVidanceeModel,vidanceeCreditsForDuration,DURATION_CREDITS}=require('../src/vidancee_models.js');
const {quoteGateway,modelReady,validateReferences}=require('../src/vercel_models.js');
const {CREDITS_PER_USD}=require('../src/billing.js');
const {VidanceeClient}=require('../src/provider/vidancee.js');
const {VidanceeQueue}=require('../src/vidancee_queue.js');
const [row]=vidanceeMediaModels();
const model={...row,...row.options,provider:'vidancee'};
test('Omni Flash uses owner-confirmed duration options and exact base credits in both modes',()=>{
 assert.equal(isVidanceeModel('vd_omni_flash'),true);
 assert.equal(row.providerModelId,'Omni-Flash');
 assert.deepEqual(model.durations,[4,6,8,10]);
 assert.deepEqual(model.aspectRatios,['9:16']);
 assert.equal(model.referenceCapabilities.image.supported,true);
 assert.equal(model.referenceCapabilities.image.max,1);
 assert.deepEqual(model.referenceCapabilities.image.roles,['image_references']);
 assert.ok(modelReady(model));
 for(const [duration,credits] of [[4,30],[6,40],[8,50],[10,60]]){
   assert.equal(vidanceeCreditsForDuration(duration),credits);
   assert.equal(DURATION_CREDITS[duration],credits);
   // Sold at cost: Vidancee credits are $1 per 900.
   const atCost=Math.ceil(credits/900*CREDITS_PER_USD-1e-9);
   assert.equal(quoteGateway(model,{duration,aspectRatio:'9:16'},CREDITS_PER_USD).cost,atCost);
   assert.equal(quoteGateway(model,{duration,aspectRatio:'9:16',previewHasReferences:true},CREDITS_PER_USD).cost,atCost);
 }
 assert.throws(()=>quoteGateway(model,{duration:5},CREDITS_PER_USD),/duration/i);
 assert.throws(()=>vidanceeCreditsForDuration(9),/duration/i);
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

test('Omni Flash image-to-video posts one binary images[] with documented fields',async()=>{
 const seen=[];
 const reply=(body,{status=200,headers={}}={})=>new Response(body,{status,headers});
 const responses=[
  reply('<input name="csrf_token" value="login-token">',{headers:{'set-cookie':'PHPSESSID=pending; Path=/'}}),
  reply('',{status:302,headers:{location:'/studio.php','set-cookie':'PHPSESSID=done; Path=/'}}),
  reply('<meta name="csrf-token" content="studio-token">'),
  reply(JSON.stringify({ok:true,job_id:26443,job_ids:[26443],quantity:1}))
 ];
 const client=new VidanceeClient({email:'user@example.test',password:'fake',fetchImpl:async(url,options)=>{
  seen.push({url:String(url),options});return responses.shift();
 }});
 const reference={role:'image_references',mimeType:'image/png',filename:'burger.png',data:Buffer.from('not-a-real-image')};
 const job=await client.startVideo(model,{duration:4,aspectRatio:'9:16',prompt:'ad of this poster'},[reference]);
 assert.equal(job.requestId,'26443');
 const request=seen[3];assert.equal(request.url,'https://vidancee.com/api/generate.php');
 assert.equal(request.options.headers.cookie,'PHPSESSID=done');
 assert.equal(request.options.headers['x-csrf-token'],'studio-token');
 const form=request.options.body;
 assert.equal(form.get('mode'),'image-to-video');
 assert.equal(form.get('model'),'Omni-Flash');
 assert.equal(form.get('duration'),'4');
 assert.equal(form.get('aspect_ratio'),'9:16');
 assert.equal(form.get('quantity'),'1');
 assert.equal(form.get('max_retries'),'0');
 assert.equal(form.getAll('images[]').length,1);
 assert.equal(form.get('images[]').name,'burger.png');
 assert.equal(form.get('images[]').type,'image/png');
 assert.equal(form.get('images[]').size,reference.data.length);
 assert.equal(seen.filter(v=>v.url.endsWith('/api/generate.php')).length,1);
});

test('Omni Flash rejects too many, unsupported, or invalid reference images without a paid POST',async()=>{
 const c=new VidanceeClient({email:'user@example.test',password:'fake',fetchImpl:()=>{throw Error('unexpected network call')}});
 const params={duration:4,aspectRatio:'9:16',prompt:'animate poster'};
 const good={role:'image_references',mimeType:'image/png',data:Buffer.from([137,80,78,71])};
 await assert.rejects(c.startVideo(model,params,[good,good]),/one reference/i);
 await assert.rejects(c.startVideo(model,params,[{...good,role:'end_image'}]),/role/i);
 await assert.rejects(c.startVideo(model,params,[{...good,mimeType:'image/svg+xml'}]),/JPEG|PNG|WebP/i);
 await assert.rejects(c.startVideo(model,params,[{...good,data:Buffer.alloc(0)}]),/JPEG|PNG|WebP/i);
 await assert.rejects(c.startVideo(model,params,[{...good,data:Buffer.alloc(10*1024*1024+1)}]),/10 MB/i);
});

test('Vidancee queue hydrates DB image bytes and passes them to one submission',async()=>{
 const q=new VidanceeQueue({getModel:async()=>({...model,ready:true})});
 const bitmap=Buffer.from([137,80,78,71]);
 q.references=async()=>[{role:'image_references',mimeType:'image/png',url:'https://cmmtools.site/provider-media/a'}];
 const calls=[];let sent=null;
 const db={execute:async(sql,args)=>{
  calls.push([sql,args]);
  if(sql.includes('FROM generation_media'))return [[{position_index:0,media_kind:'image',media_role:'image_references',filename:'burger.png',mime_type:'image/png',media_data:bitmap}]];
  return [{affectedRows:1}];
 }};
 const job={id:'a1',model:'vd_omni_flash',media_type:'video',prompt:'animate burger',generation_options:JSON.stringify({model:{providerModelId:'Omni-Flash'},duration:4,aspectRatio:'9:16'})};
 await q.submit(db,job,{startVideo:async(_model,_params,refs)=>{sent=refs;return {requestId:'26443'};}});
 assert.equal(sent.length,1);
 assert.equal(sent[0].filename,'burger.png');
 assert.ok(sent[0].data.equals(bitmap));
 assert.equal(sent[0].url,undefined);
 assert.match(calls.at(-1)[0],/status='submitted'/);
 assert.equal(calls.at(-1)[1][1],'26443');
 q.stop();
});

test('customer validation allows one image and blocks unsupported media before billing',()=>{
 const image={data:Buffer.from([1,2,3]),mimeType:'image/png',filename:'one.png'};
 assert.doesNotThrow(()=>validateReferences(model,{images:[image]}));
 assert.doesNotThrow(()=>validateReferences(model,{images:[]}));
 assert.throws(()=>validateReferences(model,{images:[image,image]}),/too many|Unsupported/i);
 assert.throws(()=>validateReferences(model,{videos:[{data:Buffer.from([1]),mimeType:'video/mp4'}]}),/Unsupported video/i);
 assert.throws(()=>validateReferences(model,{images:[{...image,mimeType:'image/svg+xml'}]}),/format/i);
});

test('Vidancee submits all 4/6/8/10 second options for text and image without duplicate paid POSTs',async()=>{
 const makeResponse=(value,{status=200,headers={}}={})=>
   new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers});
 for(const [duration,credits] of [[4,30],[6,40],[8,50],[10,60]]){
   for(const mode of ['text-to-video','image-to-video']){
     const seen=[];
     const responseList=[
       makeResponse('<input name="csrf_token" value="token">',{headers:{'set-cookie':'PHPSESSID=before; Path=/'}}),
       makeResponse('',{status:302,headers:{location:'/studio.php','set-cookie':'PHPSESSID=after; Path=/'}}),
       makeResponse('<meta name="csrf-token" content="studio-token">'),
       makeResponse({ok:true,job_id:26443,job_ids:[26443],quantity:1})
     ];
     const client=new VidanceeClient({email:'example@test.invalid',password:'irrelevant',fetchImpl:async(url,opts)=>{
       seen.push({url:String(url),opts});return responseList.shift();
     }});
     const files=mode==='image-to-video'?[{role:'image_references',mimeType:'image/png',
       filename:'poster.png',data:Buffer.from([137,80,78,71])}]:[];
     const result=await client.startVideo(model,{duration,aspectRatio:'9:16',prompt:'animate'},files);
     assert.equal(result.requestId,'26443');
     assert.equal(result.providerCredits,credits);
     assert.equal(seen.length,4);
     const paid=seen.filter(call=>call.url.endsWith('/api/generate.php'));
     assert.equal(paid.length,1);
     const data=paid[0].opts.body;
     assert.equal(data.get('mode'),mode);
     assert.equal(data.get('duration'),String(duration));
     assert.equal(data.get('model'),'Omni-Flash');
     assert.equal(data.get('aspect_ratio'),'9:16');
     assert.equal(data.getAll('images[]').length,files.length);
     if(files.length)assert.equal(data.get('max_retries'),'0');
   }
 }
});

test('Vidancee jobs polling recovers once from an expired website session without creating paid jobs',async()=>{
 const make=(body,{status=200,headers={}}={})=>new Response(body,{status,headers});
 const login=()=>[
   make('<input name="csrf_token" value="login-csrf">',{headers:{'set-cookie':'PHPSESSID=s1; Path=/'}}),
   make('',{status:302,headers:{location:'/studio.php','set-cookie':'PHPSESSID=s2; Path=/'}}),
   make('<meta name="csrf-token" content="studio-csrf">')
 ];
 const responses=[
   ...login(),
   make('',{status:302,headers:{location:'/login.php'}}),
   ...login(),
   make(JSON.stringify({ok:true,jobs:[{id:26443,status:'completed',output_url:'renders/video.mp4'}]}))
 ];
 const seen=[];
 const client=new VidanceeClient({email:'u@site.test',password:'not-real',fetchImpl:async(url,opts)=>{
   seen.push({url:String(url),opts});return responses.shift();
 }});
 const result=await client.getJobs();
 assert.equal(result.jobs[0].id,26443);
 assert.equal(seen.length,8);
 assert.equal(seen.filter(x=>x.url.includes('generate.php')).length,0);
 assert.equal(seen.filter(x=>x.url.includes('jobs.php')).length,2);
});

test('a rejected paid Vidancee generation surfaces safe error and never automatically resubmits',async()=>{
 const make=(body,{status=200,headers={}}={})=>new Response(body,{status,headers});
 const responses=[
   make('<input name="csrf_token" value="token">',{headers:{'set-cookie':'PHPSESSID=s1; Path=/'}}),
   make('',{status:302,headers:{location:'/studio.php','set-cookie':'PHPSESSID=s2; Path=/'}}),
   make('<meta name="csrf-token" content="studio-csrf">'),
   make(JSON.stringify({ok:false,error:'Insufficient provider credits'}))
 ];
 const seen=[];
 const client=new VidanceeClient({email:'u@site.test',password:'not-real',fetchImpl:async(url,opts)=>{
   seen.push({url:String(url),opts});return responses.shift();
 }});
 await assert.rejects(client.startVideo(model,{duration:4,aspectRatio:'9:16',prompt:'bird flying'}),
   /Vidancee rejected the generation: Insufficient provider credits/);
 assert.equal(seen.filter(x=>x.url.includes('generate.php')).length,1);
});

test('a paid Vidancee POST that returns an expired login does not silently retry',async()=>{
 const make=(body,{status=200,headers={}}={})=>new Response(body,{status,headers});
 const responses=[
   make('<input name="csrf_token" value="token">',{headers:{'set-cookie':'PHPSESSID=s1; Path=/'}}),
   make('',{status:302,headers:{location:'/studio.php','set-cookie':'PHPSESSID=s2; Path=/'}}),
   make('<meta name="csrf-token" content="studio-csrf">'),
   make('',{status:302,headers:{location:'/login.php'}})
 ];
 const seen=[];
 const client=new VidanceeClient({email:'u@site.test',password:'not-real',fetchImpl:async(url,opts)=>{
   seen.push({url:String(url),opts});return responses.shift();
 }});
 await assert.rejects(client.startVideo(model,{duration:4,aspectRatio:'9:16',prompt:'bird flying'}),
   /rejected the generation session.*not retried/);
 assert.equal(seen.filter(x=>x.url.includes('generate.php')).length,1);
});

test('Vidancee error messages redact unsafe raw provider responses',async()=>{
 const make=(body,{status=200,headers={}}={})=>new Response(body,{status,headers});
 const responses=[
   make('<input name="csrf_token" value="token">',{headers:{'set-cookie':'PHPSESSID=s1; Path=/'}}),
   make('',{status:302,headers:{location:'/studio.php','set-cookie':'PHPSESSID=s2; Path=/'}}),
   make('<meta name="csrf-token" content="studio-csrf">'),
   make(JSON.stringify({ok:false,error:'password=secret and token=abc'}))
 ];
 const client=new VidanceeClient({email:'u@site.test',password:'not-real',fetchImpl:async()=>responses.shift()});
 await assert.rejects(client.startVideo(model,{duration:4,aspectRatio:'9:16',prompt:'test'}),
   err=>err.message==='Vidancee rejected the generation.');
});

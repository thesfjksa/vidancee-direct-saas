'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {UploadTracker,exactIds}=require('../src/provider/aivid_uploads.js');
const {installRequestGuard,validateJob}=require('../src/provider/aivid.js');
const API='https://api.aivid.dev',S3='https://aivid-dev.s3.ap-southeast-1.amazonaws.com/';
const references=[{kind:'image',mimeType:'image/png',data:Buffer.from('image')},{kind:'video',mimeType:'video/mp4',data:Buffer.from('video')},{kind:'audio',mimeType:'audio/wav',data:Buffer.from('audio')}];
const request=(path,body)=>({url:path.startsWith('https:')?path:API+path,method:'POST',postData:JSON.stringify(body)});
const response=(url,data,ok=true)=>({url:()=>url.startsWith('https:')?url:API+url,request:()=>({method:()=> 'POST'}),ok:()=>ok,json:async()=>data});
test('image, video and audio IDs must come from their completed presign/storage/save flow',async()=>{
  const errors=[],tracker=new UploadTracker(references,e=>errors.push(e));
  for(const [i,ref] of references.entries()){
    await tracker.before(request('/v2/uploads/presigned-url',{fileName:'reference-'+i,fileSize:ref.data.length,fileType:ref.mimeType}));
    const presign={url:S3,key:'test/key-'+i,fields:{key:'test/key-'+i},fileName:'saved-'+i,folderPath:'test'};
    await tracker.response(response('/v2/uploads/presigned-url',{data:presign}));
    assert.equal(await tracker.before(request(S3)),true);
    await tracker.response(response(S3,null));
    assert.equal(await tracker.before(request('/v2/uploads/presigned-save',{fileName:presign.fileName,fileSize:ref.data.length,fileType:ref.mimeType,filePath:presign.key,folderPath:presign.folderPath})),true);
    await tracker.response(response('/v2/uploads/presigned-save',{data:{id:'uploaded-reference-000'+i,fileType:ref.mimeType,fileSize:ref.data.length}}));
  }
  const uploaded=await tracker.completed();assert.equal(errors.length,0);
  const job=validateJob({prompt:'Test',duration:5,resolution:'480p'},references);
  const body={mode:'references',imageIds:[uploaded[0].id],videoIds:[uploaded[1].id],audioIds:[uploaded[2].id]};
  assert.doesNotThrow(()=>exactIds(body,job,uploaded));
  for(const changed of [{...body,audioIds:[]},{...body,videoIds:body.imageIds},{...body,firstFrameId:'unexpected-frame-01'},{...body,references:[{type:'image'}]},{...body,mode:'frames'}])
    assert.throws(()=>exactIds(changed,job,uploaded),/verified/);
  await assert.rejects(tracker.before(request('/v2/uploads/presigned-url',{fileName:'extra',fileSize:5,fileType:'image/png'})),/verified/);
});
test('wrong file metadata, untrusted upload destinations and failed storage never verify',async()=>{
  const tracker=new UploadTracker(references,()=>{});
  await assert.rejects(tracker.before(request('/v2/uploads/presigned-url',{fileName:'x',fileSize:999,fileType:'image/png'})),/verified/);
  await tracker.before(request('/v2/uploads/presigned-url',{fileName:'x',fileSize:5,fileType:'image/png'}));
  await tracker.response(response('/v2/uploads/presigned-url',{data:{url:'https://evil.example/',key:'x',fields:{key:'x'},fileName:'x',folderPath:'x'}}));
  await assert.rejects(tracker.before(request(S3)),/verified/);
  await assert.rejects(tracker.completed(),/verified/);
  assert.throws(()=>exactIds({audioIds:['unexpected-audio-001']},{counts:{image:0,video:0,audio:0}},[]),/verified/);
});
test('a blocked probe cannot arm or forward generation, and concurrent submissions reserve only once',async()=>{
  const page=new EventEmitter(),cdp=new EventEmitter(),calls=[];
  cdp.send=async(method,args)=>calls.push({method,args});cdp.detach=async()=>{};
  page.context=()=>({newCDPSession:async()=>cdp});
  const value={prompt:'Test',duration:5,resolution:'480p',aspectRatio:'16:9'},job=validateJob(value);
  const body={...value,model:'seedance-2.0-mini',isPublic:true,imageIds:[],videoIds:[],audioIds:[]};
  const probe=await installRequestGuard(page,job,{probe:true});
  assert.throws(()=>probe.arm(),/cannot authorize/);
  await cdp.listeners('Fetch.requestPaused')[0]({requestId:'probe',request:request('/v2/generations',body)});
  await probe.observed;assert.equal(probe.allowed,false);assert.equal(calls.at(-1).method,'Fetch.failRequest');await probe.close();
  cdp.removeAllListeners();calls.length=0;let release,reservations=0;
  const gate=new Promise(resolve=>{release=resolve});
  const guard=await installRequestGuard(page,job,{beforeGenerate:async()=>{reservations++;await gate}});guard.arm();
  const handler=cdp.listeners('Fetch.requestPaused')[0];
  const first=handler({requestId:'first',request:request('/v2/generations',body)});
  await new Promise(resolve=>setImmediate(resolve));
  await handler({requestId:'second',request:request('/v2/generations',body)});
  assert.equal(reservations,1);release();await first;
  assert.equal(calls.filter(c=>c.method==='Fetch.continueRequest').length,1);await guard.close();
});

test('three images can request links as a batch and finish out of order',async()=>{
  const images=Array.from({length:3},(_,i)=>({kind:'image',mimeType:'image/png',data:Buffer.from(String(i))}));
  const errors=[],tracker=new UploadTracker(images,e=>errors.push(e));
  const uploads=images.map((_,i)=>({fileName:'image-'+i+'.png',fileType:'image/png',fileSize:1}));
  const reply=(path,data,body)=>({...response(path,data),request:()=>({method:()=> 'POST',postData:()=>JSON.stringify(body)})});
  await Promise.all(uploads.map(body=>tracker.before(request('/v2/uploads/presigned-url',body))));
  for(const i of [2,0,1]){
    const key='test/'+i;
    await tracker.response(reply('/v2/uploads/presigned-url',{data:{url:S3,key,fields:{key},fileName:'saved-'+i,folderPath:'test'}},uploads[i]));
  }
  for(const i of [1,2,0]){
    const key='test/'+i;
    const data={...uploads[i],fileName:'saved-'+i,filePath:key,folderPath:'test'};
    const postData='--boundary\r\nContent-Disposition: form-data; name="key"\r\n\r\n'+key+'\r\n--boundary';
    assert.equal(await tracker.before({url:S3,method:'POST',postData}),true);
    await tracker.response(response(S3,null));
    await tracker.before(request('/v2/uploads/presigned-save',data));
    await tracker.response(reply('/v2/uploads/presigned-save',{data:{id:'uploaded-reference-000'+i}},data));
  }
  const results=await tracker.completed();
  assert.deepEqual(results.map(item=>item.id),[0,1,2].map(i=>'uploaded-reference-000'+i));
  assert.equal(errors.length,0);
});

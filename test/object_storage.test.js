'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {ObjectStore,validateConfig,configuredStorage,saveStorageSettings,keyFromMarker,encodeKey}=require('../src/object_storage.js');

// AWS Signature V4 examples from the S3 API reference (virtual-hosted style).
function awsExample(fetchImpl){
  const store=new ObjectStore({endpoint:'https://examplebucket.s3.amazonaws.com',bucket:'examplebucket',
    accessKeyId:'AKIAIOSFODNN7EXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region:'us-east-1',fetchImpl,now:()=>new Date('2013-05-24T00:00:00Z')});
  store.path=key=>'/'+encodeKey(key);
  return store;
}

test('presigned GET matches the AWS SigV4 reference signature',()=>{
  const url=awsExample().presign('test.txt',{expires:86400});
  assert.match(url,/X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('header-signed GET with Range matches the AWS SigV4 reference signature',async()=>{
  let sent;
  const store=awsExample(async(url,init)=>{sent=init;return new Response('0123456789',{status:206});});
  await store.get('test.txt',{range:'bytes=0-9'});
  assert.match(sent.headers.authorization,/SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

function memoryBucket(){
  const objects=new Map();
  const fetchImpl=async(url,init)=>{
    const key=decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
    if(init.method==='PUT'){
      const body=Buffer.from(init.body);
      const md5=crypto.createHash('md5').update(body).digest();
      if(init.headers['content-md5']!==md5.toString('base64'))return new Response('',{status:400});
      objects.set(key,{body,type:init.headers['content-type']});
      return new Response('',{status:200,headers:{etag:'"'+md5.toString('hex')+'"'}});
    }
    const o=objects.get(key);
    if(init.method==='DELETE'){objects.delete(key);return new Response(null,{status:204});}
    if(!o)return new Response('',{status:404});
    if(init.method==='HEAD')return new Response(null,{status:200,headers:{'content-length':String(o.body.length),'content-type':o.type}});
    return new Response(o.body,{status:200,headers:{'content-length':String(o.body.length)}});
  };
  return {objects,fetchImpl};
}

test('put verifies the checksum, head/get/remove round-trip, and check() leaves nothing behind',async()=>{
  const {objects,fetchImpl}=memoryBucket();
  const store=new ObjectStore({endpoint:'https://acct.r2.cloudflarestorage.com',bucket:'cmmtools-media',
    accessKeyId:'0123456789abcdef0123',secretAccessKey:'s'.repeat(40),fetchImpl});
  const data=Buffer.from('video-bytes');
  const put=await store.put('videos/a.mp4',data,'video/mp4');
  assert.equal(put.size,data.length);
  assert.equal((await store.head('videos/a.mp4')).size,data.length);
  assert.equal(Buffer.from(await (await store.get('videos/a.mp4')).arrayBuffer()).toString(),'video-bytes');
  await store.remove('videos/a.mp4');
  assert.equal(await store.head('videos/a.mp4'),null);
  assert.equal(await store.check(),true);
  assert.equal(objects.size,0);
  const bad=new ObjectStore({endpoint:'https://x.example',bucket:'b-1',accessKeyId:'0123456789abcdef',secretAccessKey:'s'.repeat(40),
    fetchImpl:async()=>new Response('',{status:200,headers:{etag:'"deadbeef"'}})});
  await assert.rejects(bad.put('k',data,'video/mp4'),/checksum/);
});

test('settings are validated, tested against the bucket, and the secret is saved encrypted',async()=>{
  assert.throws(()=>validateConfig({endpoint:'http://x.example',bucket:'b-1',accessKeyId:'0123456789abcdef',secretAccessKey:'s'.repeat(40)}),/https/);
  assert.throws(()=>validateConfig({endpoint:'https://x.example/bucket',bucket:'b-1',accessKeyId:'0123456789abcdef',secretAccessKey:'s'.repeat(40)}),/without a path/);
  const saved=new Map(),secrets=new Set();
  const {fetchImpl}=memoryBucket();
  await saveStorageSettings({endpoint:'https://acct.r2.cloudflarestorage.com/',bucket:'cmmtools-media',
    accessKeyId:'0123456789abcdef0123',secretAccessKey:'s'.repeat(40)},
    {fetchImpl,setSetting:async(k,v,o)=>{saved.set(k,v);if(o?.secret)secrets.add(k);}});
  assert.equal(saved.get('r2_endpoint'),'https://acct.r2.cloudflarestorage.com');
  assert.ok(secrets.has('r2_secret_access_key'));
  assert.equal(saved.get('r2_enabled'),'true');
  const store=await configuredStorage({getSetting:async(k,f)=>saved.get(k)??f});
  assert.ok(store instanceof ObjectStore);
  saved.set('r2_enabled','false');
  assert.equal(await configuredStorage({getSetting:async(k,f)=>saved.get(k)??f}),null);
  assert.ok(await configuredStorage({requireEnabled:false,getSetting:async(k,f)=>saved.get(k)??f}));
  assert.equal(keyFromMarker('r2:videos/x.mp4'),'videos/x.mp4');
  assert.equal(keyFromMarker('db:video'),null);
});

test('direct uploads: presigned PUT inside the user prefix, then collected into the form and removed',async()=>{
  const {presignUpload,collectDirectUploads,removeDirectUploads}=require('../src/direct_uploads.js');
  const {objects,fetchImpl}=memoryBucket();
  const store=new ObjectStore({endpoint:'https://acct.r2.cloudflarestorage.com',bucket:'cmmtools-media',
    accessKeyId:'0123456789abcdef0123',secretAccessKey:'s'.repeat(40),fetchImpl});
  const link=await presignUpload(7,{kind:'video',mimeType:'video/mp4',size:1000},{store});
  assert.match(link.key,/^uploads\/7\/[0-9a-f-]{36}$/);
  assert.match(link.url,/X-Amz-Signature=/);
  await assert.rejects(presignUpload(7,{kind:'video',mimeType:'video/mp4',size:30*1024*1024},{store}),/25 MB/);
  await assert.rejects(presignUpload(7,{kind:'video',mimeType:'image/png',size:10},{store}),/MP4/);
  await store.put(link.key,Buffer.from('clip-bytes'),'video/mp4');
  const body={videoUploads:JSON.stringify([{key:link.key,filename:'a.mp4',mimeType:'video/mp4'}])};
  const keys=await collectDirectUploads(body,7,{store});
  assert.deepEqual(keys,[link.key]);
  assert.equal(body.videos[0].data.toString(),'clip-bytes');
  assert.equal(body.videoUploads,undefined);
  // Another customer's key is refused.
  await assert.rejects(collectDirectUploads({videoUploads:JSON.stringify([{key:link.key,mimeType:'video/mp4'}])},8,{store}),/Invalid uploaded file/);
  const imageUploads=[];
  for(const name of ['first','second','third']){
    const image=await presignUpload(7,{kind:'image',mimeType:'image/png',size:name.length},{store});
    await store.put(image.key,Buffer.from(name),'image/png');
    imageUploads.push({key:image.key,filename:name+'.png',mimeType:'image/png'});
  }
  const imageBody={imageUploads:JSON.stringify(imageUploads)};
  const imageKeys=await collectDirectUploads(imageBody,7,{store});
  assert.deepEqual(imageBody.images.map(file=>file.data.toString()),['first','second','third']);
  await removeDirectUploads(imageKeys,{store});
  await removeDirectUploads(keys,{store});
  assert.equal(objects.size,0);
});


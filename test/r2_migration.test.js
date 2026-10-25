'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {migrateOneVideoToStorage}=require('../src/r2_migration.js');

function fakeDb(bytes){
  const MB=1024*1024;
  const state={output_url:'db:video',chunks:[],outputs:1,committed:false};
  for(let o=0,i=0;o<bytes.length;o+=MB,i++)state.chunks.push({chunk_index:i,video_data:bytes.subarray(o,o+MB)});
  const conn={
    query:async sql=>sql.includes('GET_LOCK')?[[{acquired:1}]]:[[{}]],
    release:()=>{},beginTransaction:async()=>{},commit:async()=>{state.committed=true;},rollback:async()=>{},
    execute:async(sql,args)=>{
      if(sql.startsWith('SELECT output_url'))return [[{output_url:state.output_url}]];
      if(sql.startsWith('UPDATE generations')){state.output_url=args[0];return [{}];}
      if(sql.startsWith('DELETE FROM generation_video_chunks')){state.chunks=[];return [{}];}
      if(sql.startsWith('DELETE FROM generation_video_outputs')){state.outputs=0;return [{}];}
      throw Error('unexpected '+sql);
    }};
  return {state,getConnection:async()=>conn,
    query:async sql=>[[state.output_url==='db:video'?{id:'gen-1',byte_length:bytes.length,mime_type:'video/mp4'}:undefined]],
    execute:async(sql,[,first,last])=>[state.chunks.filter(c=>c.chunk_index>=first&&c.chunk_index<=last)]};
}

test('an old MySQL video moves to cloud storage and its chunks are released only after verification',async()=>{
  const bytes=crypto.randomBytes(2.5*1024*1024);
  const db=fakeDb(bytes),objects=new Map();
  const store={put:async(k,d)=>{objects.set(k,Buffer.from(d));},
    head:async k=>({size:objects.get(k).length,etag:crypto.createHash('md5').update(objects.get(k)).digest('hex')})};
  const result=await migrateOneVideoToStorage({db,store,log:()=>{}});
  assert.equal(result.migrated,true);
  assert.equal(db.state.output_url,'r2:videos/gen-1.mp4');
  assert.deepEqual(objects.get('videos/gen-1.mp4'),bytes);
  assert.equal(db.state.chunks.length,0);
  assert.equal(db.state.outputs,0);
  assert.equal((await migrateOneVideoToStorage({db,store,log:()=>{}})).reason,'finished');
});

test('a size or checksum mismatch keeps the MySQL copy untouched',async()=>{
  const bytes=crypto.randomBytes(1024);
  const db=fakeDb(bytes);
  const store={put:async()=>{},head:async()=>({size:bytes.length,etag:'0'.repeat(32)})};
  await assert.rejects(migrateOneVideoToStorage({db,store,log:()=>{}}),/integrity check failed/);
  assert.equal(db.state.output_url,'db:video');
  assert.equal(db.state.chunks.length,1);
  assert.equal(db.state.committed,false);
});

test('images and reference files move to cloud storage and readers get the original bytes back',async()=>{
  const {migrateOneBlobToStorage}=require('../src/r2_migration.js');
  const {hydrateBlobs,isBlobRef}=require('../src/object_storage.js');
  const bytes=crypto.randomBytes(4096);
  const rows={generation_image_outputs:[],generation_images:[{pk:7,generation_id:'g',mime_type:'image/png',data:bytes}],generation_media:[]};
  const objects=new Map();
  const md5=b=>crypto.createHash('md5').update(b).digest('hex');
  const store={put:async(k,d)=>objects.set(k,Buffer.from(d)),head:async k=>({size:objects.get(k).length,etag:md5(objects.get(k))}),
    remove:async k=>objects.delete(k),get:async k=>new Response(objects.get(k))};
  const db={
    query:async sql=>{const t=sql.match(/FROM (\w+)/)[1];return [[rows[t].find(r=>r.data.length>=512)]];},
    execute:async(sql,[value,pk,len,hash])=>{const t=sql.match(/UPDATE (\w+)/)[1];const r=rows[t].find(x=>x.pk===pk&&x.data.length===len&&md5(x.data)===hash);if(r)r.data=value;return [{affectedRows:r?1:0}];},
  };
  const out=await migrateOneBlobToStorage({db,store,log:()=>{}});
  assert.equal(out.migrated,true);
  const row=rows.generation_images[0];
  assert.ok(isBlobRef(row.data));
  const copy={image_data:row.data};
  await hydrateBlobs(copy,'image_data',{store});
  assert.deepEqual(copy.image_data,bytes);
  assert.equal((await migrateOneBlobToStorage({db,store,log:()=>{}})).reason,'finished');
});

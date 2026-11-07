'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {userGenerationCleanupPreview,deleteFinishedUserGenerations}=require('../src/admin_generation_cleanup.js');

function fixture(){
  const users=[{id:7,email:'ranno@gmail.com'},{id:8,email:'other@example.com'}];
  const rows=[
    {id:'video-finished',user_id:7,media_type:'video',status:'completed'},
    {id:'image-failed',user_id:7,media_type:'image',status:'failed'},
    {id:'voice-error',user_id:7,media_type:'audio',status:'submit_error'},
    {id:'paid-pending',user_id:7,media_type:'video',status:'submitted'},
    {id:'uncertain',user_id:7,media_type:'video',status:'submitting'},
    {id:'another-person',user_id:8,media_type:'video',status:'completed'},
  ];
  const touched=[];
  const db={execute:async(sql,args=[])=>{
    if(sql.startsWith('SELECT id,email FROM users'))return [users.filter(x=>x.id===args[0])];
    if(sql.includes('AS deletable')) {
      const selected=rows.filter(x=>x.user_id===args[0]);
      return [[{deletable:selected.filter(x=>['completed','failed','submit_error'].includes(x.status)).length,
        protected:selected.filter(x=>!['completed','failed','submit_error'].includes(x.status)).length}]];
    }
    if(sql.includes('COALESCE(media_type'))return [rows.filter(x=>x.user_id===args[0]&&
      ['completed','failed','submit_error'].includes(x.status)).slice(0,Number(sql.match(/LIMIT (\d+)/)[1]))];
    throw Error('Unexpected SQL '+sql);
  }};
  const remove=type=>async(userId,id)=>{
    assert.equal(userId,7);
    const index=rows.findIndex(row=>row.id===id&&row.user_id===userId&&row.media_type===type);
    assert.ok(index>=0,'Account-scoped and matching media type');
    touched.push(id);rows.splice(index,1);
  };
  return {db,rows,touched,removeVideo:remove('video'),removeImage:remove('image'),removeAudio:remove('audio')};
}

test('read-only preview is scoped to the exact user and leaves credits untouched',async()=>{
  const f=fixture();
  assert.deepEqual(await userGenerationCleanupPreview(7,{db:f.db}),
    {userId:7,email:'ranno@gmail.com',deletable:3,protected:2});
  assert.equal(f.rows.length,6);
  await assert.rejects(userGenerationCleanupPreview(999,{db:f.db}),{statusCode:404});
});

test('typed exact email confirmation is required before any deletion',async()=>{
  const f=fixture();
  for(const email of ['other@example.com','ranno@gmail.com ',null,'RANNO@gmail.com']){
    await assert.rejects(deleteFinishedUserGenerations(7,email,f),{statusCode:409});
  }
  assert.deepEqual(f.touched,[]);
});

test('batch cleanup deletes terminal media only and preserves active jobs and other users',async()=>{
  const f=fixture();
  const result=await deleteFinishedUserGenerations(7,'ranno@gmail.com',f);
  assert.equal(result.deleted,3);assert.equal(result.remaining,0);assert.equal(result.protected,2);
  assert.deepEqual(f.touched,['video-finished','image-failed','voice-error']);
  assert.deepEqual(f.rows.map(r=>r.id),['paid-pending','uncertain','another-person']);
});

test('failure halts the batch without touching subsequent rows or another account',async()=>{
  const f=fixture();
  f.removeImage=async()=>{throw Error('provider storage unavailable')};
  const result=await deleteFinishedUserGenerations(7,'ranno@gmail.com',f);
  assert.equal(result.ok,false);
  assert.equal(result.deleted,1);
  assert.equal(result.remaining,2);
  assert.deepEqual(f.touched,['video-finished']);
  assert.equal(f.rows.find(row=>row.id==='another-person').user_id,8);
});

test('multiple small batches finish without skipping protected or concurrent rows',async()=>{
  const f=fixture();let deleted=0;
  for(let round=0;round<5;round++){
    const result=await deleteFinishedUserGenerations(7,'ranno@gmail.com',{...f,limit:1});
    deleted+=result.deleted;
    if(!result.remaining)break;
  }
  assert.equal(deleted,3);
  assert.equal(f.rows.length,3);
});

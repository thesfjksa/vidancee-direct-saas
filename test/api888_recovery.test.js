'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {recoverApi888Video}=require('../src/api888_recovery.js');

const ID='c2ebddd1-ab9b-4d25-805e-3f8d2c9c9627';
const TASK='task_D7HzxBNPpUpDmpWa38UjhusJLkJe8gVK';
const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(36,1)]);
function fixture(overrides={}){
  const state={id:ID,user_id:16,provider:'api888',media_type:'video',
    provider_job_id:TASK,provider_operation:JSON.stringify({requestId:TASK}),
    status:'failed',refunded_at:new Date('2026-10-24T06:00:00Z'),output_url:null,...overrides};
  const calls=[],events=[],stats={statusCalls:0,downloadCalls:0,transactions:0,commits:0,rollbacks:0,release:0};
  const db={
    execute:async(sql,args)=>{
      calls.push({sql,args});
      if(sql.startsWith('SELECT id,user_id,status,media_type,provider,provider_job_id'))return [[{...state}]];
      throw Error('Unexpected db.execute '+sql);
    },
    getConnection:async()=>({
      beginTransaction:async()=>{stats.transactions++;},
      execute:async(sql,args)=>{
        calls.push({sql,args});
        if(sql.includes('FOR UPDATE'))return [[{...state}]];
        if(sql.startsWith('INSERT INTO generation_video_outputs'))return [{affectedRows:1}];
        if(sql.startsWith('INSERT INTO generation_video_chunks'))return [{affectedRows:1}];
        if(sql.startsWith("UPDATE generations SET status='completed'")){
          state.status='completed';state.output_url='db:video';return [{affectedRows:1}];
        }
        throw Error('Unexpected conn.execute '+sql);
      },
      commit:async()=>{stats.commits++;},
      rollback:async()=>{stats.rollbacks++;},
      release:()=>{stats.release++;},
    }),
  };
  const client={
    videoStatus:async(id)=>{stats.statusCalls++;assert.equal(id,TASK);
      return {status:'done',url:'https://results.example.test/private-video.mp4'};},
    videoContent:async(id,url)=>{stats.downloadCalls++;assert.equal(id,TASK);
      assert.equal(url,'https://results.example.test/private-video.mp4');
      return {data:video,mimeType:'video/mp4'};},
  };
  return {db,client,state,calls,events,stats,log:e=>events.push(e)};
}
test('recover 888API completed video using the original task, preserving an existing customer refund',async()=>{
  const f=fixture();
  const result=await recoverApi888Video({...f,generationId:ID});
  assert.equal(result.recovered,true);
  assert.equal(result.refundPreserved,true);
  assert.equal(result.videoBytes,video.length);
  assert.equal(f.state.status,'completed');
  assert.equal(f.state.output_url,'db:video');
  assert.equal(f.state.refunded_at.toISOString(),'2026-10-24T06:00:00.000Z');
  assert.equal(f.stats.statusCalls,1);
  assert.equal(f.stats.downloadCalls,1);
  assert.equal(f.stats.transactions,1);
  assert.equal(f.stats.commits,1);
  assert.equal(f.stats.release,1);
  assert.ok(f.calls.some(x=>x.sql.startsWith('INSERT INTO generation_video_outputs')));
  assert.ok(f.calls.some(x=>x.sql.startsWith('INSERT INTO generation_video_chunks')));
  assert.ok(f.calls.every(x=>!/UPDATE users|credit_transactions/i.test(x.sql)),
    'Recovery must not alter customer credits or refund ledger');
  assert.equal(f.events.length,1);
  assert.equal(f.events[0].event,'api888.video_recovered');
});
test('recovery is idempotent: a second attempt never downloads or charges again',async()=>{
  const f=fixture();
  await recoverApi888Video({...f,generationId:ID});
  const second=await recoverApi888Video({...f,generationId:ID});
  assert.equal(second.alreadyRecovered,true);
  assert.equal(f.stats.downloadCalls,1);
  assert.equal(f.stats.commits,1);
  assert.equal(f.events.length,1);
});
test('cannot recover an incomplete upstream video or an unrefunded failed job',async()=>{
  const f=fixture();
  f.client.videoStatus=async()=>({status:'pending'});
  await assert.rejects(recoverApi888Video({...f,generationId:ID}),/not reported this task completed/i);
  assert.equal(f.stats.downloadCalls,0);
  assert.equal(f.stats.transactions,0);
  const unrefunded=fixture({refunded_at:null});
  await assert.rejects(recoverApi888Video({...unrefunded,generationId:ID}),/Only failed, refunded/);
  assert.equal(unrefunded.stats.statusCalls,0);
});
test('rejects arbitrary provider task IDs, other providers and malformed generation UUIDs',async()=>{
  const invalid=fixture({provider_job_id:'../evil',provider_operation:'{}'});
  await assert.rejects(recoverApi888Video({...invalid,generationId:ID}),/No valid saved 888API task ID/);
  const different=fixture();
  await assert.rejects(recoverApi888Video({...different,generationId:'not-a-uuid'}),/Invalid generation ID/);
  assert.equal(different.stats.statusCalls,0);
});
test('racing recovery checks final locked status and does not write duplicate output',async()=>{
  const f=fixture();
  const originalGet=f.db.getConnection;
  f.db.getConnection=async()=>{
    f.state.status='completed';
    f.state.output_url='db:video';
    return originalGet();
  };
  const result=await recoverApi888Video({...f,generationId:ID});
  assert.equal(result.alreadyRecovered,true);
  assert.equal(f.stats.commits,0);
  assert.equal(f.stats.rollbacks,1);
  assert.equal(f.stats.downloadCalls,1);
  assert.equal(f.events.length,0);
  assert.equal(f.calls.some(x=>x.sql.startsWith('INSERT INTO generation_video_outputs')),false);
});
test('completed result must be an MP4 buffer before storage',async()=>{
  const f=fixture();
  f.client.videoContent=async()=>({data:Buffer.alloc(0),mimeType:'video/mp4'});
  await assert.rejects(recoverApi888Video({...f,generationId:ID}),/valid MP4/);
  assert.equal(f.stats.transactions,0);
});

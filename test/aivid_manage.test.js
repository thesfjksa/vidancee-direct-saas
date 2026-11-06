'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {manageAividJob}=require('../src/aivid_queue.js');
function fixture(status='submitted',op={stage:'accepted'},source='6aee0aa512e75243dfa7c7b8'){
 const job={id:'job',user_id:7,media_type:'video',provider:'aivid',status,provider_operation:JSON.stringify(op),provider_job_id:source,credits_cost:846.72};
 const calls=[];let locked=true;
 const db={getConnection:async()=>({query:async sql=>[[{acquired:locked?1:0}]],release(){}}),execute:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.startsWith('SELECT'))return [[job]];
  if(sql.includes("SET status='failed'")){job.status='failed';job.provider_operation=args[0];}
  if(sql.startsWith('UPDATE generations SET provider_operation='))job.provider_operation=args[0];
  return [{affectedRows:1}];
 }};
 let refunds=0,removed=0;
 const deps={refund:async()=>{refunds++;job.status='failed';job.refunded_at='now';},remove:async(user,id)=>{assert.equal(user,7);assert.equal(id,'job');removed++;}};
 return {job,db,calls,deps,get refunds(){return refunds},get removed(){return removed},busy(){locked=false;}};
}
test('submitted cancellation retains source ID, stops collection and does not refund; repeat is idempotent',async()=>{
 const f=fixture('processing',{stage:'accepted',collectionPaused:true});
 assert.deepEqual(await manageAividJob(f.db,'job','cancel',f.deps),{cancelled:true,refunded:false});
 assert.equal(f.job.status,'failed');assert.equal(f.refunds,0);assert.equal(f.job.provider_job_id,'6aee0aa512e75243dfa7c7b8');
 assert.equal(JSON.parse(f.job.provider_operation).adminCancelled,true);
 await manageAividJob(f.db,'job','cancel',f.deps);assert.equal(f.refunds,0);
});
test('queued and interrupted preparing jobs refund once, ambiguous paid reservations never refund',async()=>{
 for(const status of ['queued','submitting']){
  const f=fixture(status,{stage:'preparing'},null);
  assert.equal((await manageAividJob(f.db,'job','cancel',f.deps)).refunded,true);
  await manageAividJob(f.db,'job','cancel',f.deps);assert.equal(f.refunds,1);
 }
 for(const stage of ['click_reserved','review_required']){
  const f=fixture('submitting',{stage},null);await manageAividJob(f.db,'job','cancel',f.deps);assert.equal(f.refunds,0);
 }
});
test('delete requires terminal state and persists source receipt before removing; audit failure prevents deletion',async()=>{
 const f=fixture();await assert.rejects(manageAividJob(f.db,'job','delete',f.deps),/Cancel this job/);assert.equal(f.removed,0);
 await manageAividJob(f.db,'job','cancel',f.deps);await manageAividJob(f.db,'job','delete',f.deps);assert.equal(f.removed,1);
 const receipt=f.calls.find(c=>c.sql.startsWith('INSERT INTO activity_log'));assert.equal(JSON.parse(receipt.args[2]).providerJobId,f.job.provider_job_id);
 const bad=fixture('failed');const orig=bad.db.execute;bad.db.execute=async(sql,args)=>{if(sql.startsWith('INSERT'))throw Error('audit unavailable');return orig(sql,args)};
 await assert.rejects(manageAividJob(bad.db,'job','delete',bad.deps),/audit unavailable/);assert.equal(bad.removed,0);
});
test('busy browser rejects Admin mutations without touching a job',async()=>{
 const f=fixture();f.busy();await assert.rejects(manageAividJob(f.db,'job','cancel',f.deps),/currently running/);assert.equal(f.calls.length,0);
 await assert.rejects(manageAividJob(f.db,'job','refund',f.deps),/Invalid job action/);
});

'use strict';
const crypto=require('node:crypto'),{canonical}=require('./customer_api_store'),{fail}=require('./voice_contract');
function request(key,body){
 if(typeof key!=='string'||! /^[\w-]{8,80}$/.test(key))throw fail(400,'Refresh Voice Studio and submit again.');
 const {requestKey,expectedCost,...value}=body;
 return {key,hash:crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')};
}
async function receipt(conn,userId,context){
 const [[row]]=await conn.execute('SELECT * FROM voice_studio_requests WHERE user_id=? AND request_key=?',[userId,context.key]);
 if(row&&row.request_hash!==context.hash)throw fail(409,'This request key was already used with different voice settings.');return row;
}
async function findReplay(conn,userId,context){
 const row=await receipt(conn,userId,context);if(!row)return null;
 const [[generation]]=await conn.execute('SELECT * FROM generations WHERE id=? AND user_id=?',[row.generation_id,userId]);
 if(!generation)throw fail(409,'This request was already created and later removed. Start a new request.');return generation;
}
async function saveRequest(conn,userId,context,{generationId=null,cloneId=null}){await conn.execute('INSERT INTO voice_studio_requests (user_id,request_key,request_hash,generation_id,clone_id) VALUES (?,?,?,?,?)',[userId,context.key,context.hash,generationId,cloneId]);}
async function settle(db,row,sourceCost){
 if(sourceCost===null||!Number.isFinite(sourceCost)||sourceCost<0)throw Error('Voice provider has not reported a valid final credit charge.');
 const {vibiToCustomerCredits,voiceCreditsPerPkr,roundYuanCredits}=require('./billing');
 let params={};try{params=JSON.parse(row.provider_meta||'{}');}catch{}
 const conn=await db.getConnection();
 try{
  await conn.beginTransaction();
  const [[user]]=await conn.execute('SELECT credits,plan_code FROM users WHERE id=? FOR UPDATE',[row.user_id]);
  const [[fresh]]=await conn.execute('SELECT status,credits_cost,refunded_at FROM generations WHERE id=? FOR UPDATE',[row.id]);
  if(!fresh||fresh.refunded_at||fresh.status==='completed'){await conn.commit();return;}
  const basis=params.billingPolicy==='vibi-at-cost-v1'?Number(params.customerCreditsPerPkr):voiceCreditsPerPkr(user);
  const cost=vibiToCustomerCredits(sourceCost,basis);if(cost===null)throw Error('Voice billing conversion is unavailable.');
  const delta=roundYuanCredits(cost-Number(fresh.credits_cost));
  if(!user||Number(user.credits)<delta)throw Error('Additional credits are needed to settle the completed voice task.');
  if(delta){
   await conn.execute('UPDATE users SET credits=credits-? WHERE id=?',[delta,row.user_id]);
   await conn.execute("INSERT INTO credit_transactions (user_id,generation_id,amount,type,note) VALUES (?,?,?,'voice_adjustment',?)",[row.user_id,row.id,-delta,'Voice provider final usage adjustment']);
  }
  await conn.execute('UPDATE generations SET credits_cost=?,provider_cost=? WHERE id=?',[cost,sourceCost,row.id]);
  await conn.commit();
 }catch(e){await conn.rollback();throw e;}finally{conn.release();}
}
async function refundClone(db,row){
 const conn=await db.getConnection();try{
  await conn.beginTransaction();
  await conn.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[row.user_id]);
  const [[fresh]]=await conn.execute('SELECT * FROM user_voice_clones WHERE id=? FOR UPDATE',[row.id]);
  if(fresh&&!fresh.refunded_at){
   const amount=Number(fresh.credits_cost||0);
   if(amount>0){await conn.execute('UPDATE users SET credits=credits+? WHERE id=?',[amount,row.user_id]);await conn.execute("INSERT INTO credit_transactions (user_id,generation_id,amount,type,note) VALUES (?,NULL,?,'voice_clone_refund',?)",[row.user_id,amount,'Voice cloning failed. Credits were refunded.']);}
   await conn.execute("UPDATE user_voice_clones SET status='failed',refunded_at=UTC_TIMESTAMP(),sample_data=NULL,error_message='Voice cloning failed. Credits were refunded.',updated_at=UTC_TIMESTAMP() WHERE id=?",[row.id]);
  }
  await conn.commit();
 }catch(e){await conn.rollback();throw e;}finally{conn.release();}
}
module.exports={request,receipt,findReplay,saveRequest,settle,refundClone};

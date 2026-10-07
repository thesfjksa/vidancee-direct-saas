'use strict';

const crypto=require('node:crypto');
const {getPool}=require('./db.js');
const {getPlanProfile}=require('./plans.js');
const {roundCredits}=require('./billing.js');

function serializeVoiceGeneration(row){
  return {
    id:row.id,
    media_type:'audio',
    mode:row.mode,
    model:row.model,
    prompt:row.prompt,
    status:row.status,
    credits_cost:Number(row.credits_cost),
    error_message:row.error_message,
    created_at:row.created_at,
    submitted_at:row.submitted_at,
    started_at:row.started_at,
    completed_at:row.completed_at,
    refunded_at:row.refunded_at,
    has_audio:Boolean(row.output_url),
    audio_url:row.output_url?'/api/voice-generations/'+row.id+'/media':null,
  };
}

async function createVoiceGenerationForUser(userId,input,options={}){
  const text=String(input.text||input.prompt||'').trim();
  if(!text){
    const error=new Error('Text is required.');error.statusCode=400;throw error;
  }
  if(text.length>50000){
    const error=new Error('Text is too long.');error.statusCode=400;throw error;
  }

  const cost=roundCredits(Number(options.costOverride));
  if(!Number.isFinite(cost)||cost<0){
    const error=new Error('Voice generation cost is unavailable.');error.statusCode=502;throw error;
  }

  const provider=String(options.provider||'aitoolsflow').slice(0,40);
  const model=String(options.model||input.model||'voice_multilingual').slice(0,80);
  const providerCost=Number(options.providerCost);
  const providerCostValue=Number.isFinite(providerCost)&&providerCost>=0?providerCost:null;
  const providerCostUnit=providerCostValue==null?null:String(options.providerCostUnit||'credits').slice(0,20);
  const id=crypto.randomUUID();

  const db=getPool();
  const conn=await db.getConnection();
  try{
    await conn.beginTransaction();
    const [users]=await conn.execute(
      'SELECT id,credits,status,plan_code FROM users WHERE id=? FOR UPDATE',
      [userId]
    );
    const user=users[0];
    if(!user||user.status!=='active'){
      const error=new Error('User account is unavailable.');error.statusCode=403;throw error;
    }
    if(Number(user.credits)<cost){
      const error=new Error('Not enough credits.');error.statusCode=402;throw error;
    }

    const planProfile=getPlanProfile(user.plan_code);
    const [[activeRow]]=await conn.execute(
      "SELECT COUNT(*) AS total FROM generations WHERE user_id=? AND status IN ('queued','submitting','submitted','processing')",
      [userId]
    );
    if(Number(activeRow?.total||0)>=planProfile.concurrency){
      const error=new Error(
        planProfile.code
          ? planProfile.name+' allows up to '+planProfile.concurrency+' simultaneous generations.'
          : 'Choose a plan to run more than one generation at a time.'
      );
      error.statusCode=429;throw error;
    }

    await conn.execute(
      `INSERT INTO generations
       (id,user_id,provider,media_type,queue_priority,mode,model,duration,resolution,aspect_ratio,prompt,status,credits_cost,provider_cost,provider_cost_unit)
       VALUES (?,?,?,'audio',?,'text-to-speech',?,0,NULL,'audio',?,'queued',?,?,?)`,
      [id,userId,provider,planProfile.queuePriority,model,text,cost,providerCostValue,providerCostUnit]
    );

    await conn.execute('UPDATE users SET credits=credits-? WHERE id=?',[cost,userId]);
    await conn.execute(
      `INSERT INTO credit_transactions (user_id,generation_id,amount,type,note)
       VALUES (?, ?, ?, 'generation_debit', ?)`,
      [userId,id,-cost,'Reserved for voice generation']
    );
    await conn.commit();
  }catch(error){
    await conn.rollback();throw error;
  }finally{
    conn.release();
  }

  const [rows]=await db.execute('SELECT * FROM generations WHERE id=?',[id]);
  return serializeVoiceGeneration(rows[0]);
}

async function listUserVoiceGenerations(userId,limit=60){
  const db=getPool();
  const safeLimit=Math.min(100,Math.max(1,Number(limit)||60));
  const [rows]=await db.query(
    "SELECT * FROM generations WHERE user_id=? AND media_type='audio' ORDER BY created_at DESC LIMIT "+safeLimit,
    [userId]
  );
  return rows.map(serializeVoiceGeneration);
}

async function getUserVoiceGeneration(userId,id){
  const db=getPool();
  const [rows]=await db.execute(
    "SELECT * FROM generations WHERE id=? AND user_id=? AND media_type='audio' LIMIT 1",
    [id,userId]
  );
  return rows[0]||null;
}

async function deleteUserVoiceGeneration(userId,generationId){
  const db=getPool();
  const conn=await db.getConnection();
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(
      "SELECT id,status FROM generations WHERE id=? AND user_id=? AND media_type='audio' FOR UPDATE",
      [generationId,userId]
    );
    const row=rows[0];
    if(!row){
      const error=new Error('Voice generation not found.');error.statusCode=404;throw error;
    }
    if(!['completed','failed','submit_error'].includes(String(row.status))){
      const error=new Error('This voice generation is still in progress and cannot be deleted yet.');
      error.statusCode=409;throw error;
    }
    await conn.execute(
      'UPDATE credit_transactions SET generation_id=NULL WHERE generation_id=? AND user_id=?',
      [generationId,userId]
    );
    await conn.execute(
      "DELETE FROM generations WHERE id=? AND user_id=? AND media_type='audio'",
      [generationId,userId]
    );
    await conn.commit();
    return true;
  }catch(error){
    await conn.rollback();throw error;
  }finally{
    conn.release();
  }
}

module.exports={
  serializeVoiceGeneration,
  createVoiceGenerationForUser,
  listUserVoiceGenerations,
  getUserVoiceGeneration,
  deleteUserVoiceGeneration,
};

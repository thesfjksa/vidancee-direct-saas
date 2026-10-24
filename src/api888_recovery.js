'use strict';

const {saveVideoOutput}=require('./video_outputs.js');
const {logActivity}=require('./activity_log.js');

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_RE=/^[A-Za-z0-9_-]{5,191}$/;

function recoveryError(message,statusCode=409){
  return Object.assign(new Error(message),{statusCode});
}

// Explicit admin-only recovery of the SAME upstream task; never sends a paid
// request, never reverses or charges credits. A refunded job is delivered as a
// goodwill recovery, with the original credit ledger entries left untouched.
async function recoverApi888Video({db,client,generationId,log=logActivity}){
  const id=String(generationId||'');
  if(!UUID_RE.test(id))throw recoveryError('Invalid generation ID.',400);
  const [[job]]=await db.execute(
    "SELECT id,user_id,status,media_type,provider,provider_job_id,provider_operation,refunded_at,output_url FROM generations WHERE id=? AND provider='api888' AND media_type='video' LIMIT 1",
    [id]);
  if(!job)throw recoveryError('888API video generation not found.',404);
  if(job.status==='completed'&&job.output_url==='db:video')
    return {recovered:false,alreadyRecovered:true,generationId:id,refundPreserved:Boolean(job.refunded_at)};
  if(job.status!=='failed'||!job.refunded_at||job.output_url)
    throw recoveryError('Only failed, refunded 888API video jobs without saved output can be recovered.');
  let saved={};
  try{saved=JSON.parse(job.provider_operation||'{}')||{};}catch{}
  const taskId=String(job.provider_job_id||saved.requestId||'');
  if(!TASK_RE.test(taskId))throw recoveryError('No valid saved 888API task ID.');

  // Only GET the original provider task status and its completed video content.
  // No POST /v1/videos; no credit or balance mutation.
  const status=await client.videoStatus(taskId);
  if(status.status!=='done')
    throw recoveryError('888API has not reported this task completed. Current provider state: '+status.status+'.');
  const video=await client.videoContent(taskId,status.url);
  if(!Buffer.isBuffer(video?.data)||video.data.length===0||video.mimeType!=='video/mp4')
    throw recoveryError('888API did not return a valid MP4 video.',502);

  const conn=await db.getConnection();
  let userId;
  try{
    await conn.beginTransaction();
    const [[fresh]]=await conn.execute(
      "SELECT id,user_id,status,refunded_at,output_url FROM generations WHERE id=? FOR UPDATE",[id]);
    if(fresh?.status==='completed'&&fresh.output_url==='db:video'){
      await conn.rollback();
      return {recovered:false,alreadyRecovered:true,generationId:id,refundPreserved:Boolean(fresh.refunded_at)};
    }
    if(!fresh||fresh.status!=='failed'||!fresh.refunded_at||fresh.output_url)
      throw recoveryError('Generation changed while recovering; no media was saved.');
    userId=Number(fresh.user_id);
    await saveVideoOutput(conn,id,video);
    await conn.execute(
      "UPDATE generations SET status='completed',output_url='db:video',error_message=NULL,completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=?",
      [id]);
    // IMPORTANT: preserve refunded_at and the refund transaction (no re-charge).
    await conn.commit();
  }catch(error){
    await conn.rollback().catch(()=>{});
    throw error;
  }finally{conn.release();}

  log({category:'admin',event:'api888.video_recovered',provider:'api888',
    userId,generationId:id,message:'Recovered an already-completed 888API video; customer refund retained.',
    details:{videoBytes:video.data.length,refundPreserved:true,providerTaskId:taskId}});
  return {recovered:true,alreadyRecovered:false,generationId:id,refundPreserved:true,
    videoBytes:video.data.length};
}

module.exports={recoverApi888Video};

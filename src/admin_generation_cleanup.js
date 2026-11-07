'use strict';

// Admin-only, explicitly confirmed and account-scoped cleanup. Active/uncertain
// source jobs are never touched. Reuse the normal per-media deletion paths so
// wallet history, object storage, and provider receipts follow existing rules.
const {getPool}=require('./db.js');
const {deleteUserGeneration}=require('./generations.js');
const {deleteUserImageGeneration}=require('./image_generations.js');
const {deleteUserVoiceGeneration}=require('./voice_generations.js');

const TERMINAL="('completed','failed','submit_error')";
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});

async function userGenerationCleanupPreview(userId,{db=getPool()}={}){
  if(!Number.isSafeInteger(userId)||userId<1)throw fail(400,'Invalid customer ID.');
  const [users]=await db.execute('SELECT id,email FROM users WHERE id=? LIMIT 1',[userId]);
  if(!users.length)throw fail(404,'Customer not found.');
  const [[counts]]=await db.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ${TERMINAL} THEN 1 ELSE 0 END),0) AS deletable,
       COALESCE(SUM(CASE WHEN status IN ${TERMINAL} THEN 0 ELSE 1 END),0) AS protected
     FROM generations WHERE user_id=?`,[userId]);
  return {userId,email:users[0].email,deletable:Number(counts.deletable),protected:Number(counts.protected)};
}

async function deleteFinishedUserGenerations(userId,confirmEmail,{
  db=getPool(),limit=5,removeVideo=deleteUserGeneration,
  removeImage=deleteUserImageGeneration,removeAudio=deleteUserVoiceGeneration
}={}){
  const preview=await userGenerationCleanupPreview(userId,{db});
  // Require the current exact customer email, not just the id or a partial match.
  if(typeof confirmEmail!=='string'||confirmEmail.trim()!==preview.email)
    throw fail(409,'Type this customer\'s exact email address to confirm deletion.');
  const safeLimit=Math.min(5,Math.max(1,Math.floor(Number(limit)||5)));
  const [rows]=await db.execute(
    `SELECT id,COALESCE(media_type,'video') AS media_type FROM generations
     WHERE user_id=? AND status IN ${TERMINAL}
     ORDER BY created_at,id LIMIT ${safeLimit}`,[userId]);
  let deleted=0;
  let stopped=null;
  for(const row of rows){
    const remove=({video:removeVideo,image:removeImage,audio:removeAudio})[row.media_type];
    if(!remove){stopped='Unsupported generation type. No other records were deleted after this one.';break;}
    try{await remove(userId,row.id);deleted++;}
    catch(error){
      // A concurrent status change, storage error or DB problem must not lead
      // to a broader SQL DELETE, a retry of source work or another user's data.
      stopped='Deletion stopped. Inspect the server Activity log before retrying.';
      break;
    }
  }
  const after=await userGenerationCleanupPreview(userId,{db});
  return {ok:!stopped,deleted,remaining:after.deletable,protected:after.protected,
    userId:after.userId,email:after.email, ...(stopped?{error:stopped}:{})};
}

module.exports={userGenerationCleanupPreview,deleteFinishedUserGenerations};

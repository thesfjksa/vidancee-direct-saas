'use strict';

// Admin-only, explicitly confirmed and account-scoped cleanup. Active/uncertain
// source jobs are never touched. Reuse the normal per-media deletion paths so
// wallet history, object storage, and provider receipts follow existing rules.
const {getPool}=require('./db.js');
const { BACKEND_PAYMENT_FAILURE, VGENV_BALANCE_REJECTION } = require('./provider_errors.js');
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
  if(typeof confirmEmail!=='string'||confirmEmail!==preview.email)
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

// Old vgenv rows have a generic error. Require the exact originating worker
// rejection on the same generation and customer, with no provider job created.
const paymentFailureFilter = `
  g.status IN ('failed','submit_error')
  AND g.refunded_at IS NOT NULL
  AND g.media_type IN ('video','image','audio')
  AND (g.output_url IS NULL OR g.output_url='')
  AND (
    g.error_message = ?
    OR (g.provider='vgenv' AND g.media_type='video' AND g.status='submit_error'
      AND (g.provider_job_id IS NULL OR g.provider_job_id='')
      AND g.error_message='Generation could not be submitted. Credits were refunded.'
      AND EXISTS (
        SELECT 1 FROM activity_log a
        WHERE a.generation_id=g.id AND a.user_id=g.user_id AND a.provider=g.provider
          AND a.category='provider' AND a.event='job.submit_failed' AND a.level='error'
          AND a.message=?
      ))
  )`;
const paymentFailureArgs = [BACKEND_PAYMENT_FAILURE, VGENV_BALANCE_REJECTION];
const standalone = 'NOT EXISTS (SELECT 1 FROM story_steps s WHERE s.generation_id=g.id)';
const batchSize = 5;
const confirmation = 'DELETE BACKEND PAYMENT FAILURES';

async function previewBackendPaymentCleanup({ db = getPool() } = {}) {
  const [rows] = await db.execute(
    `SELECT g.id, g.provider, ${standalone} AS deletable
     FROM generations g WHERE ${paymentFailureFilter}
     ORDER BY g.created_at, g.id`, paymentFailureArgs);
  const candidates = rows.filter(row => Number(row.deletable) === 1);
  return {
    ids: candidates.map(row => row.id),
    providers: Object.fromEntries(
      [...new Set(candidates.map(row => row.provider))].map(provider =>
        [provider, candidates.filter(row => row.provider === provider).length])),
    storyLinked: rows.length - candidates.length,
    batchSize,
    confirmation,
  };
}

async function deleteBackendPaymentFailures(ids, confirm, {
  db = getPool(), removeVideo = deleteUserGeneration,
  removeImage = deleteUserImageGeneration, removeAudio = deleteUserVoiceGeneration,
} = {}) {
  if (confirm !== confirmation) throw fail(409, 'Confirm the backend payment failure cleanup.');
  if (!Array.isArray(ids) || !ids.length || ids.length > batchSize ||
      new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) {
    throw fail(400, 'Provide up to five unique generation IDs from the cleanup preview.');
  }
  const [rows] = await db.execute(
    `SELECT g.id,g.user_id,g.media_type FROM generations g
     WHERE g.id IN (${ids.map(() => '?').join(',')})
     AND ${paymentFailureFilter} AND ${standalone}`, [...ids, ...paymentFailureArgs]);
  const byId = new Map(rows.map(row => [row.id, row]));
  const removed = [];
  const skipped = [];
  const removers = { video: removeVideo, image: removeImage, audio: removeAudio };
  // The media remover holds the generation row lock while it calls this check.
  async function verify(conn, id) {
    const [[match]] = await conn.execute(
      `SELECT g.id FROM generations g WHERE g.id=?
       AND ${paymentFailureFilter} AND ${standalone}`, [id, ...paymentFailureArgs]);
    if (!match) throw fail(409, 'Generation is no longer eligible for cleanup.');
  }

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      skipped.push(id);
      continue;
    }
    try {
      await removers[row.media_type](Number(row.user_id), id, { verify });
      removed.push(id);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 409) {
        skipped.push(id);
        continue;
      }
      console.error('Backend payment cleanup failed for', id, error);
      return { removed, skipped, stopped: true };
    }
  }
  return { removed, skipped, stopped: false };
}

module.exports = {
  userGenerationCleanupPreview, deleteFinishedUserGenerations,
  previewBackendPaymentCleanup, deleteBackendPaymentFailures,
};

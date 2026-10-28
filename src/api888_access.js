'use strict';

// Runs after settings initialization in both web and worker. The row lock
// serializes deployments; the transaction makes the reset and marker atomic.
async function disableApi888ForUsersOnce(db) {
  const conn=await db.getConnection();
  const key='api888_customer_opt_in_v1';
  try {
    await conn.beginTransaction();
    await conn.execute('INSERT IGNORE INTO app_settings (setting_key,setting_value,is_secret) VALUES (?, ?, 0)',[key,'pending']);
    const [[row]]=await conn.execute('SELECT setting_value FROM app_settings WHERE setting_key=? FOR UPDATE',[key]);
    if(row.setting_value==='done'){await conn.commit();return false;}
    await conn.execute("UPDATE user_provider_access SET enabled=0,updated_at=UTC_TIMESTAMP() WHERE provider='api888'");
    await conn.execute("INSERT INTO app_settings (setting_key,setting_value,is_secret) VALUES ('api888_enabled','false',0) ON DUPLICATE KEY UPDATE setting_value='false',updated_at=UTC_TIMESTAMP()");
    await conn.execute('UPDATE app_settings SET setting_value=? WHERE setting_key=?',['done',key]);
    await conn.commit();
    return true;
  } catch(error){await conn.rollback();throw error;}
  finally {conn.release();}
}
// Owner-approved on 25 Oct 2026: these models start enabled without Admin
// opt-in. Runs once, so a later Admin switch-off is respected.
// v2 (same day): the owner kept only the models 888API is offered for. The
// marker lists the models already switched on, so a model added to the
// offer later is switched on once too.
const {OFFERED_API888_MODELS}=require('./api888_models.js');
const DEFAULT_ON_MODELS=OFFERED_API888_MODELS;
const V2_FIRST_MODELS=['seedance-2.5-g5-v2','seedance2.5-301010-wool','seedance2.0-933','wan3.0-video-prime'];
async function enableDefaultApi888ModelsOnce(db) {
  const conn=await db.getConnection();
  const key='api888_default_on_models_v2';
  try {
    await conn.beginTransaction();
    await conn.execute('INSERT IGNORE INTO app_settings (setting_key,setting_value,is_secret) VALUES (?, ?, 0)',[key,'pending']);
    const [[row]]=await conn.execute('SELECT setting_value FROM app_settings WHERE setting_key=? FOR UPDATE',[key]);
    let done=[];
    if(row.setting_value==='done')done=V2_FIRST_MODELS;
    else try{done=JSON.parse(row.setting_value);if(!Array.isArray(done))done=[];}catch{done=[];}
    const todo=DEFAULT_ON_MODELS.filter(id=>!done.includes(id));
    if(!todo.length){await conn.commit();return false;}
    await conn.execute("UPDATE provider_models SET enabled=1,updated_at=UTC_TIMESTAMP() WHERE provider='api888' AND provider_model_id IN ("+todo.map(()=>'?').join(',')+")",todo);
    await conn.execute('UPDATE app_settings SET setting_value=? WHERE setting_key=?',[JSON.stringify([...done,...todo]),key]);
    await conn.commit();
    return true;
  } catch(error){await conn.rollback();throw error;}
  finally {conn.release();}
}
// Owner's requests (28 Oct 2026): Seedance 2.5 Full HD and Full Spec were not
// finishing at 888API, so their open jobs are cancelled and refunded once.
async function cancelOpenJobsOnce(db,publicModelId,key,refund=require('./generations.js').refundGeneration){
  const {getSettingValue,setSettingValue}=require('./settings.js');
  if(await getSettingValue(key,''))return 0;
  await setSettingValue(key,new Date().toISOString());
  const [rows]=await db.execute("SELECT id FROM generations WHERE model=? AND refunded_at IS NULL AND status IN ('queued','submitting','submitted','processing')",[publicModelId]);
  for(const row of rows)await refund(row.id,'failed','Cancelled: model under maintenance. Credits were refunded.',null);
  return rows.length;
}
const cancelFullHdJobsOnce=(db,refund)=>cancelOpenJobsOnce(db,'api888_seedance2_5_930_1080p','api888_full_hd_cancelled_v1',refund);
const cancelFullSpecJobsOnce=(db,refund)=>cancelOpenJobsOnce(db,'api888_ss_2_5_720p_v3','api888_full_spec_cancelled_v1',refund);
module.exports={disableApi888ForUsersOnce,enableDefaultApi888ModelsOnce,cancelFullHdJobsOnce,cancelFullSpecJobsOnce,DEFAULT_ON_MODELS};

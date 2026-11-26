'use strict';

// Owner-approved default-on rollout. Both web and worker can initialize the
// shared database: the locked marker and changes commit together. Later
// Admin switch-offs remain respected; no changes to credentials or charge gates.
async function enablePureamForEveryoneOnce(db){
  const conn=await db.getConnection();
  const key='puream_all_models_all_customers_20261126';
  try{
    await conn.beginTransaction();
    await conn.execute('INSERT IGNORE INTO app_settings (setting_key,setting_value,is_secret) VALUES (?, ?, 0)',[key,'pending']);
    const [[row]]=await conn.execute('SELECT setting_value FROM app_settings WHERE setting_key=? FOR UPDATE',[key]);
    if(row.setting_value==='done'){await conn.commit();return false;}
    await conn.execute("DELETE FROM user_provider_access WHERE provider='puream' AND enabled=0");
    // Also re-enable previously imported but currently unavailable variants;
    // availability and readiness checks still exclude them until they return.
    await conn.execute("UPDATE provider_models SET enabled=1,updated_at=UTC_TIMESTAMP() WHERE provider='puream'");
    await conn.execute("INSERT INTO app_settings (setting_key,setting_value,is_secret) VALUES ('puream_enabled','true',0),('puream_models_visible','true',0) ON DUPLICATE KEY UPDATE setting_value='true',is_secret=0,updated_at=UTC_TIMESTAMP()");
    await conn.execute('UPDATE app_settings SET setting_value=? WHERE setting_key=?',['done',key]);
    await conn.commit();
    return true;
  }catch(error){await conn.rollback();throw error;}
  finally{conn.release();}
}
module.exports={enablePureamForEveryoneOnce};

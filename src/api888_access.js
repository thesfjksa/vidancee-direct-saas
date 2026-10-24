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
module.exports={disableApi888ForUsersOnce};

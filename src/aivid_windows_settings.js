'use strict';

// Windows Premium Studio settings are managed EXCLUSIVELY through Admin.
// Stored in app_settings in MySQL; no Hostinger environment variables.
const {getSettingValue,setSettingValue}=require('./settings.js');
const {getPool}=require('./db.js');
const KEY='aivid_windows_studio_admin_v1';
const MAX_USERS=3;
const DEFAULT=Object.freeze({enabled:false,allowedIds:[],allowedEmails:[],directBillingAcknowledged:false});
const emailRe=/^[a-z0-9][a-z0-9._%+-]{0,62}@[a-z0-9.-]+\.[a-z]{2,63}$/i;
const idRe=/^[1-9][0-9]{0,14}$/;
const bad=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode,studioSafe:true});
function normalized(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))throw bad('Invalid Windows Studio configuration.');
  if(typeof value.enabled!=='boolean'||typeof value.directBillingAcknowledged!=='boolean'||
    !Array.isArray(value.allowedIds)||!Array.isArray(value.allowedEmails))
    throw bad('Enable, billing acknowledgment, and approved users must be provided.');
  if(value.allowedIds.length+value.allowedEmails.length>MAX_USERS)
    throw bad('Allow at most three individually trusted accounts for the Windows Studio.');
  const allowedIds=[...new Set(value.allowedIds.map(x=>String(x).trim()))];
  const allowedEmails=[...new Set(value.allowedEmails.map(x=>String(x).trim().toLowerCase()))];
  if(allowedIds.some(x=>!idRe.test(x)||!Number.isSafeInteger(Number(x)))||
    allowedEmails.some(x=>x.length>190||!emailRe.test(x)))
    throw bad('Enter valid CMMTools customer IDs and login email addresses.');
  if(allowedIds.length+allowedEmails.length>MAX_USERS)
    throw bad('Allow at most three individually trusted accounts.');
  if(value.enabled&&(!value.directBillingAcknowledged||!allowedIds.length&&!allowedEmails.length))
    throw bad('To enable Windows Studio, approve a trusted user and acknowledge direct AIVID billing.');
  return {enabled:value.enabled,allowedIds,allowedEmails,directBillingAcknowledged:value.directBillingAcknowledged};
}
async function readConfig(read=getSettingValue){
  const raw=await read(KEY,'');
  if(!raw)return {...DEFAULT,allowedIds:[],allowedEmails:[]};
  try{return normalized(JSON.parse(raw));}catch{
    // Never turn on an invalid or partially persisted authorization record.
    return {...DEFAULT,allowedIds:[],allowedEmails:[]};
  }
}
async function verifyAccounts(config,db=getPool()){
  for(const id of config.allowedIds){
    const [rows]=await db.execute('SELECT id,status FROM users WHERE id=? LIMIT 1',[Number(id)]);
    if(!rows.length||rows[0].status!=='active')throw bad('Approved CMMTools user #'+id+' does not exist or is disabled.');
  }
  for(const email of config.allowedEmails){
    const [rows]=await db.execute('SELECT id,status FROM users WHERE LOWER(email)=? LIMIT 1',[email]);
    if(!rows.length||rows[0].status!=='active')throw bad('Approved CMMTools login email '+email+' does not exist or is disabled.');
  }
}
async function saveConfig(input,{write=setSettingValue,db=getPool()}={}){
  const config=normalized(input);
  await verifyAccounts(config,db);
  // One atomic row update; next customer request reads fresh, current settings.
  await write(KEY,JSON.stringify(config));
  return config;
}
function enabled(config){return config?.enabled===true;}
function allowed(user,config){
  if(!enabled(config)||!user||!Number.isSafeInteger(Number(user.id))||Number(user.id)<1)return false;
  return config.allowedIds?.includes(String(user.id))||
    Boolean(user.email&&config.allowedEmails?.includes(String(user.email).trim().toLowerCase()));
}
function authorized(user,config){
  if(!allowed(user,config))throw bad('Windows Premium Studio is not enabled for this account.',403);
  if(config.directBillingAcknowledged!==true)
    throw bad('Direct AIVID billing must be acknowledged in Admin before using Windows Studio.',503);
  return true;
}
module.exports={KEY,DEFAULT,MAX_USERS,normalized,readConfig,verifyAccounts,saveConfig,enabled,allowed,authorized};

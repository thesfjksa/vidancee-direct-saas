'use strict';
const {createHash}=require('node:crypto');
const {GROUP}=require('./huiqu_models');
const fingerprint=key=>createHash('sha256').update(key).digest('hex');
const bad=()=>Object.assign(new Error('Invalid video provider group or API key.'),{statusCode:400});
function parseExtra(raw){
 const rows=JSON.parse(raw||'[]');if(!Array.isArray(rows)||rows.length>20)throw bad();
 return rows.map(row=>{
  if(typeof row?.apiKey!=='string'||!row.apiKey||row.apiKey.length>512||/\s/.test(row.apiKey)||typeof row.group!=='string'||!row.group.trim()||row.group.length>120||/[\x00-\x1f]/.test(row.group))throw bad();
  return {apiKey:row.apiKey,group:row.group.trim(),enabled:row.enabled!==false};
 });
}
function credentials(s,{activeOnly=false}={}){
 const rows=[...(s.huiquApiKey?[{apiKey:s.huiquApiKey,group:GROUP,enabled:true}]:[]),...(s.huiquExtraCredentials||[])];
 const map=new Map();for(const row of rows){const id=fingerprint(row.apiKey);if(!map.has(id))map.set(id,{...row,id});}
 return [...map.values()].filter(row=>!activeOnly||row.enabled);
}
function activeCredential(s,id){return credentials(s,{activeOnly:true}).some(row=>row.id===id);}
function summary(s){return credentials(s).map(row=>({id:row.id,group:row.group,enabled:row.enabled,legacy:row.apiKey===s.huiquApiKey}));}
function signature(s){const rows=credentials(s);return rows.length?fingerprint(JSON.stringify(rows.map(r=>[r.id,r.group,r.enabled]))):'';}
module.exports={parseExtra,credentials,activeCredential,summary,signature,fingerprint};

#!/usr/bin/env node
// Read-only AIVID API discovery for an authorized signed-in account.
// No paid operations, CAPTCHA handling, login automation or token logging.
const token=String(process.env.AIVID_SESSION_TOKEN||'').trim();
const jobId=String(process.env.AIVID_JOB_ID||'').trim();
if(!token){console.error('Missing AIVID_SESSION_TOKEN; see docs/AIVID_BRIDGE_RECOVERY.md');process.exit(2);}
if(jobId&&!/^[a-f0-9]{16,40}$/i.test(jobId)){console.error('Invalid AIVID_JOB_ID');process.exit(2);}
const paths=['/v2/generations','/v2/generations?limit=1'];
if(jobId)paths.push('/v2/generations/'+jobId);
function shape(obj){
  if(Array.isArray(obj))return {type:'array',firstKeys:obj[0]&&typeof obj[0]==='object'?Object.keys(obj[0]).slice(0,30):[]};
  if(!obj||typeof obj!=='object')return {type:obj===null?'null':typeof obj};
  const nested={};
  for(const [k,v] of Object.entries(obj)){
    if(!/^(data|items|results|jobs|generations|pagination)$/i.test(k)||!v||typeof v!=='object')continue;
    nested[k]=Array.isArray(v)?{type:'array',firstKeys:v[0]&&typeof v[0]==='object'?Object.keys(v[0]).slice(0,30):[]}:{type:'object',keys:Object.keys(v).slice(0,30)};
  }
  return {type:'object',keys:Object.keys(obj).slice(0,30),nested};
}
for(const path of paths){
  const label=jobId?path.replace(jobId,':id'):path;
  try{
    const r=await fetch('https://api.aivid.dev'+path,{
      method:'GET',headers:{authorization:'Bearer '+token,accept:'application/json'},
      redirect:'manual',signal:AbortSignal.timeout(12000)
    });
    const result={route:label,httpStatus:r.status,contentType:r.headers.get('content-type')||''};
    if(r.ok&&result.contentType.includes('json')){
      const raw=await r.text();
      if(raw.length<2000000){try{result.shape=shape(JSON.parse(raw));}catch{result.format='invalid JSON';}}
      else result.format='oversized JSON';
    }
    if(r.status===401||r.status===403)result.note='Session expired or access denied; do not bypass challenges';
    if(r.status===404)result.note='Route unknown; inspect normal signed-in browser Network read requests';
    // No prompts, media links, IDs, JWTs, cookies or response values are printed.
    console.log(JSON.stringify(result));
    await r.body?.cancel?.().catch(()=>{});
  }catch(e){console.log(JSON.stringify({route:label,error:String(e?.name||'NetworkError')}));}
}
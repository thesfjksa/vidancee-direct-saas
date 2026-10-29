'use strict';
// Website session adapter: login.php + studio.php CSRF, POST generate.php,
// GET jobs.php. Credentials remain encrypted in shared Admin settings.
const { readBounded, checkOutputUrl, VIDEO_LIMIT }=require('./vercel.js');
const { vidanceeCreditsForDuration } = require('../vidancee_models.js');
const ORIGIN='https://vidancee.com';
const UA='CMMTools/1.0 (+https://cmmtools.site)';
const safeId=id=>/^[0-9]{1,20}$/.test(String(id));
const sessionExpired = response => response.status===401 || response.status===403 ||
  ([301,302,303,307,308].includes(response.status) &&
    /login\.php/i.test(String(response.headers.get('location')||'')));
function safeProviderMessage(data){
  const raw=String(data?.error_message||data?.error||data?.message||data?.detail||'').trim();
  // Providers occasionally return raw HTML or detailed request diagnostics.
  // Do not leak credentials, session tokens, or customer images/prompts into logs.
  if(!raw||/[<>\r\n]/.test(raw)||/password|token|secret|cookie|session|csrf/i.test(raw))
    return '';
  return raw.replace(/https?:\/\/\S+/g,'[URL]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/ig,'[email]').slice(0,160);
}
async function jsonReply(response,endpoint){
  let body;
  try{body=await response.json();}
  catch {throw new Error('Vidancee '+endpoint+' returned non-JSON (HTTP '+response.status+'); check provider login/session or upstream access.');}
  if(!body||typeof body!=='object'||Array.isArray(body))
    throw new Error('Vidancee '+endpoint+' returned an invalid response (HTTP '+response.status+').');
  return body;
}

class VidanceeClient {
  constructor({email,password,fetchImpl=fetch}={}){
    this.email=String(email||'');this.password=String(password||'');this.fetch=fetchImpl;
    this.cookie='';this.csrf='';this.loginPromise=null;
  }
  async request(path,options={}){
    const response=await this.fetch(ORIGIN+path,{...options,redirect:'manual',
      signal:AbortSignal.timeout(options.timeoutMs||30000),
      headers:{'user-agent':UA,accept:'application/json,text/html,*/*',
        ...(this.cookie?{cookie:this.cookie}:{}),...options.headers}});
    const cookies=typeof response.headers.getSetCookie==='function'?response.headers.getSetCookie():[response.headers.get('set-cookie')||''];
    for(const c of cookies){const m=String(c).match(/(?:^|[,\s])PHPSESSID=([^;\s,]+)/);if(m)this.cookie='PHPSESSID='+m[1];}
    return response;
  }
  async login(){
    if(!this.email||!this.password)throw new Error('Save Vidancee login email and password in Admin.');
    const page=await this.request('/login.php');if(!page.ok)throw new Error('Vidancee login page unavailable.');
    const html=await page.text();
    const token=html.match(/name=["']csrf_token["'][^>]*value=["']([^"']+)/i)?.[1]||html.match(/value=["']([^"']+)["'][^>]*name=["']csrf_token/i)?.[1];
    if(!token)throw new Error('Vidancee login CSRF missing.');
    const form=new URLSearchParams({email:this.email,password:this.password,csrf_token:token});
    const post=await this.request('/login.php',{method:'POST',body:form,headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN,referer:ORIGIN+'/login.php'}});
    if(![301,302,303].includes(post.status)||!String(post.headers.get('location')||'').includes('studio.php')||!this.cookie)throw new Error('Vidancee login failed.');
    const studio=await this.request('/studio.php',{headers:{accept:'text/html'}});
    const sh=await studio.text();this.csrf=sh.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)/i)?.[1]||sh.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token/i)?.[1];
    if(!studio.ok||!this.csrf)throw new Error('Vidancee studio CSRF unavailable.');
  }
  async auth(){if(!this.csrf){if(!this.loginPromise)this.loginPromise=this.login().finally(()=>{this.loginPromise=null;});await this.loginPromise;}}
  async getJobs(limit=100){
    await this.auth();
    const path='/api/jobs.php?limit='+Math.min(100,Math.max(1,Number(limit)||100))+'&status=finished&with_active=1';
    let r=await this.request(path);
    // GET is read-only: a refreshed session can safely retry it once.
    // Never apply this retry logic to the paid POST /api/generate.php.
    if(sessionExpired(r)){
      this.csrf='';this.cookie='';
      await this.auth();
      r=await this.request(path);
    }
    if(sessionExpired(r))throw new Error('Vidancee job polling rejected the session (HTTP '+r.status+').');
    if(!r.ok)throw new Error('Vidancee job polling failed (HTTP '+r.status+').');
    const data=await jsonReply(r,'jobs.php');
    if(data.ok!==true||!Array.isArray(data.jobs))
      throw new Error('Vidancee jobs.php rejected the request'+(safeProviderMessage(data)?': '+safeProviderMessage(data):'.'));
    return data;
  }
  async startVideo(model,params,references=[]){
    // Captured Vidancee job 26443 confirms image-reference mode for Omni Flash.
    // Historical Vidancee browser request contract sends binary images[].
    if(references.length>1)throw new Error('Omni Flash accepts one reference image in CMMTools.');
    const duration = Number(params.duration);
    const providerCredits = vidanceeCreditsForDuration(duration);
    if(params.aspectRatio!=='9:16')throw new Error('Unsupported Omni Flash aspect ratio.');
    const ref=references[0]||null;
    if(ref){
      const mime=String(ref.mimeType||'').toLowerCase();
      if(ref.role && ref.role!=='image_references')throw new Error('Unsupported Omni Flash image reference role.');
      if(!['image/jpeg','image/png','image/webp'].includes(mime)||!Buffer.isBuffer(ref.data)||!ref.data.length||ref.data.length>10*1024*1024)
        throw new Error('Omni Flash needs a JPEG, PNG or WebP reference image under 10 MB.');
    }
    await this.auth();
    const form=new FormData();
    for(const [k,v] of Object.entries({mode:ref?'image-to-video':'text-to-video',model:'Omni-Flash',duration:String(duration),aspect_ratio:'9:16',prompt:String(params.prompt||''),quantity:'1'}))form.append(k,v);
    if(ref){
      // Vidancee accepts the binary reference in multipart images[]; do not send
      // a CMMTools signed link, which the provider may not be able to fetch.
      const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[ref.mimeType];
      form.append('images[]',new Blob([ref.data],{type:ref.mimeType}),ref.filename||('reference.'+ext));
      form.append('max_retries','0'); // confirmed successful Vidancee Omni-Flash image reference request
    }
    const r=await this.request('/api/generate.php',{method:'POST',timeoutMs:120000,body:form,
      headers:{'x-csrf-token':this.csrf,origin:ORIGIN,referer:ORIGIN+'/studio.php'}});
    // Never automatically resend a potentially billed POST, including after
    // session expiry or non-JSON responses: a response loss might still be billed.
    if(sessionExpired(r))throw new Error('Vidancee rejected the generation session (HTTP '+r.status+'). Check Vidancee login in Admin; paid request not retried.');
    if(!r.ok)throw new Error('Vidancee submission rejected (HTTP '+r.status+').');
    const data=await jsonReply(r,'generate.php');
    if(data.ok!==true){
      const detail=safeProviderMessage(data);
      throw new Error('Vidancee rejected the generation'+(detail?': '+detail:'.'));
    }
    const id=data.job_ids?.[0]??data.job_id;
    if(!safeId(id))throw new Error('Vidancee accepted the request but did not confirm a usable job ID. Check provider history before retrying.');
    return {requestId:String(id),providerCredits};
  }
  async videoStatus(op){
    if(!safeId(op?.requestId))throw new Error('Invalid Vidancee job ID.');
    const jobs=await this.getJobs(100);
    const job=jobs.jobs.find(j=>String(j.id)===String(op.requestId));
    if(!job)return {status:'pending'};
    const st=String(job.status||'').toLowerCase();
    if(st==='completed'){
      if(!job.output_url)return {status:'failed',error:'No video output received.'};
      return {status:'done',url:new URL(String(job.output_url),ORIGIN+'/').toString()};
    }
    if(['failed','error','cancelled'].includes(st))return {status:'failed',error:String(job.error_message||'Generation failed.')};
    return {status:'pending'};
  }
  async download(url){
    const target=new URL(checkOutputUrl(url));
    if(target.origin!==ORIGIN)throw new Error('Vidancee output must use its verified host.');
    await this.auth();
    const path=target.pathname+target.search;
    let r=await this.request(path,{timeoutMs:180000,headers:{accept:'video/mp4'}});
    if(sessionExpired(r)){
      // A video GET is read-only and safe to repeat after session renewal.
      this.csrf='';this.cookie='';
      await this.auth();
      r=await this.request(path,{timeoutMs:180000,headers:{accept:'video/mp4'}});
    }
    if(sessionExpired(r))throw new Error('Vidancee download rejected the session (HTTP '+r.status+').');
    if(!r.ok)throw new Error('Vidancee video download failed (HTTP '+r.status+').');
    const data=await readBounded(r,VIDEO_LIMIT);
    if(data.toString('ascii',4,8)!=='ftyp')throw new Error('Vidancee did not return MP4 video.');
    return {data,mimeType:'video/mp4'};
  }
}
module.exports={VidanceeClient};

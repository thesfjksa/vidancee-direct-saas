'use strict';
// S3-compatible object storage (Cloudflare R2 first; Backblaze B2, Wasabi and
// AWS S3 work the same). Objects stay private: customers get short-lived
// presigned links after CMM Tools has checked ownership. No SDK dependency;
// requests are signed with AWS Signature Version 4.
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {getSettingValue,setSettingValue}=require('./settings.js');

const MARKER='r2:';
const SETTINGS={endpoint:'r2_endpoint',bucket:'r2_bucket',accessKeyId:'r2_access_key_id',
  secretAccessKey:'r2_secret_access_key',enabled:'r2_enabled',migration:'r2_migration_enabled'};
const PRESIGN_SECONDS=3600;

const sha256=data=>crypto.createHash('sha256').update(data).digest('hex');
const hmac=(key,data)=>crypto.createHmac('sha256',key).update(data).digest();
const rfc3986=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const encodeKey=key=>String(key).split('/').map(rfc3986).join('/');
const keyFromMarker=marker=>String(marker||'').startsWith(MARKER)?String(marker).slice(MARKER.length):null;

function storageError(message,status,extra={}){
  return Object.assign(new Error(message),{statusCode:502,storageStatus:status||null,...extra});
}

function validateConfig({endpoint,bucket,accessKeyId,secretAccessKey}){
  let url;
  try{url=new URL(String(endpoint||'').trim());}catch{throw new Error('Enter the S3 endpoint URL, for example https://<account-id>.r2.cloudflarestorage.com.');}
  if(url.protocol!=='https:'||url.pathname.replace(/\/+$/,'')||url.search)
    throw new Error('The endpoint must be an https:// address without a path, for example https://<account-id>.r2.cloudflarestorage.com.');
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(bucket||'')))
    throw new Error('Enter the bucket name exactly as created (lowercase letters, numbers, dots and hyphens).');
  if(!/^[A-Za-z0-9]{16,128}$/.test(String(accessKeyId||'')))throw new Error('Enter the Access Key ID from the API token.');
  if(String(secretAccessKey||'').length<20)throw new Error('Enter the Secret Access Key from the API token.');
  return {endpoint:url.origin,bucket:String(bucket),accessKeyId:String(accessKeyId),secretAccessKey:String(secretAccessKey)};
}

class ObjectStore{
  constructor({endpoint,bucket,accessKeyId,secretAccessKey,region='auto',fetchImpl=fetch,now=()=>new Date()}){
    const url=new URL(endpoint);
    Object.assign(this,{origin:url.origin,host:url.host,bucket,accessKeyId,secretAccessKey,region,fetch:fetchImpl,now});
  }
  path(key){return '/'+rfc3986(this.bucket)+'/'+encodeKey(key);}
  scope(date){return date+'/'+this.region+'/s3/aws4_request';}
  signature(date,stringToSign){
    const kDate=hmac('AWS4'+this.secretAccessKey,date),kRegion=hmac(kDate,this.region);
    return hmac(hmac(hmac(kRegion,'s3'),'aws4_request'),stringToSign).toString('hex');
  }
  canonical(method,path,query,headers,payloadHash){
    const names=Object.keys(headers).map(h=>h.toLowerCase()).sort();
    const lower=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v).trim()]));
    const q=Object.keys(query).sort().map(k=>rfc3986(k)+'='+rfc3986(query[k])).join('&');
    return {signedHeaders:names.join(';'),query:q,
      request:[method,path,q,names.map(n=>n+':'+lower[n]+'\n').join(''),names.join(';'),payloadHash].join('\n')};
  }
  stamp(){
    const amzDate=this.now().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
    return {amzDate,date:amzDate.slice(0,8)};
  }
  // Header-signed request for PUT/GET/HEAD/DELETE.
  async request(method,key,{body=null,headers={},query={}}={}){
    const {amzDate,date}=this.stamp(),path=this.path(key);
    const payloadHash=body?sha256(body):sha256('');
    const signed={host:this.host,'x-amz-content-sha256':payloadHash,'x-amz-date':amzDate,...headers};
    const c=this.canonical(method,path,query,signed,payloadHash);
    const sts=['AWS4-HMAC-SHA256',amzDate,this.scope(date),sha256(c.request)].join('\n');
    const authorization='AWS4-HMAC-SHA256 Credential='+this.accessKeyId+'/'+this.scope(date)+
      ', SignedHeaders='+c.signedHeaders+', Signature='+this.signature(date,sts);
    const {host,...sent}=signed;
    let response;
    try{
      response=await this.fetch(this.origin+path+(c.query?'?'+c.query:''),{method,body:body||undefined,
        headers:{...sent,authorization},redirect:'error',signal:AbortSignal.timeout(method==='PUT'?300000:60000)});
    }catch(error){throw storageError('Could not connect to cloud storage.',null,{code:error.name});}
    return response;
  }
  presign(key,{expires=PRESIGN_SECONDS,contentType=null,disposition=null}={}){
    const {amzDate,date}=this.stamp(),path=this.path(key);
    const query={'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':this.accessKeyId+'/'+this.scope(date),
      'X-Amz-Date':amzDate,'X-Amz-Expires':String(expires),'X-Amz-SignedHeaders':'host'};
    if(contentType)query['response-content-type']=contentType;
    if(disposition)query['response-content-disposition']=disposition;
    const c=this.canonical('GET',path,query,{host:this.host},'UNSIGNED-PAYLOAD');
    const sts=['AWS4-HMAC-SHA256',amzDate,this.scope(date),sha256(c.request)].join('\n');
    return this.origin+path+'?'+c.query+'&X-Amz-Signature='+this.signature(date,sts);
  }
  async put(key,data,contentType){
    const md5=crypto.createHash('md5').update(data).digest();
    const response=await this.request('PUT',key,{body:data,headers:{'content-type':contentType,
      'content-md5':md5.toString('base64')}});
    await response.body?.cancel?.().catch(()=>{});
    if(!response.ok)throw storageError('Cloud storage rejected the upload (HTTP '+response.status+').',response.status);
    // Single-part uploads return the MD5 as ETag; R2, S3, B2 and Wasabi all do.
    const etag=String(response.headers.get('etag')||'').replace(/"/g,'');
    if(etag&&etag!==md5.toString('hex'))throw storageError('Cloud storage checksum did not match the upload.',response.status);
    return {key,md5:md5.toString('hex'),size:data.length};
  }
  async head(key){
    const response=await this.request('HEAD',key);
    await response.body?.cancel?.().catch(()=>{});
    if(response.status===404)return null;
    if(!response.ok)throw storageError('Cloud storage metadata request failed (HTTP '+response.status+').',response.status);
    return {size:Number(response.headers.get('content-length')),etag:String(response.headers.get('etag')||'').replace(/"/g,''),
      contentType:response.headers.get('content-type')||''};
  }
  async get(key,{range=null}={}){
    const response=await this.request('GET',key,{headers:range?{range}:{}});
    if(![200,206].includes(response.status)){
      await response.body?.cancel?.().catch(()=>{});
      throw storageError('Cloud storage download failed (HTTP '+response.status+').',response.status);
    }
    return response;
  }
  async remove(key){
    const response=await this.request('DELETE',key);
    await response.body?.cancel?.().catch(()=>{});
    if(!response.ok&&response.status!==404)throw storageError('Cloud storage delete failed (HTTP '+response.status+').',response.status);
  }
  // Writes, reads and deletes a tiny private object to prove the token works.
  async check(){
    const key='.cmm-tools-check/'+crypto.randomUUID()+'.txt',data=Buffer.from('ok');
    await this.put(key,data,'text/plain');
    const meta=await this.head(key);
    if(!meta||meta.size!==data.length)throw storageError('Cloud storage did not return the test file.');
    await this.remove(key);
    return true;
  }
  // Streams an object through CMM Tools (for providers that fetch signed
  // CMM links), forwarding byte ranges.
  async stream(key,req,res,{contentType='video/mp4'}={}){
    const response=await this.get(key,{range:req.headers.range||null});
    const headers={'content-type':contentType,'accept-ranges':'bytes','cache-control':'private, max-age=3600','x-content-type-options':'nosniff'};
    for(const name of ['content-length','content-range'])if(response.headers.get(name))headers[name]=response.headers.get(name);
    res.writeHead(response.status,headers);
    if(req.method==='HEAD'){await response.body?.cancel?.().catch(()=>{});return res.end();}
    await new Promise((resolve,reject)=>{
      const body=Readable.fromWeb(response.body);
      body.on('error',reject);res.on('close',resolve);res.on('finish',resolve);
      body.pipe(res);
    }).catch(()=>res.destroy());
  }
}

async function storageConfiguration({getSetting=getSettingValue}={}){
  const values={};
  for(const [name,key] of Object.entries(SETTINGS))values[name]=await getSetting(key,'');
  const configured=Boolean(values.endpoint&&values.bucket&&values.accessKeyId&&values.secretAccessKey);
  return {configured,enabled:configured&&values.enabled==='true',migrationEnabled:values.migration==='true',
    endpoint:values.endpoint,bucket:values.bucket,accessKeyId:values.accessKeyId,secretAccessKey:values.secretAccessKey};
}

// requireEnabled=false still reads existing objects after new uploads are
// switched off, so saved files never become unplayable.
async function configuredStorage({requireEnabled=true,getSetting=null,fetchImpl=fetch}={}){
  // Like Drive: processes without MySQL (unit tests, fresh installs) keep the
  // local storage behaviour.
  if(!getSetting){
    if(requireEnabled&&!require('./db.js').dbConfigured())return null;
    getSetting=getSettingValue;
  }
  const cfg=await storageConfiguration({getSetting});
  if(!cfg.configured||(requireEnabled&&!cfg.enabled))return null;
  return new ObjectStore({...cfg,fetchImpl});
}

async function saveStorageSettings(input,{setSetting=setSettingValue,fetchImpl=fetch}={}){
  const cfg=validateConfig(input);
  await new ObjectStore({...cfg,fetchImpl}).check();
  await setSetting(SETTINGS.endpoint,cfg.endpoint);
  await setSetting(SETTINGS.bucket,cfg.bucket);
  await setSetting(SETTINGS.accessKeyId,cfg.accessKeyId);
  await setSetting(SETTINGS.secretAccessKey,cfg.secretAccessKey,{secret:true});
  await setSetting(SETTINGS.enabled,'true');
  await setSetting(SETTINGS.migration,'true');
  return cfg;
}

// Redirects the browser to a short-lived private link for an object.
function redirectToObject(store,key,res,{contentType,filename,download=false}){
  const disposition=(download?'attachment':'inline')+(filename?'; filename="'+filename.replace(/[^\w.-]/g,'_')+'"':'');
  res.writeHead(302,{location:store.presign(key,{contentType,disposition}),'cache-control':'private, no-store','referrer-policy':'no-referrer'});
  res.end();
}

const videoKey=id=>'videos/'+id+'.mp4';

module.exports={MARKER,SETTINGS,ObjectStore,validateConfig,storageConfiguration,configuredStorage,saveStorageSettings,
  redirectToObject,keyFromMarker,videoKey,encodeKey};

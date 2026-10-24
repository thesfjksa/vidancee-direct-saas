'use strict';
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {getSettingValue}=require('./settings.js');
const {dbConfigured}=require('./db.js');

const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.file';
const DRIVE_ORIGIN='https://www.googleapis.com';
const UPLOAD_ORIGIN='https://www.googleapis.com';
const CHUNK=4*1024*1024;
const FILE_ID=/^[a-zA-Z0-9_-]{10,200}$/;
const GEN_ID=/^[0-9a-f-]{36}$/i;
const tokenCache=new Map();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function oauthConfig(){
  const clientId=String(process.env.GOOGLE_DRIVE_CLIENT_ID||'').trim();
  const clientSecret=String(process.env.GOOGLE_DRIVE_CLIENT_SECRET||'').trim();
  const redirectUri=String(process.env.GOOGLE_DRIVE_REDIRECT_URI||'https://cmmtools.site/admin/google-drive/callback').trim();
  if(!clientId||!clientSecret||!redirectUri.startsWith('https://'))
    throw new Error('Configure GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and an HTTPS redirect URI in Hostinger.');
  return {clientId,clientSecret,redirectUri};
}
function authUrl(state){
  const cfg=oauthConfig();
  const p=new URLSearchParams({client_id:cfg.clientId,redirect_uri:cfg.redirectUri,
    response_type:'code',scope:DRIVE_SCOPE,access_type:'offline',prompt:'consent',state});
  return 'https://accounts.google.com/o/oauth2/v2/auth?'+p;
}
async function exchangeCode(code,{fetchImpl=fetch}={}){
  const cfg=oauthConfig();
  const response=await fetchImpl('https://oauth2.googleapis.com/token',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.clientSecret,
      code,grant_type:'authorization_code',redirect_uri:cfg.redirectUri}).toString(),
    signal:AbortSignal.timeout(30000),
  });
  if(!response.ok)throw new Error('Google authorization code exchange failed (HTTP '+response.status+').');
  const result=await response.json();
  if(!result.refresh_token)throw new Error('Google did not provide offline access. Reauthorize with the consent screen.');
  return result.refresh_token;
}
function driveIdFromMarker(outputUrl){
  const v=String(outputUrl||'');
  const id=v.startsWith('gdrive:')?v.slice(7):'';
  return FILE_ID.test(id)?id:null;
}
async function driveConfiguration(){
  const enabled=await getSettingValue('gdrive_enabled','false')==='true';
  const folderId=await getSettingValue('gdrive_folder_id','');
  const refreshToken=await getSettingValue('gdrive_refresh_token','');
  return {enabled,folderId,refreshToken,connected:Boolean(refreshToken&&FILE_ID.test(folderId))};
}
class GoogleDriveStore{
  constructor({clientId,clientSecret,refreshToken,folderId='',fetchImpl=fetch}={}){
    this.clientId=clientId||process.env.GOOGLE_DRIVE_CLIENT_ID||'';
    this.clientSecret=clientSecret||process.env.GOOGLE_DRIVE_CLIENT_SECRET||'';
    this.refreshToken=refreshToken||'';
    this.folderId=folderId||'';
    this.fetch=fetchImpl;
    if(!this.clientId||!this.clientSecret||!this.refreshToken)
      throw new Error('Google Drive OAuth connection is not configured.');
  }
  async token(){
    const key=crypto.createHash('sha256').update(this.clientId+':'+this.refreshToken).digest('hex');
    const current=tokenCache.get(key);
    if(current?.token&&Date.now()<current.expiresAt-60000)return current.token;
    if(current?.promise)return current.promise;
    const request=(async()=>{
      const response=await this.fetch('https://oauth2.googleapis.com/token',{
        method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,
          refresh_token:this.refreshToken,grant_type:'refresh_token'}).toString(),
        signal:AbortSignal.timeout(30000),
      });
      if(!response.ok)throw new Error('Google Drive refresh token is invalid or has expired (HTTP '+response.status+'). Reconnect in Admin.');
      const data=await response.json();
      if(!data.access_token)throw new Error('Google Drive did not return an access token.');
      tokenCache.set(key,{token:data.access_token,expiresAt:Date.now()+Math.max(300,Number(data.expires_in)||3600)*1000});
      return data.access_token;
    })();
    tokenCache.set(key,{promise:request});
    try{return await request;}
    catch(error){tokenCache.delete(key);throw error;}
  }
  async api(path,{method='GET',body,headers={},timeout=60000}={}){
    const response=await this.fetch(DRIVE_ORIGIN+path,{
      method,headers:{authorization:'Bearer '+await this.token(),accept:'application/json',...headers},
      body,redirect:'error',signal:AbortSignal.timeout(timeout)});
    if(!response.ok){
      await response.body?.cancel?.().catch(()=>{});
      throw Object.assign(new Error('Google Drive API '+method+' failed (HTTP '+response.status+').'),{statusCode:502,driveStatus:response.status});
    }
    return response.status===204?{}:response.json();
  }
  async createFolder(){
    const f=await this.api('/drive/v3/files?fields=id,name,mimeType',{method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({name:'CMM Tools Videos',mimeType:'application/vnd.google-apps.folder'})});
    if(!FILE_ID.test(String(f.id||'')))throw new Error('Google Drive did not return a folder ID.');
    this.folderId=f.id;
    return f.id;
  }
  async metadata(fileId){
    if(!FILE_ID.test(String(fileId)))throw new Error('Invalid Google Drive file ID.');
    return this.api('/drive/v3/files/'+encodeURIComponent(fileId)+'?fields=id,size,md5Checksum,mimeType,parents,trashed,appProperties');
  }
  async deleteFile(fileId){
    if(!FILE_ID.test(String(fileId)))throw new Error('Invalid Google Drive file ID.');
    return this.api('/drive/v3/files/'+encodeURIComponent(fileId),{method:'DELETE'});
  }
  async findExisting(id,size,checksum){
    if(!GEN_ID.test(id)||!FILE_ID.test(this.folderId))throw new Error('Google Drive folder is not configured.');
    const q="'"+this.folderId+"' in parents and name = 'cmm-video-"+id+".mp4' and trashed = false";
    const url='/drive/v3/files?'+new URLSearchParams({q,fields:'files(id,size,md5Checksum),nextPageToken',
      pageSize:'100'}).toString();
    const found=await this.api(url);
    for(const file of found.files||[]){
      if(FILE_ID.test(file.id)&&Number(file.size)===size&&(!checksum||file.md5Checksum===checksum))
        return file.id;
    }
    return null;
  }
  async uploadVideo({generationId,size,readChunk,md5Checksum}){
    if(!GEN_ID.test(generationId))throw new Error('Invalid video generation ID.');
    if(!FILE_ID.test(this.folderId))throw new Error('Google Drive folder is not configured.');
    if(!Number.isSafeInteger(size)||size<=0)throw new Error('Invalid video file size.');
    const existing=await this.findExisting(generationId,size,md5Checksum);
    if(existing)return existing;
    const meta={name:'cmm-video-'+generationId+'.mp4',mimeType:'video/mp4',
      parents:[this.folderId],appProperties:{cmmGenerationId:generationId}};
    const url=UPLOAD_ORIGIN+'/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum';
    const start=await this.fetch(url,{method:'POST',headers:{
      authorization:'Bearer '+await this.token(),'content-type':'application/json; charset=UTF-8',
      'x-upload-content-type':'video/mp4','x-upload-content-length':String(size),
    },body:JSON.stringify(meta),redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!start.ok)throw new Error('Google Drive upload session failed (HTTP '+start.status+').');
    const session=start.headers.get('location')||'';
    // Never send a bearer token or video data to arbitrary Location hosts.
    const sessionUrl=new URL(session);
    if(sessionUrl.protocol!=='https:'||sessionUrl.hostname!=='www.googleapis.com'||
       !sessionUrl.pathname.startsWith('/upload/drive/v3/files')||sessionUrl.username||sessionUrl.password)
      throw new Error('Google Drive returned an invalid resumable upload URL.');
    await start.body?.cancel?.().catch(()=>{});
    let offset=0,finished=null;
    let retries=0;
    while(offset<size){
      const length=Math.min(CHUNK,size-offset);
      const block=await readChunk(offset,length);
      if(!Buffer.isBuffer(block)||block.length!==length)throw new Error('MySQL video chunk is incomplete; migration is not safe.');
      let reply;
      try{
        reply=await this.fetch(sessionUrl.toString(),{method:'PUT',
          headers:{'content-length':String(length),'content-range':'bytes '+offset+'-'+(offset+length-1)+'/'+size,
            'content-type':'video/mp4'},body:block,redirect:'error',signal:AbortSignal.timeout(180000)});
      }catch(error){reply=null;}
      if(!reply||[429,500,502,503,504].includes(reply.status)){
        if(++retries>4)throw new Error('Google Drive upload could not resume after network errors.');
        await pause(500*retries);
        const probe=await this.fetch(sessionUrl.toString(),{method:'PUT',
          headers:{'content-range':'bytes */'+size,'content-length':'0'},redirect:'error',
          signal:AbortSignal.timeout(30000)});
        if(probe.status===200||probe.status===201){finished=await probe.json();break;}
        if(probe.status!==308)throw new Error('Google Drive upload session could not be resumed (HTTP '+probe.status+').');
        const m=String(probe.headers.get('range')||'').match(/bytes=0-(\d+)/);
        offset=m?Number(m[1])+1:0;continue;
      }
      retries=0;
      if(reply.status===200||reply.status===201){finished=await reply.json();break;}
      if(reply.status!==308)throw new Error('Google Drive rejected a video chunk (HTTP '+reply.status+').');
      const m=String(reply.headers.get('range')||'').match(/bytes=0-(\d+)/);
      offset=m?Number(m[1])+1:0;
    }
    if(!finished||!FILE_ID.test(String(finished.id||'')))
      throw new Error('Google Drive did not confirm the finished video upload.');
    const verified=await this.metadata(finished.id);
    if(Number(verified.size)!==size||verified.mimeType!=='video/mp4'||
       (md5Checksum&&verified.md5Checksum!==md5Checksum)||
       !Array.isArray(verified.parents)||!verified.parents.includes(this.folderId))
      throw new Error('Google Drive uploaded video failed size, checksum or folder verification; MySQL copy retained.');
    return finished.id;
  }
  async uploadBuffer(id,data){
    if(!Buffer.isBuffer(data))throw new Error('Video must be a buffer.');
    const md5=crypto.createHash('md5').update(data).digest('hex');
    return this.uploadVideo({generationId:id,size:data.length,md5Checksum:md5,
      readChunk:async(offset,length)=>data.subarray(offset,offset+length)});
  }
  async streamVideo(fileId,req,res){
    if(!FILE_ID.test(String(fileId)))throw new Error('Invalid Google Drive file ID.');
    const headers={authorization:'Bearer '+await this.token()};
    if(req.headers.range)headers.range=String(req.headers.range);
    const upstream=await this.fetch(DRIVE_ORIGIN+'/drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media',
      {headers,redirect:'error',signal:AbortSignal.timeout(120000)});
    if(![200,206,416].includes(upstream.status)){
      await upstream.body?.cancel?.().catch(()=>{});
      throw new Error('Google Drive video playback failed (HTTP '+upstream.status+').');
    }
    const h={'content-type':'video/mp4','cache-control':'private, no-store',
      'accept-ranges':'bytes','x-content-type-options':'nosniff'};
    for(const [from,to] of [['content-length','content-length'],['content-range','content-range']]){
      const v=upstream.headers.get(from);if(v)h[to]=v;
    }
    res.writeHead(upstream.status,h);
    if(upstream.status===416||!upstream.body)return res.end();
    const stream=Readable.fromWeb(upstream.body);
    res.on('close',()=>stream.destroy());
    stream.on('error',()=>res.destroy());
    stream.pipe(res);
  }
}
async function configuredDrive({requireEnabled=true}={}){
  // Unit-test and fresh-install processes without a configured MySQL database
  // retain the previous local storage behavior. In production (DB configured),
  // a Drive-enabled state must NEVER silently fall back to MySQL.
  if(requireEnabled&&!dbConfigured())return null;
  const cfg=await driveConfiguration();
  if(requireEnabled&&!cfg.enabled)return null;
  if(!cfg.connected)throw new Error('Connect Google Drive in Admin before saving video output.');
  return new GoogleDriveStore({...oauthConfig(),refreshToken:cfg.refreshToken,folderId:cfg.folderId});
}
module.exports={GoogleDriveStore,configuredDrive,driveConfiguration,driveIdFromMarker,authUrl,exchangeCode,oauthConfig,DRIVE_SCOPE,CHUNK};

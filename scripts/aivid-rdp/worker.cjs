'use strict';
// Stable bootstrap: ordinary selector/native/protocol changes are fetched from
// the paired CMMTools origin. Each job uses one complete verified release.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Transport,loadConfig,saveConfig,readPairingInput}=require('./agent.cjs');
const FILES=['agent.cjs','native.cjs','provider/aivid.js','provider/aivid_uploads.js','provider/browserless.js','aivid_models.js'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function validateManifest(m){
 if(m?.protocol!==1||!/^[a-f0-9]{64}$/.test(m.version)||!Array.isArray(m.files)||m.files.length!==FILES.length)throw Error('Invalid worker release.');
 if(new Set(m.files.map(f=>f.path)).size!==FILES.length)throw Error('Duplicate worker files.');
 for(const f of m.files)if(!FILES.includes(f.path)||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>512*1024)throw Error('Invalid worker file.');
 if(hash(JSON.stringify({protocol:1,files:m.files}))!==m.version)throw Error('Worker release identity mismatch.');
 return m;
}
async function verify(root,m){for(const f of m.files){const b=await fs.readFile(path.join(root,f.path));if(b.length!==f.bytes||hash(b)!==f.sha256)throw Error('Worker integrity check failed.');}}
async function install(root,transport){
 const m=validateManifest(await transport.request('/runtime',{method:'GET'})),base=path.join(root,'.aivid-runtime'),target=path.join(base,m.version);
 try{await verify(target,m);return{target,version:m.version}}catch{}
 const staging=target+'.'+crypto.randomUUID()+'.tmp';await fs.mkdir(staging,{recursive:true});
 try{
  for(const f of m.files){const b=await transport.request('/runtime/file?version='+m.version+'&path='+encodeURIComponent(f.path),{method:'GET',binary:true});if(b.length!==f.bytes||hash(b)!==f.sha256)throw Error('Worker integrity check failed.');await fs.mkdir(path.dirname(path.join(staging,f.path)),{recursive:true});await fs.writeFile(path.join(staging,f.path),b,{flag:'wx'});}
  await verify(staging,m);await fs.rm(target,{recursive:true,force:true});await fs.rename(staging,target);return{target,version:m.version};
 }finally{await fs.rm(staging,{recursive:true,force:true});}
}
async function main(){
 const root=__dirname;let config;
 if(process.env.AIVID_PAIRING_STDIN==='1'){
  const p=await readPairingInput(),paired=await new Transport(p.origin).request('/pair',{body:{code:p.code}});
  config={origin:p.origin,token:paired.token};await saveConfig(root,config);
 }else config=await loadConfig(root);
 const transport=new Transport(config.origin,config.token);
 for(;;){
  // Failed/unauthorized releases never execute partially downloaded code.
  let release;try{release=await install(root,transport)}catch(e){if(e.statusCode===401)throw e;console.log('Waiting for a verified server worker release…');await new Promise(r=>setTimeout(r,30000));continue;}
  const {target,version}=release;
  const code=await new Promise((resolve,reject)=>{const env={...process.env,AIVID_AGENT_ROOT:root,AIVID_RUNTIME_VERSION:version};delete env.AIVID_PAIRING_STDIN;const child=spawn(process.execPath,[path.join(target,'agent.cjs')],{cwd:root,env,stdio:'inherit',shell:false});child.once('error',reject);child.once('exit',resolve)});
  if(code===42){crashes=0;continue;}
  if(code&&code!==23&&crashes++<3){await new Promise(r=>setTimeout(r,5000));continue;}
  process.exitCode=code||0;return;
 }
}
if(require.main===module)main().catch(e=>{console.error(e.statusCode===401?'Saved pairing rejected. Reconnect this worker in Admin.':'Managed worker could not start. Check the server connection or worker release.');process.exitCode=e.statusCode===401?23:1});
module.exports={validateManifest,verify,install,main,FILES};

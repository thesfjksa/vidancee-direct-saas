'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {fail}=require('./voice_contract');
const exec=promisify(execFile);
const unavailableCodes=new Set(['ENOENT','EACCES','EPERM','ENOEXEC','ENOTDIR','EINVAL']);
function bundledProbePath(){
 try{return require('@ffprobe-installer/ffprobe').path;}catch{return undefined;}
}
function probeBinaries(){
 // Prefer the host's maintained FFprobe, but do not depend on a system install.
 return [...new Set([process.env.FFPROBE_PATH,'ffprobe',bundledProbePath()].filter(Boolean))];
}
async function prepareBundledProbe(binary){
 // npm --ignore-scripts skips the platform package's executable-bit setup.
 // Only repair the trusted package binary, never a path supplied by configuration or an upload.
 if(process.platform==='win32'||binary!==bundledProbePath())return;
 try{
  const stat=await fs.stat(binary);
  if(stat.isFile()&&(stat.mode&0o111)!==0o111)await fs.chmod(binary,(stat.mode&0o777)|0o111);
 }catch(e){console.warn('[voice-upload] Bundled probe permission setup:',e.code||e.name);}
}
async function probe(file,{binaries=probeBinaries()}={}){
 let dir;
 try{
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'cmm-voice-'));
  const local=path.join(dir,'source');await fs.writeFile(local,file.data);
  const args=['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type','-of','json',local];
  let raw;
  for(const binary of binaries){
   try{
    await prepareBundledProbe(binary);
    ({stdout:raw}=await exec(binary,args,{timeout:30000,killSignal:'SIGKILL',maxBuffer:100000,windowsHide:true}));
    break;
   }catch(e){
    if(unavailableCodes.has(e.code))continue;
    if(e.killed||e.signal||e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw fail(503,'Audio validation could not finish. Please retry or contact support.');
    // An executable ran but rejected this media: do not bypass validation.
    if(typeof e.code==='number')throw fail(400,'Could not read source audio. Upload a valid, playable audio file.');
    throw e;
   }
  }
  if(raw===undefined){
   console.warn('[voice-upload] FFprobe unavailable: no executable could be started');
   throw fail(503,'Audio validation is temporarily unavailable. Please contact support.');
  }
  const data=JSON.parse(raw),duration=Number(data.format?.duration);
  if(!Number.isFinite(duration)||duration<=0||!Array.isArray(data.streams)||!data.streams.some(s=>s.codec_type==='audio'))throw fail(400,'The source must contain playable audio.');
  return {duration,video:data.streams.some(s=>s.codec_type==='video')};
 }catch(e){
  if(e.statusCode)throw e;
  console.warn('[voice-upload] Audio validation failed:',e.code||e.name);
  throw fail(503,'Audio validation is temporarily unavailable. Please contact support.');
 }finally{
  if(dir)await fs.rm(dir,{recursive:true,force:true}).catch(e=>console.warn('[voice-upload] Temporary media cleanup failed:',e.code||e.name));
 }
}
module.exports={probe,probeBinaries};

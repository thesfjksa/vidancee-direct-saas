'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
function run(binary,args,timeout=180000){return new Promise((resolve,reject)=>{
 const child=spawn(binary,args,{stdio:['ignore','pipe','pipe'],shell:false});let out='',err='',settled=false;
 const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Story assembly timed out.'));},timeout);
 const finish=e=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve(out);};
 child.stdout.on('data',b=>{out+=b;if(out.length>100000){child.kill('SIGKILL');finish(new Error('Renderer output exceeded limit.'));}});
 child.stderr.on('data',b=>{err=(err+b).slice(-2000);});child.on('error',()=>finish(new Error('Story renderer is unavailable. Install FFmpeg and ffprobe on the worker.')));child.on('close',code=>finish(code===0?null:new Error('Story assembly failed. Check the worker renderer.')));
 });}
function clipArgs(video,audio,output,ratio){
 const [w,h]=ratio==='9:16'?[768,1366]:[1366,768];
 return ['-nostdin','-y','-protocol_whitelist','file,pipe','-i',video,'-protocol_whitelist','file,pipe','-i',audio,'-map','0:v:0','-map','1:a:0','-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=15,trim=duration=15,setpts=PTS-STARTPTS`,'-af','apad,atrim=duration=15,asetpts=PTS-STARTPTS','-t','15','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-ar','48000','-ac','2','-movflags','+faststart',output];
}
async function assemble({scenes,ratio,download,publish}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cmm-story-'));
 try{
  const files=[];
  for(let i=0;i<scenes.length;i++){
   const video=path.join(dir,i+'.mp4'),audio=path.join(dir,i+'.mp3'),out=path.join(dir,'scene'+i+'.mp4');
   await download(scenes[i].video,video);await download(scenes[i].audio,audio);
   const seconds=Number(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',audio]));
   if(!Number.isFinite(seconds)||seconds<=0||seconds>15)throw new Error('Narration exceeded its 15-second scene. Regenerate a shorter narration segment.');
   await run(process.env.FFMPEG_PATH||'ffmpeg',clipArgs(video,audio,out,ratio));files.push(out);
  }
  await fs.writeFile(path.join(dir,'list.txt'),files.map(f=>"file '"+f+"'").join('\n'));
  const final=path.join(dir,'final.mp4');
  await run(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-y','-f','concat','-safe','0','-i',path.join(dir,'list.txt'),'-c','copy','-movflags','+faststart',final]);
  const duration=Number(await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',final]));
  if(!Number.isFinite(duration)||Math.abs(duration-120)>0.15)throw new Error('Final story duration verification failed.');
  return await publish(final);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
module.exports={run,clipArgs,assemble};

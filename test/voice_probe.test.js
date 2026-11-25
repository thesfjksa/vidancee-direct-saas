'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {probe,probeBinaries}=require('../src/voice_probe');
const bundled=require('@ffprobe-installer/ffprobe').path;
test('voice uploads use packaged FFprobe when the configured/system binary cannot launch',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'voice-probe-test-'));
 try{
  assert.ok(probeBinaries().includes(bundled));
  for(const ext of ['mp3','wav']){
   const file=path.join(dir,'sample.'+ext);
   execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=12',file]);
   const info=await probe({data:await fs.readFile(file)},{binaries:[path.join(dir,'missing-ffprobe'),bundled]});
   assert.equal(info.video,false);
   assert.ok(info.duration>=10&&info.duration<13);
  }
  await assert.rejects(probe({data:Buffer.from('not audio')},{binaries:[bundled]}),{statusCode:400});
  await assert.rejects(probe({data:Buffer.from('not audio')},{binaries:[path.join(dir,'missing-ffprobe')]}),{statusCode:503});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

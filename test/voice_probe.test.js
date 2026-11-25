'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {probe,probeBinaries,probeCloneSample}=require('../src/voice_probe');
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

test('real MP3 and WAV clone samples validate without an executable',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'voice-clone-probe-test-'));
 try{
  for(const [ext,mimeType] of [['mp3','audio/mpeg'],['wav','audio/wav']]){
   const file=path.join(dir,'sample.'+ext);
   const encoding=ext==='mp3'?['-q:a','4']:[];
   execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=12',...encoding,file]);
   const data=await fs.readFile(file);
   const info=await probeCloneSample({data,mimeType},{binaries:[]});
   assert.equal(info.video,false);
   assert.ok(Math.abs(info.duration-12)<.2);
   if(ext==='wav')await assert.rejects(probeCloneSample({data,mimeType:'audio/mpeg'},{binaries:[]}),{statusCode:400});
  }
  await assert.rejects(probeCloneSample({data:Buffer.from('not audio'),mimeType:'audio/mpeg'},{binaries:[]}),{statusCode:400});
  await assert.rejects(probeCloneSample({data:Buffer.from('unsupported'),mimeType:'audio/ogg'},{binaries:[]}),{statusCode:503});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('MP3 clone upload queues only a valid sample when the web host cannot launch FFprobe',async()=>{
 const {Readable}=require('node:stream');
 const {createVoiceStudio}=require('../src/voice_studio');
 const sample=duration=>execFileSync(process.env.FFMPEG_PATH||'ffmpeg',[
  '-v','error','-f','lavfi','-i','sine=frequency=440:duration='+duration,'-f','mp3','pipe:1',
 ]);
 const valid=sample(12),short=sample(2),boundary='clone-probe-boundary';
 const makeRequest=(audio)=>{
  const fields={voice_name:'Test voice',requestKey:'test-request-1',language_tag:'English'};
  const parts=Object.entries(fields).map(([name,value])=>'--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"\r\n\r\n'+value+'\r\n');
  const header='--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="sample.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n';
  const req=Readable.from(Buffer.concat([Buffer.from(parts.join('')+header),audio,Buffer.from('\r\n--'+boundary+'--\r\n')]));
  req.method='POST';
  req.headers={'content-type':'multipart/form-data; boundary='+boundary,'x-cmm-voice':'1',origin:'https://cmmtools.site'};
  return req;
 };
 let queued=0,woken=0,checkedLanguages=0,reply;
 const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release() {},
  async execute(sql,args){
   if(sql.startsWith('SELECT credits'))return [[{credits:10,status:'active'}]];
   if(sql.startsWith('SELECT * FROM voice_studio_requests'))return [[]];
   if(sql.startsWith('INSERT INTO user_voice_clones')){
    assert.deepEqual(args.at(-1),valid);
    queued++;
    return [{insertId:123}];
   }
   assert.match(sql,/INSERT INTO voice_studio_requests/);
   return [{affectedRows:1}];
  },
 };
 const studio=createVoiceStudio({
  requireDatabase(){},requireUser:async()=>({id:7}),origin:'https://cmmtools.site',
  db:()=>({getConnection:async()=>connection}),access:async()=>({vibi:true}),
  settings:async()=>({vibiApiKey:'test-key',vibiEnabled:true,allowProviderCharges:true}),
  client:()=>({getLanguages:async()=>{checkedLanguages++;return [{code:'English'}];}}),
  probeCloneSample:file=>probeCloneSample(file,{binaries:[]}),
  wake(){woken++;},json(_res,status,body){reply={status,body};},
 });
 await assert.rejects(studio.handle(makeRequest(short),{},null,'/api/voice-clones'),/10 seconds to 5 minutes/);
 assert.equal(checkedLanguages,0);
 assert.equal(queued,0);
 await studio.handle(makeRequest(valid),{},null,'/api/voice-clones');
 assert.deepEqual(reply,{status:201,body:{ok:true,clone:{id:123,voice_name:'Test voice',status:'queued'}}});
 assert.equal(queued,1);
 assert.equal(woken,1);
});

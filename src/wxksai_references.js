'use strict';

// WXKSAI unified V1 video endpoint uses repeated multipart images/videos/audios.
// Validate and hydrate every file before one paid POST; never retry an ambiguous submit.
const { wxksaiReferenceCapabilities, REFERENCE_SPECS } = require('./wxksai_models.js');
const { mp4Seconds } = require('./vercel_models.js');

const MIB = 1024 * 1024;
const MIME = Object.freeze({
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  video: new Set(['video/mp4']),
  audio: new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']),
});
const EXTENSIONS = {
  image: { 'image/jpeg': ['jpg','jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] },
  video: { 'video/mp4': ['mp4'] },
  audio: { 'audio/mpeg': ['mp3'], 'audio/mp3': ['mp3'],
    'audio/wav': ['wav'], 'audio/x-wav': ['wav'], 'audio/wave': ['wav'], 'audio/vnd.wave': ['wav'] },
};

function invalid(message) { const e=new Error(message); e.statusCode=400; return e; }

function wavSeconds(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE') return null;
  let rate=0, size=0, offset=12;
  while(offset+8<=bytes.length) {
    const chunk=bytes.toString('ascii',offset,offset+4), length=bytes.readUInt32LE(offset+4);
    if(length>bytes.length-offset-8) return null;
    if(chunk==='fmt ' && length>=16)rate=bytes.readUInt32LE(offset+16);
    if(chunk==='data')size+=length;
    offset+=8+length+(length%2);
  }
  return rate>0 && size>0 ? size/rate : null;
}

// Count actual MPEG Layer III frames. Supports fixed and variable bitrate MP3;
// never guess reference durations from filesize or an untrusted filename.
function mp3Seconds(bytes) {
  let pos=0;
  if(bytes.length>=10 && bytes.toString('ascii',0,3)==='ID3'){
    if([bytes[6],bytes[7],bytes[8],bytes[9]].some(x=>x>127))return null;
    pos=10+((bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9]);
    if(bytes[5]&16)pos+=10;
  }
  const bitrates1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const bitrates2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  let seconds=0, frames=0, searched=0;
  while(pos+4<=bytes.length){
    const h=bytes.readUInt32BE(pos), version=(h>>>19)&3, layer=(h>>>17)&3;
    const bi=(h>>>12)&15, sr=(h>>>10)&3, pad=(h>>>9)&1;
    if(((h>>>21)&2047)!==2047 || version===1 || layer!==1 || bi===0 || bi===15 || sr===3){
      if(frames)return null;
      if(++searched>4096)return null;
      pos++; continue;
    }
    const sampleRate=[44100,48000,32000][sr]/(version===3?1:version===2?2:4);
    const kbps=(version===3?bitrates1:bitrates2)[bi];
    const length=Math.floor((version===3?144000:72000)*kbps/sampleRate+pad);
    if(length<24||pos+length>bytes.length)return null;
    seconds+=(version===3?1152:576)/sampleRate;
    pos+=length; frames++;
    if(pos===bytes.length || (bytes.length-pos===128 && bytes.toString('ascii',pos,pos+3)==='TAG'))break;
  }
  return frames>=5 && seconds>0 ? seconds : null;
}

function mediaSeconds(item) {
  const kind=item.kind, mimeType=String(item.mimeType||'').toLowerCase(), data=item.data;
  const seconds=kind==='video'?mp4Seconds(data)
    : mimeType==='audio/mpeg'||mimeType==='audio/mp3'?mp3Seconds(data):wavSeconds(data);
  if(!Number.isFinite(seconds)||seconds<2||seconds>30)
    throw invalid('WXKSAI BD2 requires valid 2–30-second MP4 videos or MP3/WAV audio references with readable duration.');
  return Math.round(seconds*1000)/1000;
}

function prepareWxksaiReferences(modelId,options,references=[]) {
  if(!Array.isArray(references))throw invalid('Invalid WXKSAI reference selection.');
  const caps=wxksaiReferenceCapabilities(modelId), spec=REFERENCE_SPECS[modelId];
  // V03 Seedance 2.0 Mini MUST have at least one image. Enforce at the
  // worker boundary as well as at quote/reservation, before the paid POST.
  if(!references.length && caps.image.min>0)
    throw invalid('This Dope model requires at least one reference image.');
  if(!references.length)return null; // Existing text-to-video SKUs retain JSON.
  if(!spec)throw invalid('Unknown WXKSAI reference model.');
  const grouped={image:[],video:[],audio:[]};
  let bytesTotal=0;
  for(const item of references) {
    const kind=String(item?.kind||'');
    if(!Object.hasOwn(grouped,kind))throw invalid('Unsupported WXKSAI reference media type.');
    const cap=caps[kind], mimeType=String(item?.mimeType||'').toLowerCase();
    const bytes=item?.data;
    if(!cap.supported || grouped[kind].length>=cap.max)
      throw invalid('This WXKSAI model does not support that many '+kind+' references.');
    if(!MIME[kind].has(mimeType)||!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>cap.maxBytes)
      throw invalid('Invalid WXKSAI '+kind+' reference format or file size.');
    const filename=String(item?.filename||'').split(/[\\/]/).pop();
    const ext=filename.split('.').pop().toLowerCase();
    if(!filename || filename.length>160 || !EXTENSIONS[kind][mimeType]?.includes(ext))
      throw invalid('WXKSAI reference filename must match its file type.');
    bytesTotal+=bytes.length;
    grouped[kind].push({...item,filename,mimeType});
  }
  const total=Object.values(grouped).reduce((sum,list)=>sum+list.length,0);
  if(total>caps.totalMax)throw invalid('Too many WXKSAI reference files.');
  if(modelId==='seedance-2.5-bd-2') {
    if(bytesTotal>30*MIB)throw invalid('WXKSAI BD2 reference files exceed the 30 MB total size limit.');
    if(Number(options?.duration)===4 && (grouped.image.length>9||grouped.video.length||grouped.audio.length))
      throw invalid('WXKSAI BD2 requires at least 5 seconds with video, audio, or over nine images.');
  }
  const form=new FormData();
  for(const [name,value] of Object.entries({
    model:modelId,prompt:options.prompt,seconds:String(options.duration),
    resolution:options.resolution,aspect_ratio:options.aspectRatio,
  }))form.set(name,String(value));
  const durations={videos:[],audios:[]};
  for(const [kind,field] of [['image','images'],['video','videos'],['audio','audios']]){
    for(const item of grouped[kind]){
      if(modelId==='seedance-2.5-bd-2' && kind!=='image')
        durations[field].push(mediaSeconds(item));
      form.append(field,new Blob([item.data],{type:item.mimeType}),item.filename);
    }
  }
  if(modelId==='seedance-2.5-bd-2'){
    const all=[...durations.videos,...durations.audios];
    if(all.reduce((sum,n)=>sum+n,0)>spec.totalSeconds)
      throw invalid('WXKSAI BD2 reference video and audio durations exceed 30 seconds in total.');
    if(all.length)form.set('reference_durations',JSON.stringify(durations));
  }
  return form;
}

module.exports={prepareWxksaiReferences,wavSeconds,mp3Seconds};

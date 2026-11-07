'use strict';
// Reference videos longer than a model allows are cut to the allowed length
// (losslessly, from the start) instead of failing the job.
const {trimMp4,readBoxes}=require('./mp4_trim.js');
const {mp4Seconds}=require('./vercel_models.js');

// limit: {totalSeconds, clipSeconds} (either may be missing). Videos share the
// total in upload order. Returns notices describing each trimmed video.
function trimReferenceVideos(videos,limit={}){
  const notices=[];
  if(!Array.isArray(videos)||!videos.length)return notices;
  const total=Number(limit.totalSeconds)>0?Number(limit.totalSeconds):Infinity;
  const clip=Number(limit.clipSeconds)>0?Number(limit.clipSeconds):Infinity;
  if(total===Infinity&&clip===Infinity)return notices;
  const tolerance=limit.toleranceSeconds??0.05;
  const minClip=limit.minClipSeconds??1;
  let budget=total;
  for(const video of videos){
    let seconds;
    try{seconds=mp4Seconds(video?.data);}catch{continue;}
    if(!seconds)continue;
    const allowed=Math.floor(Math.min(clip,budget)*1000)/1000;
    if(seconds>allowed+tolerance){
      if(allowed<minClip){
        throw Object.assign(new Error('Reference videos can be '+(total!==Infinity?total:clip)+' seconds long in total for this model. Remove a reference video.'),{statusCode:400});
      }
      let result;
      try{result=trimMp4(video.data,allowed);}
      catch{continue;} // unsupported layout: the model's own checks still apply
      video.data=result.data;
      notices.push({filename:String(video.filename||'video'),fromSeconds:Math.round(seconds*10)/10,toSeconds:Math.round(result.seconds*10)/10});
      budget-=result.seconds;
    }else budget-=seconds;
  }
  return notices;
}

// Validate readable MP4/MOV metadata before charging. Chrome still verifies
// the selected file and preview, including files whose metadata is incomplete.
function validateAividVideoReferences(videos,limit){
  if(!Array.isArray(videos))return;
  let total=0;
  for(const [index,video] of videos.entries()){
    if(!Buffer.isBuffer(video?.data))continue;
    let boxes;
    try{boxes=readBoxes(video.data);}catch{continue;}
    const moov=boxes.find(box=>box.type==='moov');
    if(!moov)continue;
    const child=(box,type)=>box?.children?.find(b=>b.type===type);
    const movie=child(moov,'mvhd')?.data;
    const version=movie?.[0];
    if((version===0&&movie.length>=20)||(version===1&&movie.length>=32)){
      const scale=movie.readUInt32BE(version===0?12:20);
      const duration=version===0?movie.readUInt32BE(16):Number(movie.readBigUInt64BE(24));
      if(scale>0&&duration>0){
        const seconds=duration/scale;
        if(seconds<limit.minClipSeconds)throw Object.assign(
          new Error('AIVID video reference '+(index+1)+' must be at least '+limit.minClipSeconds+' seconds.'),{statusCode:400});
        total+=seconds;
      }
    }
    const track=moov.children.find(box=>box.type==='trak'&&
      child(child(box,'mdia'),'hdlr')?.data.toString('ascii',8,12)==='vide');
    const header=child(track,'tkhd')?.data;
    if(!header||!((header[0]===0&&header.length>=84)||(header[0]===1&&header.length>=96)))continue;
    const width=header.readUInt32BE(header.length-8)/65536,height=header.readUInt32BE(header.length-4)/65536;
    if(!width||!height)continue;
    const pixels=width*height,ratio=width/height;
    if(Math.min(width,height)<300||Math.max(width,height)>6000||pixels<409600||pixels>2086876||ratio<0.4||ratio>2.5)
      throw Object.assign(new Error('AIVID video reference '+(index+1)+' has unsupported dimensions. Export a standard 16:9, 9:16, or square video around 720p.'),{statusCode:400});
  }
  if(total>limit.totalSeconds)throw Object.assign(
    new Error('AIVID video references can be '+limit.totalSeconds+' seconds long in total. Shorten the reference clips.'),{statusCode:400});
}

module.exports={trimReferenceVideos,validateAividVideoReferences};

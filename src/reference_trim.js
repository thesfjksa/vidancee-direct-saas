'use strict';
// Reference videos longer than a model allows are cut to the allowed length
// (losslessly, from the start) instead of failing the job.
const {trimMp4}=require('./mp4_trim.js');
const {mp4Seconds}=require('./vercel_models.js');

// limit: {totalSeconds, clipSeconds} (either may be missing). Videos share the
// total in upload order. Returns notices describing each trimmed video.
function trimReferenceVideos(videos,limit={}){
  const notices=[];
  if(!Array.isArray(videos)||!videos.length)return notices;
  const total=Number(limit.totalSeconds)>0?Number(limit.totalSeconds):Infinity;
  const clip=Number(limit.clipSeconds)>0?Number(limit.clipSeconds):Infinity;
  if(total===Infinity&&clip===Infinity)return notices;
  let budget=total;
  for(const video of videos){
    const seconds=mp4Seconds(video?.data);
    if(!seconds)continue;
    const allowed=Math.floor(Math.min(clip,budget)*1000)/1000;
    if(seconds>allowed+0.05){
      if(allowed<1){
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

module.exports={trimReferenceVideos};

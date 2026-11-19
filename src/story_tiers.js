'use strict';
const TIERS=Object.freeze([120,180,300].map(seconds=>Object.freeze({id:(seconds/60)+'min',label:(seconds/60)+' minutes',duration:seconds,scenes:seconds/15})));
const VIDEO_MODEL='minimax_h3_cinematic';
const DEFAULT_IMAGE_MODEL='api888_gpt_image_2_1k';
function storyTier(id){const tier=TIERS.find(t=>t.id===id);if(!tier)throw Object.assign(new Error('Choose a 2-minute, 3-minute or 5-minute story tier.'),{statusCode:400});return tier;}
function durationTier(duration=120){const tier=TIERS.find(t=>t.duration===duration);if(!tier)throw Object.assign(new Error('Unsupported story duration.'),{statusCode:400});return tier;}
async function tierQuotes({quoteVideo,quoteImage,quoteNarration,imageModel=DEFAULT_IMAGE_MODEL}){
 const [video,image,narration]=await Promise.all([quoteVideo(),quoteImage(),quoteNarration(500)]);
 for(const amount of [video,image,narration])if(!Number.isFinite(amount)||amount<=0)throw Object.assign(new Error('Story pricing is currently unavailable.'),{statusCode:503});
 // Conservative estimate: up to 3 character portraits and each narration's
 // validated 500-character bound. Normal child generation billing is retained.
 return TIERS.map(t=>({...t,credits:Math.round((t.scenes*(video+narration)+3*image)*100)/100,isEstimate:true,
  videoModel:VIDEO_MODEL,imageModel,breakdown:{video:Math.round(t.scenes*video*100)/100,images:Math.round(3*image*100)/100,narration:Math.round(t.scenes*narration*100)/100}}));
}
module.exports={TIERS,VIDEO_MODEL,DEFAULT_IMAGE_MODEL,storyTier,durationTier,tierQuotes};

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

// Price preview does not prove provider readiness or grant generation access.
// Use the saved exact GPT SKU rate when present, otherwise its reviewed catalog
// rate. Never substitute another image model or invent a missing price.
async function previewTierQuotes({getImageModel=async()=>null,getRate,imageModel=DEFAULT_IMAGE_MODEL}){
 const {IMAGE_IDS,IMAGE_CNY}=require('./api888_models');
 const {getCost}=require('./pricing');
 const {applyPriceRate,sourceToCustomerCredits,cnyToCredits}=require('./billing');
 const rawId=IMAGE_IDS.find(id=>/^gpt-image-/.test(id)&&'api888_'+id.replace(/[^a-zA-Z0-9]/g,'_')===imageModel);
 if(!rawId||!(Number(IMAGE_CNY[rawId])>0))throw Object.assign(new Error('The configured GPT image model has no reviewed price.'),{statusCode:503});
 const [model,rate]=await Promise.all([Promise.resolve().then(()=>getImageModel(imageModel)).catch(()=>null),getRate()]);
 if(!Number.isFinite(rate)||rate<=0)throw Object.assign(new Error('Account pricing is unavailable.'),{statusCode:503});
 const saved=Number(model?.api888?.sourceCny);
 const useSaved=model?.provider==='api888'&&model.providerModelId===rawId&&model.api888?.billing==='image'&&Number.isFinite(saved)&&saved>0&&saved<=999999;
 const cny=Math.round(((useSaved?saved:Number(IMAGE_CNY[rawId]))+Number.EPSILON)*10000)/10000;
 const tiers=await tierQuotes({imageModel,
  quoteVideo:async()=>applyPriceRate(getCost(VIDEO_MODEL,15,'768p'),rate),
  quoteImage:async()=>applyPriceRate(cnyToCredits(cny),rate),
  quoteNarration:async chars=>applyPriceRate(sourceToCustomerCredits(chars),rate),
 });
 return tiers.map(t=>({...t,priceBasis:useSaved?'saved-model-rate':'reviewed-catalog-rate'}));
}
module.exports.previewTierQuotes=previewTierQuotes;

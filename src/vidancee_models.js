'use strict';
const { CREDITS_PER_USD } = require('./billing.js');
// Captured account job 26394: Omni-Flash, 4 sec, 9:16, cost_credits=30.
// Other durations/ratios and image/video references must be confirmed before sale.
const MODEL_ID='Omni-Flash';
function isVidanceeModel(id){return id==='vd_omni_flash';}
function vidanceeReferenceCapabilities(){
  return {textOnly:true,totalMax:0,image:{supported:false,max:0,min:0,roles:[],requiredRoles:[]},video:{supported:false,max:0,min:0,roles:[],requiredRoles:[]},audio:{supported:false,max:0,min:0,roles:[],requiredRoles:[]}};
}
function vidanceeMediaModels(){
  return [{providerModelId:MODEL_ID,publicModelId:'vd_omni_flash',mediaType:'video',label:'Omni Flash · 4 s',
    options:{catalogVerified:true,adapterSupported:true,setupReason:'',gatewayType:'video',
      pricing:{video_duration_prices:[{duration:4,cost:30/CREDITS_PER_USD}]},
      supportedOperations:['text-to-video'],durations:[4],resolutions:['720p'],
      aspectRatios:['9:16'],defaultAspectRatio:'9:16',defaultDuration:4,
      defaultResolution:'720p',fps:24,modes:[],supportsAudio:false,
      mediaRoles:[],referenceCapabilities:vidanceeReferenceCapabilities(),
      vidancee:{model:MODEL_ID,providerCredits:30}}}];
}
module.exports={MODEL_ID,isVidanceeModel,vidanceeMediaModels,vidanceeReferenceCapabilities};

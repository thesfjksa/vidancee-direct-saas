'use strict';
const { CREDITS_PER_USD } = require('./billing.js');
// Captured account job 26394: Omni-Flash, 4 sec, 9:16, cost_credits=30.
// Job 26443: 4-second, 9:16 Omni Flash image-reference generation accepted. Only one image is verified.
const MODEL_ID='Omni-Flash';
function isVidanceeModel(id){return id==='vd_omni_flash';}
function vidanceeReferenceCapabilities(){
  return {textOnly:true,totalMax:1,image:{supported:true,max:1,min:0,roles:['image_references'],requiredRoles:[],maxBytes:10*1024*1024,formats:['jpeg','png','webp']},video:{supported:false,max:0,min:0,roles:[],requiredRoles:[]},audio:{supported:false,max:0,min:0,roles:[],requiredRoles:[]}};
}
function vidanceeMediaModels(){
  return [{providerModelId:MODEL_ID,publicModelId:'vd_omni_flash',mediaType:'video',label:'Omni Flash · 4 s',
    options:{catalogVerified:true,adapterSupported:true,setupReason:'',gatewayType:'video',
      pricing:{video_duration_prices:[{duration:4,cost:30/CREDITS_PER_USD}]},
      supportedOperations:['text-to-video','image-to-video','reference-to-video'],durations:[4],resolutions:['720p'],
      aspectRatios:['9:16'],defaultAspectRatio:'9:16',defaultDuration:4,
      defaultResolution:'720p',fps:24,modes:[],supportsAudio:false,
      mediaRoles:['image_references'],referenceCapabilities:vidanceeReferenceCapabilities(),
      vidancee:{model:MODEL_ID,providerCredits:30}}}];
}
module.exports={MODEL_ID,isVidanceeModel,vidanceeMediaModels,vidanceeReferenceCapabilities};

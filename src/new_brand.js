'use strict';

// The customer's brand is New; keep provider credentials, internal catalog
// IDs and existing generation rows unchanged so in-flight jobs can resume.
const STORED_ID=/^puream_(sd20|sd25|wan3)_([a-f0-9]+)$/i;
const PUBLIC_ID=/^new_(sd20|sd25|wan3)_([a-f0-9]+)$/i;
const SOURCE_WORD=/(?:puream|pure\s*ream|纯梦)/gi;

function customerNewModelId(id){
  return typeof id==='string'?id.replace(STORED_ID,(_m,family,hash)=>'new_'+family.toLowerCase()+'_'+hash.toLowerCase()):id;
}
function storedNewModelId(id){
  return typeof id==='string'?id.replace(PUBLIC_ID,(_m,family,hash)=>'puream_'+family.toLowerCase()+'_'+hash.toLowerCase()):id;
}
function customerNewLabel(label){
  if(typeof label!=='string')return label;
  return label.replace(/(?:https?:\/\/)?(?:www\.)?puream\.cn(?:\/[^\s<>"']*)?/gi,'New')
    .replace(/puream[-_](?:sd20|sd25|wan3)[-_][a-f0-9]+/gi,'New')
    .replace(SOURCE_WORD,'New');
}
function hideNewSourceInMessage(message){
  if(typeof message!=='string')return message;
  return message.replace(/(?:https?:\/\/)?(?:www\.)?puream\.cn(?:\/[^\s<>"']*)?/gi,'the generation service')
    .replace(/\bpuream[-_][a-z0-9_-]+\b/gi,'service setting')
    .replace(/(?:puream|pure\s*ream)\s+(?=(?:model|video|image|audio|reference|task|request|operation|credential|key|authorization)\b)/gi,'')
    .replace(SOURCE_WORD,'the generation service');
}
module.exports={customerNewModelId,storedNewModelId,customerNewLabel,hideNewSourceInMessage};

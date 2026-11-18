'use strict';
const {fail}=require('./story_store');
function text(value,max){if(typeof value!=='string'||!value.trim()||value.length>max)throw fail(502,'Story planner returned invalid text.');return value.trim();}
function validatePlan(value){
 if(!value||!Array.isArray(value.characters)||value.characters.length<1||value.characters.length>3||!Array.isArray(value.scenes)||value.scenes.length!==8)throw fail(502,'Story must contain 1–3 characters and eight scenes.');
 const characters=value.characters.map((c,i)=>({id:'character'+(i+1),name:text(c.name,80),description:text(c.description,1800)}));
 const scenes=value.scenes.map(s=>{
  const narration=text(s.narration,500);const words=narration.split(/\s+/).length;
  if(words<15||words>28)throw fail(502,'Each English narration segment must contain 15–28 words.');
  return {duration:15,prompt:text(s.prompt,3500),narration};
 });
 return {title:text(value.title,150),synopsis:text(value.synopsis,2500),characters,scenes};
}
async function planStory(client,model,prompt){
 const result=await client.request('/v1/chat/completions',{timeoutMs:90000,maxBytes:100000,body:{model,max_tokens:4000,stream:false,response_format:{type:'json_object'},messages:[
 {role:'system',content:'Write an English cinematic story lasting exactly 120 seconds, with a beginning, development and ending. Return only a JSON object: {title,synopsis,characters:[{name,description}],scenes:[{prompt,narration}]}. Exactly eight scenes of 15 seconds each and 1–3 characters. Each narration MUST have 15–28 English words suitable for a calm narrator. Each scene prompt must describe action, location, camera and lighting and identify characters by name. Character descriptions must lock age, face, hairstyle, outfit and colors. Keep identities and outfits consistent. No captions, on-screen text or spoken dialogue in video prompts. No extra fields.'},
 {role:'user',content:prompt}]}});
 let value;try{value=JSON.parse(result?.choices?.[0]?.message?.content);}catch{throw fail(502,'Story planner did not return valid JSON.');}
 return validatePlan(value);
}
module.exports={validatePlan,planStory};

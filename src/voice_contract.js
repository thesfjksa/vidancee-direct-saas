'use strict';
// Reviewed against https://vibi.pro/docs on 19 November 2026.
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode,definitive:true});
const text=(v,max=10000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw fail(400,'Enter text within the supported length.');return v.trim();};
const id=v=>{if(typeof v!=='string'||!v.trim()||v.length>191||/[\x00-\x1f]/.test(v))throw fail(400,'Choose a valid voice.');return v.trim();};
function number(value,fallback,min,max,label){
 const n=value===undefined?fallback:Number(value);
 if(value===null||value===''||!Number.isFinite(n)||n<min||n>max)throw fail(400,label+' is outside its supported range.');return n;
}
function fixedModel(models){
 const matches=models.filter(m=>m.can_do_text_to_speech!==false&&(/^(?:eleven[_ -]?)v4$/i.test(String(m.model_id||m.id||''))||/^eleven\s+v4$/i.test(String(m.name||'').trim())));
 if(matches.length!==1)throw fail(503,'Eleven v4 is not available in the connected voice model catalog.');
 const m=matches[0],modelId=id(m.model_id||m.id);
 const factor=Number(m.model_rates?.character_cost_multiplier??m.credit_ratio??m.token_cost_factor??1);
 if(!Number.isFinite(factor)||factor<=0||factor>100)throw fail(503,'Eleven v4 pricing is unavailable.');
 return {modelId,name:'Eleven v4',factor,maxTextChars:Math.min(10000,Number(m.maximum_text_length_per_request||m.max_characters_request_subscribed_user)||5000),
  capabilities:{speed:m.supports_speed!==false,similarity:m.supports_similarity!==false&&modelId!=='eleven_v3',style:m.can_use_style===true,speakerBoost:m.can_use_speaker_boost===true,discreteStability:modelId==='eleven_v3'},languages:m.languages||[]};
}
function languages(remote,model){
 const normalize=x=>({code:String(x.code||x.language_id||''),name:String(x.name||x.code||x.language_id||'')});
 const available=remote.map(normalize).filter(x=>/^[a-z]{2,3}(?:-[A-Za-z0-9]+)?$/.test(x.code));
 const supported=new Set((model?.languages||[]).map(x=>String(x.language_id||x.code||'')));
 return supported.size?available.filter(x=>supported.has(x.code)):available;
}
function language(value,list){const code=String(value||'en');if(!list.some(x=>x.code===code))throw fail(400,'Choose a supported language.');return code;}
function voiceSettings(body,capabilities={speed:true,similarity:true,style:true,speakerBoost:true}){
 const settings={stability:number(body.stability,.5,0,1,'Stability')};
 if(capabilities.discreteStability&&![0,.5,1].includes(settings.stability))throw fail(400,'This voice model accepts stability 0, 50 or 100 percent.');
 if(capabilities.speed)settings.speed=number(body.speed,1,.7,1.2,'Speed');
 if(capabilities.similarity)settings.similarity_boost=number(body.similarityBoost,.75,0,1,'Similarity');
 if(capabilities.style)settings.style=number(body.style,0,0,1,'Style');
 if(capabilities.speakerBoost){if(body.useSpeakerBoost!==undefined&&typeof body.useSpeakerBoost!=='boolean')throw fail(400,'Speaker boost must be on or off.');settings.use_speaker_boost=body.useSpeakerBoost!==false;}
 return settings;
}
function speech(body,model,list){return {text:text(body.text,model.maxTextChars),voiceId:id(body.voiceId),provider:'elevenlabs',modelId:model.modelId,languageCode:language(body.languageCode,list),voiceSettings:voiceSettings(body,model.capabilities)};}
function dialogue(body,model,list){
 const script=text(body.text,model.maxTextChars),rows=body.speakers;
 if(!Array.isArray(rows)||rows.length<2||rows.length>8)throw fail(400,'Add between 2 and 8 dialogue speakers.');
 const speakers=Object.create(null),used=new Set();let characters=0,current=null;
 for(const row of rows){
  const name=String(row.name||'').trim();if(!/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(name)||Object.hasOwn(speakers,name)||['__proto__','constructor','prototype'].includes(name))throw fail(400,'Give each speaker a unique name using letters, numbers, spaces or hyphens.');
  const s=speech({...body,...row,text:'x',languageCode:row.languageCode||body.languageCode},model,list);
  speakers[name]={provider:s.provider,voice_id:s.voiceId,model_id:s.modelId,language_code:s.languageCode,voice_settings:s.voiceSettings};
 }
 for(const line of script.split(/\r?\n/)){
  if(!line.trim())continue;
  const match=line.match(/^([^:]+):\s*(.*)$/);
  if(match){current=match[1].trim();if(!Object.hasOwn(speakers,current)||!match[2].trim())throw fail(400,'Every dialogue turn must use a configured speaker and contain speech.');used.add(current);characters+=match[2].length;}
  else{if(!current)throw fail(400,'Start dialogue with Speaker: text.');characters+=line.length;}
 }
 if(used.size<2)throw fail(400,'The script must contain at least two different speakers.');
 return {text:script,speakers,pause_between_turns:number(body.pauseBetweenTurns,.5,0,3,'Pause'),characters};
}
const sourceCost=(operation,{characters=0,duration=0,factor=1}={})=>{
 if(operation==='speech'||operation==='dialogue'||operation==='clone-speech')return Math.ceil(characters*factor);
 if(!Number.isFinite(duration)||duration<=0)throw fail(400,'The source has no measurable duration.');
 if(operation==='voice-changer'){if(duration>300)throw fail(400,'Voice changer supports up to 5 minutes.');return Math.ceil(duration*1000/60);}
 if(operation==='dubbing'){if(duration>9000)throw fail(400,'Dubbing supports up to 2.5 hours.');return Math.ceil(duration)*50;}
 throw fail(400,'Choose a supported voice tool.');
};
module.exports={fail,text,id,number,fixedModel,languages,language,voiceSettings,speech,dialogue,sourceCost};

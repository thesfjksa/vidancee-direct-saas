'use strict';
const {validatePlan}=require('./story_plan');
async function advance(story,deps){
 const state=story.state;
 const tier=require('./story_tiers').durationTier(story.options?.duration||120);
 if(!state.plan){
  if(state.planningStarted)throw new Error('Story writing was interrupted. Review before explicitly retrying; the writing provider may have charged.');
  state.planningStarted=true;await deps.save(state);
  state.plan=validatePlan(await deps.plan(story.prompt,tier.duration),tier.duration);state.planningStarted=false;await deps.save(state);return;
 }
 const plan=state.plan;
 async function step(key,submit){
  state.stage=key;await deps.save(state);
  let row=await deps.find(key);
  if(!row){await submit({storyId:story.id,stepKey:key});return null;}
  if(['failed','submit_error','cancelled','canceled'].includes(row.status)){
   state.failedStep=key;await deps.save(state);throw new Error('A story generation failed. Review the saved scene before retrying.');
  }
  return row.status==='completed'?row:null;
 }
 const characters=[];
 for(let i=0;i<plan.characters.length;i++){
  const c=plan.characters[i];const row=await step('character'+i,ctx=>deps.image(c,ctx));
  if(!row)return;characters.push(row);
 }
 const clips=[];
 for(let i=0;i<tier.scenes;i++){
  const scene=plan.scenes[i];
  const audio=await step('narration'+i,ctx=>deps.voice(scene.narration,ctx));if(!audio)return;
  const video=await step('scene'+i,ctx=>deps.video(scene,characters,plan.characters,ctx));if(!video)return;
  clips.push({video,audio});
 }
 state.stage='assembling';await deps.save(state);
 state.output=await deps.assemble(clips,tier.duration);state.stage='completed';await deps.save(state,true);
}
module.exports={advance};

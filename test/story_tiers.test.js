'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TIERS,storyTier,tierQuotes}=require('../src/story_tiers');
const {validatePlan,planStory}=require('../src/story_plan');
const {advance}=require('../src/story_engine');
const {create}=require('../src/story_store');
const sample=seconds=>({title:'A story',synopsis:'A cinematic English adventure.',characters:[{name:'Adam',description:'A keeper in a navy coat.'}],scenes:Array.from({length:seconds/15},()=>({prompt:'Adam watches the sea.',narration:'The young keeper watched the distant sea, wondering why the mysterious light returned every night before the morning sun.'}))});
test('only 2, 3 and 5 minute tiers exist and their prices follow account quotes',async()=>{
 assert.deepEqual(TIERS.map(t=>[t.id,t.duration,t.scenes]),[['2min',120,8],['3min',180,12],['5min',300,20]]);
 for(const bad of ['1min','4min','10min',120,null])assert.throws(()=>storyTier(bad));
 const make=rate=>tierQuotes({quoteVideo:async()=>10*rate,quoteImage:async()=>2*rate,quoteNarration:async n=>{assert.equal(n,500);return 5*rate;}});
 assert.deepEqual((await make(1)).map(t=>t.credits),[126,186,306]);
 assert.deepEqual((await make(2)).map(t=>t.credits),[252,372,612]);
 for(const t of await make(1)){assert.equal(t.videoModel,'minimax_h3_cinematic');assert.equal(t.imageModel,'api888_gpt_image_2_6');assert.equal(t.isEstimate,true);}
 await assert.rejects(tierQuotes({quoteVideo:async()=>0,quoteImage:async()=>1,quoteNarration:async()=>1}),/pricing/);
});
test('each duration plans exactly its number of scenes and the planner requests the selected length',async()=>{
 for(const t of TIERS){
  assert.equal(validatePlan(sample(t.duration),t.duration).scenes.length,t.scenes);
  assert.throws(()=>validatePlan(sample(t.duration),t.duration===120?180:120));
  const result=await planStory({request:async(path,options)=>{assert.ok(options.body.messages[0].content.includes('exactly '+t.duration+' seconds'));assert.ok(options.body.max_tokens>=t.scenes*450);return {choices:[{message:{content:JSON.stringify(sample(t.duration))}}]};}},'owner/model','An adventure',t.duration);
  assert.equal(result.scenes.length,t.scenes);
 }
});
test('orchestrator completes 8, 12 and 20 scenes with ordered narration and correct export duration',async()=>{
 for(const t of TIERS){
  let state={},rendered=0;const rows=new Map(),calls=[];
  const submit=async(...args)=>{const c=args.at(-1);calls.push(c.stepKey);rows.set(c.stepKey,{id:c.stepKey,status:'completed'});};
  const deps={plan:async()=>sample(t.duration),save:async s=>{state=structuredClone(s);},find:async key=>rows.get(key),image:submit,voice:submit,video:submit,assemble:async(clips,duration)=>{assert.equal(duration,t.duration);assert.equal(clips.length,t.scenes);rendered++;}};
  for(let i=0;i<60&&state.stage!=='completed';i++)await advance({id:'story',prompt:'A story',options:{duration:t.duration},state},deps);
  assert.equal(state.stage,'completed');assert.equal(rendered,1);assert.equal(calls.length,1+2*t.scenes);assert.equal(new Set(calls).size,calls.length);
 }
});
test('create accepts a server-quoted tier without budget input, ignores client model/price overrides and replays across rate changes',async()=>{
 const quote={id:'3min',duration:180,credits:500,videoModel:'minimax_h3_cinematic',imageModel:'api888_gpt_image_2_6',breakdown:{video:400,images:20,narration:80}};
 let saved,commits=0;
 const conn={beginTransaction:async()=>{},commit:async()=>commits++,rollback:async()=>{},release:()=>{},execute:async(sql,args)=>{
  if(sql.startsWith('SELECT id,status'))return [[{id:9,status:'active',credits:10000}]];
  if(sql.includes('request_key=?'))return [saved?[saved]:[]];
  if(sql.includes('COUNT(*)'))return [[{total:0}]];
  if(sql.startsWith('INSERT INTO stories')){saved={id:args[0],user_id:args[1],prompt:args[3],options_json:args[4]};return [{}];}
  throw Error(sql);
 }};
 const db={getConnection:async()=>conn,execute:async()=>[[saved]]};
 const body={prompt:'A story',requestKey:'unique-request',tier:'3min',model:'evil',credits:0};
 const row=await create(db,9,body,quote),options=JSON.parse(row.options_json);
 assert.equal(options.duration,180);assert.equal(options.estimatedCredits,500);assert.equal(options.videoModel,'minimax_h3_cinematic');assert.equal(options.imageModel,quote.imageModel);assert.equal(Object.hasOwn(options,'maxCredits'),false);
 assert.equal((await create(db,9,body,{...quote,credits:700})).id,row.id);assert.equal(commits,2);
 await assert.rejects(create(db,9,{...body,tier:'5min'},quote),/pricing/);
 await assert.rejects(create(db,9,{...body,maxCredits:100},quote),/credit limit/);
});
test('story page contains three priced tiers and no budget or retry-limit prompt',()=>{
 const html=require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/story.html'),'utf8');
 for(const t of TIERS){assert.ok(html.includes('value="'+t.id+'"'));assert.ok(html.includes('id="price_'+t.id+'"'));}
 assert.doesNotMatch(html,/maxCredits|Maximum (?:story|total) credits|id="budget"|prompt\('Maximum/i);
 for(const [,script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new (require('node:vm').Script)(script);
});
test('readiness accepts only an 888API GPT character model and exposes all account-priced tiers',async()=>{
 const {createStoryStudio}=require('../src/story_studio');
 const keys=['STORY_STUDIO_ENABLED','STORY_TEXT_MODEL','STORY_ENGLISH_VOICE_ID'],old=keys.map(k=>process.env[k]);
 process.env.STORY_STUDIO_ENABLED='true';process.env.STORY_TEXT_MODEL='owner/model';process.env.STORY_ENGLISH_VOICE_ID='english';
 const settings={allowProviderCharges:true,vercelEnabled:true,vercelApiKey:'configured',api888Enabled:true,api888ApiKey:'configured',vgenvEnabled:true,vgenvApiKey:'configured',vibiEnabled:true,vibiApiKey:'configured'};
 let id='gpt-image-2.6',response;
 const d={requireUser:async()=>({id:9}),settings:async()=>settings,access:async()=>({vercel:true,api888:true,vgenv:true,vibi:true}),imageModel:async()=>({provider:'api888',providerModelId:id,enabled:true,available:true,ready:true}),tierQuotes:async(user,imageModel)=>{assert.equal(user.id,9);assert.match(imageModel,/api888_gpt/);return tierQuotes({imageModel,quoteVideo:async()=>10,quoteImage:async()=>2,quoteNarration:async()=>5});},json:(res,status,body)=>{response=body;}};
 try{
  const studio=createStoryStudio(d);await studio.handle({method:'GET',headers:{}},{},null,'/api/stories/config');
  assert.equal(response.ready,true);assert.deepEqual(response.tiers.map(t=>t.duration),[120,180,300]);
  id='gemini-3-pro-image-preview';await assert.rejects(studio.preflight({id:9}),/GPT image model/);
 }finally{keys.forEach((key,i)=>{if(old[i]===undefined)delete process.env[key];else process.env[key]=old[i];});}
});

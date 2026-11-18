'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validatePlan,planStory}=require('../src/story_plan'),{advance}=require('../src/story_engine');
const store=require('../src/story_store'),{createStoryStudio}=require('../src/story_studio');
const {clipArgs}=require('../src/story_render');
const plan=()=>({title:'The lighthouse',synopsis:'A keeper finds a message and brings a lost sailor home.',characters:[{name:'Adam',description:'A weathered keeper in a navy coat, short gray hair.'}],scenes:Array.from({length:8},()=>({prompt:'Adam walks to the lighthouse in the rain.',narration:'The old keeper crossed the quiet shore, following a distant light that nobody else in the village could see.'}))});
test('planner enforces eight timed English narration scenes and bounded character metadata',async()=>{
 assert.equal(validatePlan(plan()).scenes.reduce((n,s)=>n+s.duration,0),120);
 for(const broken of [{...plan(),characters:[]},{...plan(),scenes:plan().scenes.slice(1)},{...plan(),scenes:plan().scenes.map(s=>({...s,narration:'Too short'}))},{...plan(),title:'x'.repeat(151)}])assert.throws(()=>validatePlan(broken));
 let calls=0;const p=await planStory({request:async(path,options)=>{calls++;assert.equal(path,'/v1/chat/completions');assert.equal(options.body.response_format.type,'json_object');return {choices:[{message:{content:JSON.stringify(plan())}}]};}},'owner/model','A lighthouse story');
 assert.equal(p.characters.length,1);assert.equal(calls,1);
 await assert.rejects(planStory({request:async()=>({choices:[]})},'owner/model','x'),/valid JSON/);
});
test('full workflow checkpoints, resumes and assembles exactly once without resubmitting completed children',async()=>{
 let state={},assembled=0;const rows=new Map(),calls=[];
 const create=(kind)=>async(...args)=>{const ctx=args.at(-1);assert.equal(ctx.storyId,'story');calls.push(ctx.stepKey);rows.set(ctx.stepKey,{id:ctx.stepKey,status:'completed'});};
 const deps={save:async s=>{state=JSON.parse(JSON.stringify(s));},plan:async()=>plan(),find:async k=>rows.get(k),image:create('image'),voice:create('voice'),video:create('video'),assemble:async clips=>{assert.equal(clips.length,8);assert.deepEqual(clips.map(c=>c.video.id),Array.from({length:8},(_,i)=>'scene'+i));assembled++;}};
 for(let i=0;i<19;i++){await advance({id:'story',prompt:'test',state},deps);if(state.stage==='completed')break;}
 assert.equal(calls.length,17);assert.equal(new Set(calls).size,17);assert.equal(assembled,1);assert.equal(state.stage,'completed');
});
test('interrupted story writer and failed generation never auto-submit replacements',async()=>{
 await assert.rejects(advance({state:{planningStarted:true}},{}),/interrupted/);
 let created=0;const state={plan:validatePlan(plan())};
 await assert.rejects(advance({id:'x',state},{save:async()=>{},find:async()=>({status:'submit_error'}),image:async()=>created++}),/failed/);
 assert.equal(created,0);assert.equal(state.failedStep,'character0');
});
test('transactional story hooks replay committed children, enforce ownership and cap actual charged credits',async()=>{
 const generation={id:'existing',credits_cost:3};let inserted=0;
 const conn={execute:async(sql,args)=>{
  if(sql.includes('SELECT * FROM stories'))return [[{status:'running'}]];
  if(sql.includes('SELECT generation_id'))return [[{generation_id:generation.id}]];
  if(sql.includes('SELECT * FROM generations'))return [[generation]];
  if(sql.includes('SELECT options_json'))return [[{options_json:'{"maxCredits":10}'}]];
  if(sql.includes(' AS spent'))return [[{spent:8}]];
  if(sql.includes('SELECT credits_cost'))return [[generation]];
  if(sql.startsWith('INSERT')){inserted++;return [{}];}throw Error(sql);
 }};
 assert.equal((await store.beginStep(conn,7,{storyId:'x',stepKey:'scene0'})).id,'existing');
 await assert.rejects(store.completeStep(conn,7,{storyId:'x',stepKey:'scene0'},'new'),/credit limit/);assert.equal(inserted,0);
 generation.credits_cost=2;await store.completeStep(conn,7,{storyId:'x',stepKey:'scene0'},'new');assert.equal(inserted,1);
 await assert.rejects(store.beginStep({execute:async()=>[[]]},99,{storyId:'other'}),/not running/);
});
test('story routes authenticate first, reject cross-origin mutations and scope reads to the customer',async()=>{
 const previous=process.env.STORY_STUDIO_ENABLED;process.env.STORY_STUDIO_ENABLED='true';
 try{
  const d={requireUser:async()=>({id:44}),publicOrigin:()=> 'https://cmmtools.site',db:()=>({execute:async(sql,args)=>{assert.deepEqual(args,['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',44]);return [[]];}})};
  const studio=createStoryStudio(d),path='/api/stories/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await assert.rejects(studio.handle({method:'POST',headers:{'x-cmm-story':'1',origin:'https://evil.test'}},{},null,path+'/retry'),e=>e.statusCode===403);
  await assert.rejects(studio.handle({method:'GET',headers:{}},{},null,path),e=>e.statusCode===404);
  d.requireUser=async()=>{throw Object.assign(Error('Sign in'),{statusCode:401});};await assert.rejects(studio.handle({},{},null,path),e=>e.statusCode===401);
 }finally{if(previous===undefined)delete process.env.STORY_STUDIO_ENABLED;else process.env.STORY_STUDIO_ENABLED=previous;}
});
test('renderer uses English narration only, fixed scene duration and normalized video geometry',()=>{
 const args=clipArgs('clip.mp4','voice.mp3','final.mp4','9:16');assert.ok(args.includes('1:a:0'));assert.ok(args.includes('0:v:0'));assert.equal(args[args.indexOf('-t')+1],'15');assert.match(args[args.indexOf('-vf')+1],/scale=768:1366/);assert.equal(args.at(-1),'final.mp4');
});
test('voice story replay does not debit again and a late budget failure rolls back its transaction',async()=>{
 const db=require('../src/db'),customer=require('../src/customer_api_store');
 const original=db.getPool,begin=customer.beginRequest,complete=customer.completeRequest;
 let commits=0,rollbacks=0,debits=0;
 const conn={beginTransaction:async()=>{},commit:async()=>commits++,rollback:async()=>rollbacks++,release:()=>{},execute:async sql=>{
  if(sql.startsWith('SELECT id,credits'))return [[{id:7,status:'active',credits:10000,plan_code:null,price_rate:1}]];
  if(sql.includes('COUNT(*)'))return [[{total:0}]];
  if(sql.startsWith('UPDATE users'))debits++;
  return [{}];
 }};
 db.getPool=()=>({getConnection:async()=>conn});
 try{
  const {createVoiceGenerationForUser}=require('../src/voice_generations');
  customer.beginRequest=async()=>({id:'saved',status:'completed',credits_cost:3});
  const replay=await createVoiceGenerationForUser(7,{text:'An English story.'},{costOverride:3,apiRequest:{storyId:'story'}});
  assert.equal(replay.id,'saved');assert.equal(debits,0);assert.equal(commits,1);
  customer.beginRequest=async()=>null;customer.completeRequest=async()=>{throw Error('Story credit limit reached.');};
  await assert.rejects(createVoiceGenerationForUser(7,{text:'An English story.'},{costOverride:3,apiRequest:{storyId:'story'}}),/credit limit/);
  assert.equal(rollbacks,1);assert.equal(commits,1);
 }finally{db.getPool=original;customer.beginRequest=begin;customer.completeRequest=complete;}
});
test('assembled output streams to configured cloud storage with verified hashes instead of MySQL media writes',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
 const storage=require('../src/object_storage'),original=storage.configuredStorage;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'story-cloud-test-')),file=path.join(dir,'out.mp4'),data=Buffer.from('synthetic rendered output');let uploads=0;
 await fs.writeFile(file,data);
 storage.configuredStorage=async()=>({putStream:async(key,output,mime)=>{
  uploads++;assert.equal(key,'stories/test-story/final.mp4');assert.equal(mime,'video/mp4');assert.equal(output.size,data.length);
  const chunks=[];for await(const b of output.openStream())chunks.push(b);assert.deepEqual(Buffer.concat(chunks),data);
  assert.equal(output.md5,crypto.createHash('md5').update(data).digest('hex'));assert.equal(output.sha256,crypto.createHash('sha256').update(data).digest('hex'));
 }});
 try{assert.equal(await require('../src/story_media').publish({getConnection:()=>{throw Error('No MySQL media write expected');}},'test-story',file),'r2:stories/test-story/final.mp4');assert.equal(uploads,1);}
 finally{storage.configuredStorage=original;await fs.rm(dir,{recursive:true,force:true});}
});

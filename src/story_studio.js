'use strict';
const store=require('./story_store'),{advance}=require('./story_engine');
const {planStory}=require('./story_plan'),render=require('./story_render'),media=require('./story_media');
const {hideVendors}=require('./vendor_names');
const enabled=()=>/^(true|1)$/i.test(process.env.STORY_STUDIO_ENABLED||'');
function config(){return {textModel:String(process.env.STORY_TEXT_MODEL||''),imageModel:require('./story_tiers').DEFAULT_IMAGE_MODEL,voiceId:String(process.env.STORY_ENGLISH_VOICE_ID||''),voiceModel:String(process.env.STORY_VOICE_MODEL||'eleven_multilingual_v2')};}
function createStoryStudio(d){
 let busy=false,timer;
 async function preflight(user,imageId=null){
  const c=config();if(imageId)c.imageModel=imageId;const s=await d.settings(),access=await d.access(user.id,s);
  if(!enabled()||!c.textModel||!c.voiceId)throw store.fail(503,'Story Studio needs a configured story writer and English voice.');
  if(!s.allowProviderCharges)throw store.fail(503,'Generation submissions are paused.');
  if(!access.vercel||!s.vercelEnabled||!s.vercelApiKey||!access.api888||!s.api888Enabled||!s.api888ApiKey||!access.vgenv||!s.vgenvEnabled||!s.vgenvApiKey||!access.vibi||!s.vibiEnabled||!s.vibiApiKey)throw store.fail(503,'A required story service is unavailable for this account.');
  const model=await d.imageModel(c.imageModel);if(!model?.ready||!model.enabled||!model.available)throw store.fail(503,'The configured story image model must be imported and enabled.');
  if(model.provider!=='api888'||!/^gpt-image-/.test(String(model.providerModelId||'')))throw store.fail(503,'Story character images require a ready 888API GPT image model.');
  return {c,s};
 }
 async function view(row){
  const state=JSON.parse(row.state_json),options=JSON.parse(row.options_json);delete options.maxCredits;
  const [steps]=await d.db().execute('SELECT s.step_key,g.id,g.status,g.credits_cost,g.refunded_at FROM story_steps s JOIN generations g ON g.id=s.generation_id WHERE s.story_id=?',[row.id]);
  return {id:row.id,prompt:row.prompt,status:row.status,error:row.error_message,stage:state.stage||'storyline',plan:state.plan||null,options,steps,createdAt:row.created_at,videoUrl:row.status==='completed'?'/api/stories/'+row.id+'/media':null};
 }
 async function tick(){
  if(busy||!enabled()||!d.workerEnabled())return;busy=true;let lock;
  try{
   lock=await d.db().getConnection();const [[result]]=await lock.query("SELECT GET_LOCK('cmm_story_studio',0) AS acquired");if(Number(result.acquired)!==1)return;
   const [[row]]=await d.db().query("SELECT * FROM stories WHERE status IN ('queued','running') ORDER BY updated_at LIMIT 1");if(!row)return;
   const state=JSON.parse(row.state_json),options=JSON.parse(row.options_json);
   const save=async(value,completed=false)=>{await d.db().execute("UPDATE stories SET state_json=?,status=IF(status='cancelled',status,?),updated_at=UTC_TIMESTAMP() WHERE id=?",[JSON.stringify(value),completed?'completed':'running',row.id]);};
   try{
    const [[user]]=await d.db().execute('SELECT * FROM users WHERE id=?',[row.user_id]);if(user?.status!=='active')throw new Error('Story account is unavailable.');
    const {c,s}=await preflight(user,options.imageModel||'api888_gpt_image_2_1k');
    await d.db().execute("UPDATE stories SET status='running',error_message=NULL WHERE id=? AND status='queued'",[row.id]);
    await advance({id:row.id,prompt:row.prompt,state,options},{save,
     plan:(prompt,duration)=>planStory(new (require('./provider/vercel').VercelGatewayClient)({apiKey:s.vercelApiKey}),c.textModel,prompt,duration),
     find:async key=>{const [[g]]=await d.db().execute('SELECT g.* FROM story_steps x JOIN generations g ON g.id=x.generation_id WHERE x.story_id=? AND x.step_key=? AND g.user_id=?',[row.id,key,user.id]);return g;},
     image:(character,ctx)=>d.image(user,{model:c.imageModel,prompt:'Cinematic character reference portrait, one character, plain background, no text. '+character.name+'. '+character.description,aspectRatio:'1:1'},ctx),
     voice:(text,ctx)=>d.voice(user,text,c,ctx),
     video:async(scene,characters,descriptions,ctx)=>{
      const images=[];for(const character of characters){
       const [[image]]=await d.db().execute('SELECT mime_type,image_data FROM generation_image_outputs WHERE generation_id=?',[character.id]);if(!image)throw new Error('A saved character image is missing.');
       await require('./object_storage').hydrateBlobs(image,'image_data');images.push({filename:'character'+images.length+'.png',mimeType:image.mime_type,data:image.image_data});
      }
      const identity=descriptions.map((ch,i)=>`@Image${i+1} is ${ch.name}: ${ch.description}`).join('\n');
      return d.video(user,{model:require('./story_tiers').VIDEO_MODEL,duration:15,resolution:'768p',aspectRatio:options.aspectRatio,prompt:identity+'\n'+scene.prompt+'\nKeep faces, outfits and character identities consistent. No subtitles or dialogue. The final video has separate English narration.',images},ctx);
     },
     assemble:(clips,duration)=>render.assemble({scenes:clips,duration,ratio:options.aspectRatio,download:(r,f)=>media.download(d.db(),r,f),publish:(f,seconds)=>media.publish(d.db(),row.id,f,seconds)})
    });
   }catch(e){
    if(e.statusCode===429)return;
    // Never auto-replay a failed paid stage. A customer explicitly resumes it.
    await d.db().execute("UPDATE stories SET status=IF(status='cancelled',status,'failed'),state_json=?,error_message=? WHERE id=?",[JSON.stringify(state),hideVendors(e.message).slice(0,500),row.id]);
   }
  }catch(e){console.error('[story-studio]',e.code||e.message);}finally{
   if(lock){await lock.query("SELECT RELEASE_LOCK('cmm_story_studio')").catch(()=>{});lock.release();}busy=false;
  }
 }
 async function handle(req,res,url,route){
  if(!route.startsWith('/api/stories'))return false;
  const user=await d.requireUser(req);
  if(!['GET','HEAD'].includes(req.method)){
   if(req.headers['x-cmm-story']!=='1'||(req.headers.origin&&req.headers.origin!==d.publicOrigin(req)))throw store.fail(403,'Open Story Studio to make this request.');
  }
  const match=route.match(/^\/api\/stories\/([0-9a-f-]{36})(?:\/(media|retry|cancel))?$/i);
  if(route==='/api/stories/config'&&req.method==='GET'){
   let tiers=[],pricingError=null,setupError=null;
   try{tiers=await d.tierQuotes(user,config().imageModel);}catch(e){pricingError=hideVendors(e.message);}
   try{await preflight(user);}catch(e){setupError=hideVendors(e.message);}
   d.json(res,200,{ok:true,ready:!setupError&&!pricingError,language:'English',tiers,
    error:setupError||pricingError,pricingError});return true;
  }
  if(!enabled())throw store.fail(503,'Story Studio is not enabled yet.');
  if(route==='/api/stories'&&req.method==='POST'){
   const {c}=await preflight(user);const body=await d.readJson(req);const tier=require('./story_tiers').storyTier(body.tier);const quote=(await d.tierQuotes(user,c.imageModel)).find(t=>t.id===tier.id);const row=await store.create(d.db(),user.id,body,quote);d.wake?.();d.json(res,201,{ok:true,story:await view(row)});return true;
  }
  if(route==='/api/stories'&&req.method==='GET'){
   const [rows]=await d.db().execute('SELECT * FROM stories WHERE user_id=? ORDER BY created_at DESC LIMIT 30',[user.id]);d.json(res,200,{ok:true,stories:await Promise.all(rows.map(view))});return true;
  }
  if(!match)throw store.fail(404,'Story endpoint not found.');
  const row=await store.get(d.db(),user.id,match[1]);if(!row)throw store.fail(404,'Story not found.');
  if(match[2]==='media'&&['GET','HEAD'].includes(req.method)){if(row.status!=='completed')throw store.fail(409,'Story is not complete.');await media.serve(d.db(),req,res,row.id,JSON.parse(row.state_json).output);return true;}
  if(match[2]==='cancel'&&req.method==='POST'){
   await d.db().execute("UPDATE stories SET status='cancelled' WHERE id=? AND user_id=? AND status IN ('queued','running','failed')",[row.id,user.id]);
  }else if(match[2]==='retry'&&req.method==='POST'){
   // Serialize with generation debits by locking the user before the story.
   const conn=await d.db().getConnection();try{
    await conn.beginTransaction();await conn.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[user.id]);
    const [[fresh]]=await conn.execute('SELECT * FROM stories WHERE id=? AND user_id=? FOR UPDATE',[row.id,user.id]);if(fresh.status!=='failed')throw store.fail(409,'Only failed stories can be resumed.');
    const [[active]]=await conn.execute("SELECT id FROM stories WHERE user_id=? AND id<>? AND status IN ('queued','running')",[user.id,row.id]);if(active)throw store.fail(409,'Another story is running.');
    const state=JSON.parse(fresh.state_json),body=await d.readJson(req),options=JSON.parse(fresh.options_json);
    if(Object.hasOwn(body,'maxCredits'))throw store.fail(400,'A credit limit is not used for story tiers.');
    delete options.maxCredits;
    if(state.failedStep){
     const [[g]]=await conn.execute('SELECT g.* FROM story_steps s JOIN generations g ON g.id=s.generation_id WHERE s.story_id=? AND s.step_key=?',[row.id,state.failedStep]);
     if(g&&!(g.status==='failed'&&g.refunded_at))throw store.fail(409,'Provider submission needs an Admin review before it can be regenerated.');
     await conn.execute('DELETE FROM story_steps WHERE story_id=? AND step_key=?',[row.id,state.failedStep]);delete state.failedStep;
    }
    state.planningStarted=false;
    await conn.execute("UPDATE stories SET status='queued',error_message=NULL,state_json=?,options_json=? WHERE id=?",[JSON.stringify(state),JSON.stringify(options),row.id]);await conn.commit();
   }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  }else if(!(req.method==='GET'&&!match[2]))throw store.fail(405,'Method not allowed.');
  if(match[2]==='retry')d.wake?.();
  d.json(res,200,{ok:true,story:await view(await store.get(d.db(),user.id,row.id))});return true;
 }
 async function start(){
  if(!enabled())return;for(const sql of store.SCHEMA)await require('./db').ensureSchemaTable(d.db(),sql);
  if(d.workerEnabled()){timer=setInterval(tick,10000);timer.unref();tick();}
 }
 async function hasActive(){if(!enabled())return false;const [[row]]=await d.db().query("SELECT 1 AS active FROM stories WHERE status IN ('queued','running') LIMIT 1");return Boolean(row);}
 return {handle,start,tick,hasActive,stop:()=>clearInterval(timer),preflight};
}
module.exports={createStoryStudio,enabled,config};

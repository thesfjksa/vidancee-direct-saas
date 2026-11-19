'use strict';
const C=require('./voice_contract'),S=require('./voice_studio_store'),U=require('./voice_upload');
const {vibiToCustomerCredits,voiceCreditsPerPkr,VIBI_CREDITS_PER_PKR}=require('./billing');
const DUB_LANGUAGES=new Set('af ar hy as az be bn bs bg ca ceb ny zh hr cs da nl en et fil fi fr gl ka de el gu ha he hi hu is id ga it ja jv kn kk ky ko lv ln lt lb mk ms ml mr ne no ps fa pl pt pa ro ru sr sd sk sl so es sw sv ta te th tr uk ur vi cy nn yue'.split(' '));
const MODES=new Set(['speech','dialogue','voice-changer','dubbing','clone-speech']);

function voiceCatalogEntry(raw,language=''){
 const v=raw&&typeof raw==='object'?raw:{};
 const labels=v.labels&&typeof v.labels==='object'&&!Array.isArray(v.labels)?v.labels:{};
 const meta=v.metadata&&typeof v.metadata==='object'&&!Array.isArray(v.metadata)?v.metadata:{};
 const str=(...items)=>{for(const item of items)if(typeof item==='string'&&item.trim())return item.trim().slice(0,500);return null;};
 const languageEntries=[...[
    v.languages,v.verified_languages,v.language_codes,v.language_ids,
    meta.languages,labels.languages
  ].filter(Array.isArray).flat()];
 const languages=[...new Set(languageEntries.map(l=>typeof l==='string'?l:str(l?.code,l?.language_id,l?.language_code,l?.name)).filter(Boolean))].slice(0,100);
 const count=Number(v.usage_count??v.use_count??v.play_count??v.stats?.usage_count);

 const id=str(v.voice_id,v.id);
 // Vibi can supply alternate preview shapes. Preserve signed URLs without truncating.
 const previewCandidates=[v.preview_url,v.previewUrl,v.preview_audio_url,v.preview_audio,
  v.sample_url,v.sample_audio_url,v.audio_preview_url,v.preview?.url,v.preview?.audio_url,
  v.samples?.[0]?.preview_url,v.samples?.[0]?.audio_url];
 const preview=previewCandidates.find(value=>typeof value==='string'&&value.trim());
 const previewUrl=preview&&preview.length<=4096?preview.trim():null;
 return {id,name:str(v.name,v.voice_name)||'Voice',previewUrl:previewUrl?'/api/voice-preview/'+encodeURIComponent(id)+(language?'?language='+encodeURIComponent(language):''):null,
  description:str(v.description,v.voice_description,meta.description),
  accent:str(v.accent,labels.accent,meta.accent),
  quality:str(v.quality,labels.quality,meta.quality),
  gender:str(v.gender,labels.gender,meta.gender),
  age:str(v.age,labels.age,meta.age),
  category:str(v.category,labels.category,meta.category),
  language:str(v.language,v.language_code,v.language_name,labels.language,labels.locale,meta.language),
  languages,
  usageCount:Number.isFinite(count)&&count>=0?count:null};
}

// Native-language discovery is distinct from multilingual speech synthesis.
// Do not present generic default voices as native speakers of every selected language.
function voiceNativeLanguageMatch(voice,code,name){
 if(!code)return true;
 const tokens=[voice.language,...(voice.languages||[])].filter(x=>typeof x==='string').map(x=>x.toLowerCase().trim());
 const wanted=[code.toLowerCase(),name.toLowerCase()];
 return tokens.some(tag=>wanted.some(value=>value&&
  (tag===value||tag.startsWith(value+'-')||tag.startsWith(value+'_'))));
}

function createVoiceStudio(d){
 const readUpload=d.readUpload||U.readUpload,probe=d.probe||U.probe;
 let cache=null;
 const pickerCache=new Map(),previewCache=new Map();
 function voiceListData(data){
   const list=Array.isArray(data)?data:(data?.voices||data?.shared_voices||data?.data?.voices||data?.results||data?.items||[]);
   return Array.isArray(list)?list:[];
 }
 async function loadPicker(user,client,{language='',search='',mode='library',page=0}={}){
   const key=[user.id,language,search,mode,page].join('|'),prior=pickerCache.get(key);
   if(prior&&prior.until>Date.now())return prior.value;
   let raw=[],source='default',reason='',hasMore=false;
   if(mode!=='defaults'){
     if(typeof client.getSharedVoices==='function'){
       try{
         const data=await client.getSharedVoices({language,search,page,pageSize:40,timeoutMs:5000});
         if(!Array.isArray(data)&&!Array.isArray(data?.voices)&&!Array.isArray(data?.shared_voices)&&
            !Array.isArray(data?.data?.voices)&&!Array.isArray(data?.results)&&!Array.isArray(data?.items))
           throw C.fail(502,'The Vibi gateway did not return a shared-voice catalog.');
         raw=voiceListData(data);source='shared';
         hasMore=Boolean(data?.has_more??data?.hasMore);
       }catch(e){
         if(e.statusCode===401)throw e;
         reason='Vibi did not provide a usable shared-voice listing; showing available default voices.';
       }
     }else reason='This Vibi gateway has no shared-voice catalogue method.';
   }
   if(source!=='shared'||mode==='defaults'){
     const term=search||((language&&mode!=='defaults')?({
       ur:'Urdu',hi:'Hindi',ar:'Arabic',bn:'Bengali',fa:'Persian',pa:'Punjabi'
     }[language]||language):'');
     try{
       const data=await client.getDefaultVoices({pageSize:100,search:term,timeoutMs:5500});
       raw=voiceListData(data);source='default';
     }catch(e){
       if(e.statusCode===401)throw e;
       source='unavailable';raw=[];
       reason=(reason?reason+' ':'')+'The Vibi voice catalog did not respond in time. Retry the search.';
     }
   }
   const langName=({ur:'Urdu',hi:'Hindi',ar:'Arabic',bn:'Bengali',fa:'Persian',pa:'Punjabi'})[language]||language;
   let voices=raw.map(v=>voiceCatalogEntry(v,language)).filter(v=>v.id);
   if(language&&mode!=='defaults'&&source==='default')voices=voices.filter(v=>voiceNativeLanguageMatch(v,language,langName));
   // Shared-voice endpoint is already language-filtered by the provider.
   const result={voices,source,reason,hasMore,page};
   if(pickerCache.size>150)pickerCache.clear();
   if(source!=='unavailable')pickerCache.set(key,{value:result,until:Date.now()+40000});
   for(const entry of voices){
     const original=raw.find(v=>String(v.voice_id||v.id||'')===entry.id);
     const preview=[original?.preview_url,original?.previewUrl,original?.preview_audio_url,
       original?.preview_audio,original?.sample_url,original?.sample_audio_url,
       original?.audio_preview_url,original?.preview?.url,original?.preview?.audio_url,
       original?.samples?.[0]?.preview_url,original?.samples?.[0]?.audio_url].find(x=>typeof x==='string'&&x.length>0);
     if(preview&&preview.length<=4096){
       if(previewCache.size>1000)previewCache.clear();
       previewCache.set(user.id+':'+entry.id,{url:preview,until:Date.now()+300000});
     }
   }
   return result;
 }
 async function services(user,paid=false){
  const [settings,access]=await Promise.all([d.settings(),d.access(user.id)]);
  if(!access.vibi||!settings.vibiEnabled||!settings.vibiApiKey)throw C.fail(503,'Voice Studio is currently unavailable.');
  if(paid&&!settings.allowProviderCharges)throw C.fail(503,'Generation submissions are currently paused.');
  return {settings,client:d.client(settings)};
 }
 async function catalog(client,settings){
  const key=require('node:crypto').createHash('sha256').update(settings.vibiApiKey+'|'+settings.vibiBaseUrl).digest('hex');
  if(cache?.key===key&&cache.until>Date.now())return cache.value;
  const [models,remote]=await Promise.all([client.getModels(),client.getLanguages()]);let model=null,modelError=null;
  try{model=C.fixedModel(models);}catch(e){modelError=e.message;}
  const value={model,modelError,languages:C.languages(remote),speechLanguages:C.languages(remote,model)};
  cache={key,until:Date.now()+60000,value};return value;
 }
 function mutation(req){
  if(req.headers['x-cmm-voice']!=='1')throw C.fail(403,'Refresh Voice Studio before submitting.');
  if(req.headers['sec-fetch-site']==='cross-site')throw C.fail(403,'Use Voice Studio on this site.');
  const origin=typeof d.origin==='function'?d.origin(req):d.origin;
  if(req.headers.origin&&req.headers.origin!==origin)throw C.fail(403,'Use Voice Studio on this site.');
 }
 async function body(req){
  if(!/^multipart\/form-data/i.test(req.headers['content-type']||''))return d.readJson(req);
  const raw=await readUpload(req);let value;
  try{value=JSON.parse(raw.payload);}catch{throw C.fail(400,'Invalid voice upload settings.');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw C.fail(400,'Invalid voice upload settings.');
  return {...value,sample:raw.sample};
 }
 async function prepare(user,input,{client,settings}){
  const operation=String(input.operation||'speech');if(!MODES.has(operation))throw C.fail(400,'Choose a supported voice tool.');
  let params={operation},prompt,source,modelLabel;
  if(operation==='speech'||operation==='dialogue'){
   const c=await catalog(client,settings);if(!c.model)throw C.fail(503,c.modelError);
   if(operation==='speech'){
    const s=C.speech(input,c.model,c.speechLanguages);prompt=s.text;params={...params,...s};source=C.sourceCost(operation,{characters:prompt.length,factor:c.model.factor});
   }else{
    const dialogue=C.dialogue(input,c.model,c.speechLanguages);prompt=dialogue.text;source=C.sourceCost(operation,{characters:dialogue.characters,factor:c.model.factor});delete dialogue.characters;params.dialogue=dialogue;
   }
   modelLabel=operation==='dialogue'?'Eleven v4 dialogue':'Eleven v4';
  }else if(operation==='clone-speech'){
   const [[clone]]=await d.db().execute("SELECT * FROM user_voice_clones WHERE id=? AND user_id=? AND provider='vibi' AND status='done'",[Number(input.cloneId)||0,user.id]);
   if(!clone?.provider_clone_id)throw C.fail(404,'Choose one of your completed cloned voices.');
   const [models,remote]=await Promise.all([client.getModels('minimax'),client.getLanguages('minimax')]);
   const model=models.find(m=>(m.model_id||m.id)==='speech-2.8-hd');if(!model)throw C.fail(503,'The clone speech model is unavailable.');
   const factor=Number(model.credit_ratio??1);if(!Number.isFinite(factor)||factor<=0)throw C.fail(503,'Clone speech pricing is unavailable.');
   const languageCode=String(input.languageCode||'English');if(!remote.some(l=>l.code===languageCode))throw C.fail(400,'Choose a supported clone language.');
   prompt=C.text(input.text,10000);params={...params,provider:'minimax',modelId:'speech-2.8-hd',voiceId:clone.provider_clone_id,languageCode,voiceSettings:{speed:C.number(input.speed,1,.5,2,'Speed'),pitch:C.number(input.pitch,0,-12,12,'Pitch'),vol:1}};
   source=C.sourceCost(operation,{characters:prompt.length,factor});modelLabel='Cloned voice · '+clone.voice_name;
  }else{
   const file=input.sample;if(!Buffer.isBuffer(file?.data)||!file.data.length)throw C.fail(400,'Upload a media file.');
   if(file.data.length>(operation==='voice-changer'?50:100)*1024*1024)throw C.fail(413,'This file exceeds the tool upload limit.');
   if(operation==='voice-changer'&&!file.mimeType.startsWith('audio/'))throw C.fail(400,'Voice changer requires an audio file.');
   const info=await probe(file);source=C.sourceCost(operation,info);
   params={...params,voiceId:C.id(input.voiceId),file:{filename:file.filename,mimeType:file.mimeType},sourceDuration:info.duration,outputKind:operation==='dubbing'&&info.video?'video':'audio'};
   if(operation==='voice-changer'){
    params.voiceSettings=C.voiceSettings(input,{speed:false,similarity:true,style:true,speakerBoost:true});
    if(input.removeNoise!==undefined&&typeof input.removeNoise!=='boolean')throw C.fail(400,'Noise reduction must be on or off.');params.removeNoise=input.removeNoise===true;modelLabel='Voice changer';
   }else{
    const c=await catalog(client,settings),list=c.languages.filter(l=>DUB_LANGUAGES.has(l.code));
    params.sourceLanguage=C.language(input.sourceLanguage,list);params.targetLanguage=C.language(input.targetLanguage,list);
    if(params.sourceLanguage===params.targetLanguage)throw C.fail(400,'Choose a different target language for dubbing.');
    modelLabel='Dubbing · '+params.targetLanguage;
   }
   prompt=(operation==='dubbing'?'Dub: ':'Change voice: ')+file.filename;
  }
  return {operation,params,prompt,source,modelLabel,inputFile:['voice-changer','dubbing'].includes(operation)?input.sample:null};
 }
 async function clone(user,req,service){
  const raw=await readUpload(req,{maxBytes:20*1024*1024,allowVideo:false});
  const name=C.text(raw.voice_name,80),info=await probe(raw.sample);
  if(info.duration<10||info.duration>300)throw C.fail(400,'Use a voice sample lasting 10 seconds to 5 minutes.');
  const [langs]=await Promise.all([service.client.getLanguages('minimax')]);
  const languageTag=String(raw.language_tag||'English');if(!langs.some(l=>l.code===languageTag))throw C.fail(400,'Choose a supported clone language.');
  const gender=String(raw.gender||'Male');if(!['Male','Female'].includes(gender))throw C.fail(400,'Choose a supported gender.');
  const preview=String(raw.preview_text||'Hello').slice(0,200),context=S.request(raw.requestKey,raw),conn=await d.db().getConnection();let result;
  try{
   await conn.beginTransaction();const [[fresh]]=await conn.execute('SELECT credits,price_rate,plan_code,status FROM users WHERE id=? FOR UPDATE',[user.id]);
   if(fresh?.status!=='active')throw C.fail(403,'Account unavailable.');
   const receipt=await S.receipt(conn,user.id,context);
   if(receipt){const [[old]]=await conn.execute('SELECT id,voice_name,status FROM user_voice_clones WHERE id=? AND user_id=?',[receipt.clone_id,user.id]);if(!old)throw C.fail(409,'The original clone request was removed.');await conn.commit();return old;}
   const base=Number(service.settings.vibiCloneSourceCost??0);if(!Number.isFinite(base)||base<0)throw C.fail(503,'Voice clone pricing is unavailable.');
   const cost=vibiToCustomerCredits(base,voiceCreditsPerPkr({...user,...fresh}));if(Number(fresh.credits)<cost)throw C.fail(402,'Not enough credits.');
   const [insert]=await conn.execute("INSERT INTO user_voice_clones (user_id,provider,voice_name,language_tag,gender,preview_text,status,credits_cost,sample_filename,sample_mime_type,sample_data) VALUES (?,'vibi',?,?,?,?,'queued',?,?,?,?)",[user.id,name,languageTag,gender,preview,cost,raw.sample.filename,raw.sample.mimeType,raw.sample.data]);
   if(cost){await conn.execute('UPDATE users SET credits=credits-? WHERE id=?',[cost,user.id]);await conn.execute("INSERT INTO credit_transactions (user_id,generation_id,amount,type,note) VALUES (?,NULL,?,'voice_clone_debit',?)",[user.id,-cost,'Reserved for voice cloning']);}
   await S.saveRequest(conn,user.id,context,{cloneId:insert.insertId});await conn.commit();result={id:Number(insert.insertId),voice_name:name,status:'queued'};
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  d.wake(req);return result;
 }
 async function handle(req,res,url,route){
  if(!route.startsWith('/api/voice-'))return false;
  d.requireDatabase();const user=await d.requireUser(req);
  if(req.method!=='GET')mutation(req);
  if(req.method==='GET'&&route==='/api/voice-generations'){d.json(res,200,{ok:true,generations:await d.list(user.id,60)});return true;}
  if(req.method==='GET'&&route==='/api/voice-clones'){
   const [rows]=await d.db().execute("SELECT id,voice_name,language_tag,gender,status,sample_audio_url,error_message,created_at FROM user_voice_clones WHERE user_id=? AND provider='vibi' ORDER BY created_at DESC",[user.id]);
   d.json(res,200,{ok:true,clones:rows.map(r=>({...r,id:Number(r.id)}))});return true;
  }
  const media=route.match(/^\/api\/voice-generations\/([0-9a-f-]{36})\/media$/i);
  if(req.method==='GET'&&media){const row=await d.get(user.id,media[1]);if(!row)throw C.fail(404,'Voice generation not found.');await d.media(req,res,row);return true;}
  const del=route.match(/^\/api\/voice-generations\/([0-9a-f-]{36})(?:\/delete)?$/i);
  if(del&&['DELETE','POST'].includes(req.method)){await d.remove(user.id,del[1]);d.json(res,200,{ok:true,deleted:true,id:del[1]});return true;}

  if(req.method==='GET'&&route==='/api/voice-library'){
    const service=await services(user),language=String(url.searchParams.get('language')||'').trim().slice(0,20);
    if(language&&!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language))throw C.fail(400,'Invalid language code.');
    const search=String(url.searchParams.get('search')||'').trim().slice(0,100);
    const mode=url.searchParams.get('mode')==='defaults'?'defaults':'library';
    const page=Math.max(0,Math.min(50,Number(url.searchParams.get('page')||0)||0));
    const found=await loadPicker(user,service.client,{language,search,mode,page});
    d.json(res,200,{ok:true,...found,language,mode});
    return true;
  }
  const previewRoute=route.match(/^\/api\/voice-preview\/([a-zA-Z0-9_-]{1,128})$/);
  if(req.method==='GET'&&previewRoute){
    const service=await services(user);
    const id=previewRoute[1];
    let cached=previewCache.get(user.id+':'+id);
    if((!cached||cached.until<=Date.now())&&url?.searchParams?.get('language')){
      const lang=String(url.searchParams.get('language')||'').slice(0,20);
      if(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(lang)){
        // A bookmarked voice may be previewed after the cache expires.
        // Re-resolve by ID in the same language-scoped provider catalog.
        await loadPicker(user,service.client,{language:lang,search:id});
        cached=previewCache.get(user.id+':'+id);
      }
    }
    if(cached&&cached.until>Date.now()){
      const sample=await service.client.downloadVoicePreview(cached.url);
      if(!sample?.data?.length)throw C.fail(502,'Voice preview is empty.');
      res.writeHead(200,{'content-type':sample.contentType,'content-length':sample.data.length,
        'cache-control':'private, max-age=300','x-content-type-options':'nosniff','accept-ranges':'none'});
      res.end(sample.data);return true;
    }
    const language=String(url?.searchParams?.get('language')||'').trim().slice(0,20);
    const remote=await service.client.getDefaultVoices({pageSize:100,language});
    let voices=Array.isArray(remote.voices)?remote.voices:[];
    let voice=voices.find(v=>String(v.voice_id||v.id||'')===id);
    if(!voice){
      const filtered=await service.client.getDefaultVoices({pageSize:100,search:id,language});
      voices=Array.isArray(filtered.voices)?filtered.voices:[];
      voice=voices.find(v=>String(v.voice_id||v.id||'')===id);
    }
    if(!voice)throw C.fail(404,'Voice sample not found.');
    const previewCandidates=[voice.preview_url,voice.previewUrl,voice.preview_audio_url,voice.preview_audio,
      voice.sample_url,voice.sample_audio_url,voice.audio_preview_url,voice.preview?.url,voice.preview?.audio_url,
      voice.samples?.[0]?.preview_url,voice.samples?.[0]?.audio_url];
    const location=previewCandidates.find(v=>typeof v==='string'&&v.trim());
    if(!location)throw C.fail(404,'This voice has no preview audio.');
    const sample=await service.client.downloadVoicePreview(location);
    if(!sample?.data?.length)throw C.fail(502,'Voice preview is empty.');
    res.writeHead(200,{'content-type':sample.contentType,'content-length':sample.data.length,
      'cache-control':'private, max-age=300','x-content-type-options':'nosniff','accept-ranges':'none'});
    res.end(sample.data);
    return true;
  }
  if(!['/api/voice-options','/api/voice-cost','/api/voice-generations','/api/voice-clones'].includes(route))return false;
  const service=await services(user,req.method==='POST'&&route!=='/api/voice-cost');
  if(req.method==='GET'&&route==='/api/voice-options'){
   const [c,cloneLanguages]=await Promise.all([catalog(service.client,service.settings),service.client.getLanguages('minimax')]);
   const search=String(url.searchParams.get('search')||'').trim().slice(0,100);
   const language=String(url.searchParams.get('language')||'').trim().slice(0,20);
   const native=c.speechLanguages.find(l=>l.code===language);
   if(language&&!native)throw C.fail(400,'Choose a language supported by Eleven v4.');
   let voices;
   try{
     voices=await service.client.getDefaultVoices({pageSize:100,search,language});
   }catch(e){
     // Older Vibi catalog endpoints may reject a language query. In that case,
     // search their ordinary default catalog and still verify language labels.
     if(!language||![400,404,422].includes(e.statusCode))throw e;
     voices=await service.client.getDefaultVoices({pageSize:100,search});
   }
   let entries=Array.isArray(voices?.voices)?voices.voices.map(v=>voiceCatalogEntry(v,language)).filter(v=>v.id):[];
   if(language){
     entries=entries.filter(v=>voiceNativeLanguageMatch(v,language,native.name));
     if(!entries.length&&!search){
       // Some Vibi catalogs support only text search, not a language index.
       // Discover additional voice entries by the actual language name.
       try{
         const searched=await service.client.getDefaultVoices({pageSize:100,search:native.name});
         const found=(Array.isArray(searched?.voices)?searched.voices:[]).map(v=>voiceCatalogEntry(v,language))
           .filter(v=>v.id&&voiceNativeLanguageMatch(v,language,native.name));
         entries=[...new Map([...entries,...found].map(v=>[v.id,v])).values()];
       }catch(e){
         if(![400,404,422].includes(e.statusCode))throw e;
       }
     }
   }
   const cloneBase=Number(service.settings.vibiCloneSourceCost??0);
   d.json(res,200,{ok:true,...c,models:c.model?[{model_id:c.model.modelId,name:'Eleven v4'}]:[],cloneLanguages,
    cloneCost:vibiToCustomerCredits(cloneBase,voiceCreditsPerPkr(user)),billing:{policy:'at-cost',vibiCreditsPerPkr:VIBI_CREDITS_PER_PKR,cmmCreditsPerPkr:voiceCreditsPerPkr(user),markup:0},dubbingLanguages:c.languages.filter(l=>DUB_LANGUAGES.has(l.code)),
    voices:entries,voiceCatalogLanguage:language,voiceCatalogLimited:true,
    tools:{speech:!!c.model,dialogue:!!c.model,voiceChanger:true,dubbing:true,cloning:true}});return true;
  }
  if(req.method==='POST'&&route==='/api/voice-clones'){d.json(res,201,{ok:true,clone:await clone(user,req,service)});return true;}
  if(req.method==='POST'&&['/api/voice-cost','/api/voice-generations'].includes(route)){
   const input=await body(req),p=await prepare(user,input,service),base=vibiToCustomerCredits(p.source,voiceCreditsPerPkr(user)),cost=base;
   if(route==='/api/voice-cost'){d.json(res,200,{ok:true,cost,estimated:true,operation:p.operation,sourceDuration:p.params.sourceDuration||null});return true;}
   if(input.expectedCost!==undefined&&(!Number.isFinite(Number(input.expectedCost))||Math.abs(Number(input.expectedCost)-cost)>.01))throw C.fail(409,'The price has changed. Check credits again before generating.');
   const generation=await d.create(user.id,{text:p.prompt},{provider:'vibi',model:p.modelLabel,mode:p.operation==='speech'?'text-to-speech':p.operation,costOverride:base,expectedCost:input.expectedCost,providerCost:p.source,providerCostUnit:'credits',providerParams:p.params,inputFile:p.inputFile,studioRequest:S.request(input.requestKey,input)});
   d.wake(req);const [[fresh]]=await d.db().execute('SELECT * FROM users WHERE id=?',[user.id]);d.json(res,201,{ok:true,generation,user:d.userPayload(fresh)});return true;
  }
  return false;
 }
 return {handle,prepare};
}
module.exports={createVoiceStudio,DUB_LANGUAGES};

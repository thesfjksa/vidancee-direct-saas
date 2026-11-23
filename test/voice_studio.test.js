'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../src/voice_contract'),S=require('../src/voice_studio_store'),{VibiClient}=require('../src/provider/vibi'),{createVoiceStudio}=require('../src/voice_studio');
const models=[{model_id:'eleven_v4',name:'Eleven v4',can_do_text_to_speech:true,maximum_text_length_per_request:5000,model_rates:{character_cost_multiplier:1},supports_similarity:true,can_use_style:true,can_use_speaker_boost:true,languages:[{language_id:'en'},{language_id:'ur'}]}];
const langs=[{code:'en',name:'English'},{code:'ur',name:'Urdu'},{code:'vi',name:'Vietnamese'}];
const model=()=>C.fixedModel(models);
test('fixed Eleven v4 is resolved from the account catalog without renaming or falling back to v3',()=>{
 assert.equal(model().modelId,'eleven_v4');
 assert.throws(()=>C.fixedModel([{model_id:'eleven_v3',name:'Eleven v3'}]),/Eleven v4 is not available/);
 assert.throws(()=>C.fixedModel([...models,...models]),/Eleven v4 is not available/);
 const alias=C.fixedModel([{...models[0],model_id:'account_exact_id'}]);assert.equal(alias.modelId,'account_exact_id');
 assert.throws(()=>C.fixedModel([{...models[0],model_rates:{character_cost_multiplier:-1}}]),/pricing/);
 assert.deepEqual(C.languages(langs,model()).map(x=>x.code),['en','ur']);
});
test('speech validates language, speed and sliders, ignores supplied model/provider and forwards supported settings',()=>{
 const body={text:'Hello',voiceId:'voice-1',languageCode:'ur',modelId:'wrong',provider:'minimax',speed:1.15,stability:.7,similarityBoost:.8,style:.2,useSpeakerBoost:false};
 const out=C.speech(body,model(),langs);assert.equal(out.modelId,'eleven_v4');assert.equal(out.provider,'elevenlabs');assert.equal(out.languageCode,'ur');assert.deepEqual(out.voiceSettings,{stability:.7,speed:1.15,similarity_boost:.8,style:.2,use_speaker_boost:false});
 for(const patch of [{languageCode:'xx'},{speed:2},{stability:NaN},{similarityBoost:-1},{style:2},{useSpeakerBoost:'true'}])assert.throws(()=>C.speech({...body,...patch},model(),langs));
 const limited=C.fixedModel([{...models[0],supports_similarity:false,can_use_style:false,can_use_speaker_boost:false}]);
 assert.deepEqual(C.speech(body,limited,langs).voiceSettings,{stability:.7,speed:1.15});
});
test('dialogue maps independent speakers, enforces script names and counts only spoken text',()=>{
 const input={text:'Alice: Hello.\nBob: Welcome!\nHow are you?',speakers:[{name:'Alice',voiceId:'a',languageCode:'en'},{name:'Bob',voiceId:'b',languageCode:'ur'}],pauseBetweenTurns:.4};
 const out=C.dialogue(input,model(),langs);assert.equal(out.speakers.Alice.voice_id,'a');assert.equal(out.speakers.Bob.language_code,'ur');assert.equal(out.speakers.Alice.model_id,'eleven_v4');assert.equal(out.characters,'Hello.'.length+'Welcome!'.length+'How are you?'.length);assert.equal(out.pause_between_turns,.4);
 for(const patch of [{text:'Alice: Hello.'},{text:'Unknown: Hello.\nBob: Hi.'},{speakers:[input.speakers[0],input.speakers[0]]},{pauseBetweenTurns:5}])assert.throws(()=>C.dialogue({...input,...patch},model(),langs));
});
test('reviewed upload quotes use source duration and preserve different voice changer/dubbing units',()=>{
 assert.equal(C.sourceCost('voice-changer',{duration:30}),500);
 assert.equal(C.sourceCost('dubbing',{duration:30.01}),1550);
 assert.equal(C.sourceCost('speech',{characters:100,factor:.5}),50);
 assert.throws(()=>C.sourceCost('voice-changer',{duration:301}),/5 minutes/);
 assert.throws(()=>C.sourceCost('dubbing',{duration:9001}),/2.5 hours/);
 for(const duration of [0,NaN,Infinity])assert.throws(()=>C.sourceCost('dubbing',{duration}));
});
test('provider dialogue/changer/dubbing payloads match docs, use exact task IDs and correct polling paths',async()=>{
 const client=new VibiClient({apiKey:'test'}),calls=[];
 client.request=async(path,options={})=>{
  calls.push([path,options]);
  if(path.endsWith('/init'))return {upload_id:'session',chunk_size:3};
  if(path.includes('/history/'))return {id:'task',status:'completed',result:{audio_url:'https://example.com/final.mp4'},credits_deducted:500};
  return {task_id:'task',status:'pending'};
 };
 const {submit,poll}=require('../src/voice_worker'),file={data:Buffer.from('1234567'),mimeType:'video/mp4',filename:'source.mp4'};
 const db={query:async()=>[[{input_data:file.data}]]};
 const dialogue=C.dialogue({text:'A: Hello\nB: Hi',speakers:[{name:'A',voiceId:'a'},{name:'B',voiceId:'b'}]},model(),langs);delete dialogue.characters;
 assert.equal(await submit(client,db,{prompt:'',provider_meta:JSON.stringify({operation:'dialogue',dialogue})}),'task');assert.deepEqual(calls[0][1].json,JSON.parse(JSON.stringify(dialogue)));
 calls.length=0;assert.equal(await submit(client,db,{id:'g',provider_meta:JSON.stringify({operation:'dubbing',file,voiceId:'target',sourceLanguage:'en',targetLanguage:'ur'})}),'task');
 assert.deepEqual(calls.map(c=>c[0]),['/v1/aidubbing/upload/init','/v1/aidubbing/upload/chunk','/v1/aidubbing/upload/chunk','/v1/aidubbing/upload/chunk','/v1/aidubbing/upload/complete']);
 assert.deepEqual(calls.slice(1,4).map(c=>c[1].form.get('index')),['0','1','2']);
 const form=calls.at(-1)[1].form;assert.equal(form.get('total_chunks'),'3');assert.equal(form.get('provider'),'elevenlabs');assert.equal(form.get('target_language'),'ur');assert.equal(form.has('model_id'),false,'dubbing model is pinned upstream');
 calls.length=0;await client.voiceChanger({file:{...file,mimeType:'audio/mpeg'},voiceId:'target',voiceSettings:{stability:.5},removeNoise:true});
 const f=calls[0][1].form;assert.equal(f.get('model_id'),'eleven_multilingual_sts_v2');assert.equal(f.get('remove_background_noise'),'true');assert.equal(f.has('audio'),true);
 for(const operation of ['speech','dialogue','voice-changer','dubbing']){await poll(client,{provider_job_id:'task',provider_meta:JSON.stringify({operation})});assert.equal(calls.at(-1)[0],operation==='dubbing'?'/v1/aidubbing/history/task':operation==='voice-changer'?'/v1/voice-changer/history/task':'/v1/history/task');}
 assert.equal(client.normalizeTask({status:'completed'}).creditsDeducted,null,'absent charge must not become zero');
});
test('ambiguous paid submissions are never retried; errors before dubbing completion are safe to refund',async()=>{
 const client=new VibiClient({apiKey:'test'});let paid=0;
 client.request=async path=>{if(path.endsWith('/init'))return {upload_id:'s',chunk_size:10};if(path.endsWith('/chunk'))return {};paid++;throw Error('Connection lost');};
 const file={data:Buffer.from('abc'),filename:'a.mp4',mimeType:'video/mp4'};
 await assert.rejects(client.dubbing({file,voiceId:'a',sourceLanguage:'en',targetLanguage:'ur'}),e=>!e.definitive);assert.equal(paid,1);
 client.request=async()=>{throw Error('Upload failed');};await assert.rejects(client.dubbing({file}),e=>e.definitive===true);
 const {submit}=require('../src/voice_worker');let count=0;client.dialogue=async()=>{count++;return {};};await assert.rejects(submit(client,{}, {provider_meta:JSON.stringify({operation:'dialogue',dialogue:{}})}),/task ID/);assert.equal(count,1);
});
function fixture(overrides={}){
 const sent=[],created=[];let charge=true,access=true;
 const client={getModels:async provider=>provider==='minimax'?[{model_id:'speech-2.8-hd',credit_ratio:1}]:models,getLanguages:async p=>p==='minimax'?[{code:'English',name:'English'}]:langs,getDefaultVoices:async()=>({voices:[{voice_id:'a',name:'Adam'}]})};
 const d={db:()=>({execute:async()=>[[{id:1,status:'active',provider_clone_id:'owned',credits:10000}]]}),requireDatabase:()=>{},requireUser:async()=>({id:1}),settings:async()=>({vibiApiKey:'key',vibiEnabled:true,allowProviderCharges:charge}),access:async()=>({vibi:access}),client:()=>client,rate:async()=>1.05,origin:'https://cmmtools.site',readJson:async req=>req.body,json:(res,status,body)=>sent.push({status,body}),wake:()=>{},create:async(...args)=>{created.push(args);return {id:'g'};},userPayload:u=>u,list:async()=>[],get:async()=>null,remove:async()=>{},probe:async()=>({duration:30,video:true}),...overrides};
 return {studio:createVoiceStudio(d),sent,created,d,client,setCharge:v=>{charge=v;},setAccess:v=>{access=v;}};
}
const req=(body,method='POST')=>({method,headers:{'x-cmm-voice':'1',origin:'https://cmmtools.site'},body});
test('routes enforce authentication, same origin, source visibility and provider charge pause before paid work',async()=>{
 const f=fixture();const input={operation:'speech',text:'Hello',voiceId:'a',languageCode:'en',requestKey:'request-123'};
 await assert.rejects(f.studio.handle({...req(input),headers:{}},{},null,'/api/voice-generations'),{statusCode:403});
 await assert.rejects(f.studio.handle({...req(input),headers:{'x-cmm-voice':'1',origin:'https://evil.test'}},{},null,'/api/voice-generations'),{statusCode:403});
 f.setAccess(false);await assert.rejects(f.studio.handle(req(input),{},null,'/api/voice-generations'),{statusCode:503});
 f.setAccess(true);f.setCharge(false);await assert.rejects(f.studio.handle(req(input),{},null,'/api/voice-generations'),/paused/);
 await f.studio.handle(req(input),{},null,'/api/voice-cost');assert.equal(f.sent.at(-1).body.cost,.8616);assert.equal(f.created.length,0);
 const denied=fixture({requireUser:async()=>{throw Object.assign(Error('Login'),{statusCode:401});}});await assert.rejects(denied.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-options'),'/api/voice-options'),{statusCode:401});
});
test('create enforces the fixed model and server price, scopes clone lookup, and blocks unreviewed uploads',async()=>{
 const f=fixture(),input={operation:'speech',text:'Hello',voiceId:'a',languageCode:'en',modelId:'wrong',requestKey:'request-123'};
 await f.studio.handle(req(input),{},null,'/api/voice-generations');assert.equal(f.created.length,1);const options=f.created[0][2];assert.equal(options.providerParams.modelId,'eleven_v4');assert.equal(options.costOverride,.8616);assert.equal(options.providerCost,5);assert.ok(options.studioRequest.hash);
 await assert.rejects(f.studio.handle(req({...input,expectedCost:0}),{},null,'/api/voice-generations'),{statusCode:409});
 await assert.rejects(f.studio.handle(req({...input,expectedCost:'bad'}),{},null,'/api/voice-generations'),{statusCode:409});
 let sql,args;const clone=fixture({db:()=>({execute:async(s,a)=>{sql=s;args=a;return [[]];}})});
 await assert.rejects(clone.studio.prepare({id:7},{operation:'clone-speech',cloneId:9,text:'Hello'}, {client:f.client,settings:{}}),{statusCode:404});assert.match(sql,/id=\? AND user_id=\?/);assert.deepEqual(args,[9,7]);
 const dub=await f.studio.prepare({id:1},{operation:'dubbing',sample:{data:Buffer.from('a'),filename:'source.mp4',mimeType:'video/mp4'},voiceId:'a',sourceLanguage:'en',targetLanguage:'ur'},{client:f.client,settings:{vibiApiKey:'key'}});assert.equal(dub.source,1500);assert.equal(dub.params.outputKind,'video');
 await assert.rejects(f.studio.prepare({id:1},{operation:'dubbing',sample:{data:Buffer.from('a')},voiceId:'a',sourceLanguage:'auto',targetLanguage:'ur'},{client:f.client,settings:{vibiApiKey:'key'}}),/supported language/);
});
test('missing v4 keeps non-TTS tools available and explicitly reports missing model',async()=>{
 const f=fixture();f.client.getModels=async()=>[{model_id:'eleven_v3',name:'Eleven v3'}];
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-options'),'/api/voice-options');
 const b=f.sent.at(-1).body;assert.equal(b.tools.speech,false);assert.equal(b.tools.voiceChanger,true);assert.equal(b.model,null);assert.match(b.modelError,/Eleven v4/);assert.equal(b.models.length,0);
});

test('voice options expose actual provider-supplied metadata for the selector filters',async()=>{
 const f=fixture();
 f.client.getDefaultVoices=async()=>({voices:[
  {voice_id:'hindi-1',name:'Hindi Narrator',description:'Warm narration',labels:{accent:'Indian',gender:'Male',age:'Young',language:'hi'},category:'premade',preview_url:'https://example.com/sample.mp3',usage_count:321},
  {voice_id:'plain',name:'Plain Voice'}
 ]});
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-options'),'/api/voice-options');
 const voices=f.sent.at(-1).body.voices;
 assert.equal(voices.length,2);
 assert.deepEqual({id:voices[0].id,accent:voices[0].accent,gender:voices[0].gender,age:voices[0].age,language:voices[0].language,usage:voices[0].usageCount},
  {id:'hindi-1',accent:'Indian',gender:'Male',age:'Young',language:'hi',usage:321});
 assert.equal(voices[1].gender,null);
 assert.equal(voices[1].category,null);
 assert.equal(voices[1].usageCount,null);
});

test('voice picker modal provides filters, searchable cards, preview and dialogue selection',()=>{
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
 const pick=fs.readFileSync(require.resolve('../public/voice-picker.js'),'utf8');
 const css=fs.readFileSync(require.resolve('../public/voice-picker.css'),'utf8');
 assert.match(html,/id="voicePickerDialog"/);
 for(const control of ['vpLanguage','vpAccent','vpQuality','vpGender','vpAge','vpCategory','vpSort','vpSearch','vpCards','vpAudio'])
  assert.ok(html.includes('id="'+control+'"'),control+' missing');
 for(const tab of ['favourites','all','library','default'])assert.ok(html.includes('data-vp-tab="'+tab+'"'));
 assert.match(html,/voice-picker\.js\?v=/);
 assert.match(html,/voice-picker\.css\?v=/);
 assert.match(pick,/function useVoicePickerVoice/);
 assert.match(pick,/function previewVoicePickerVoice/);
 assert.match(pick,/function voicePickerFavorites/);
 assert.match(css,/\.vp-grid/);
 assert.match(css,/\.vp-avatar/);
 assert.match(css,/--turquoise/);
 assert.match(html,/id="vpAdvanced"/);
 assert.match(html,/id="vpCount"/);
 assert.match(html,/class="vp-brand-icon"/);
 assert.match(html,/voice-picker\.css\?v=20261123-brand-refresh/);
 assert.match(html,/voice-picker\.js\?v=20261123-brand-refresh/);
 assert.match(pick,/function voicePickerSyncPreview/);
 assert.match(pick,/voicePickerIcons\[art\]/);
 new vm.Script(pick);
});


test('branded picker renders safe voice cards, preview availability, and retry state',()=>{
 const js=fs.readFileSync(require.resolve('../public/voice-picker.js'),'utf8');
 const nodes={
  vpCards:{innerHTML:''},vpCount:{textContent:''},vpStatus:{textContent:''},
  vpLanguage:{value:'ur',selectedOptions:[{textContent:'Urdu'}]},vpSearch:{value:''},vpSort:{value:'provider'},
  vpAccent:{value:''},vpQuality:{value:''},vpGender:{value:''},vpAge:{value:''},vpCategory:{value:''},
  vpAudio:{paused:true,ended:false},voiceSelect:{value:'voice-a'},
  voicePickerDialog:{querySelectorAll:()=>[]}
 };
 const sandbox={
  document:{addEventListener:()=>{}},$:id=>nodes[id]||null,
  localStorage:{getItem:()=>null},
  voiceOptions:{voices:[],speechLanguages:[{code:'ur',name:'Urdu'}]},
  escapeHtml:val=>String(val).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))
 };
 vm.createContext(sandbox);vm.runInContext(js,sandbox);
 vm.runInContext("voicePickerSource='shared';voicePickerLatest=[{id:'voice-a',name:'Urdu <Narrator>',description:'A warm sample',gender:'female',age:'middle_aged',previewUrl:'/api/voice-preview/a'},{id:'voice-b',name:'No sample',description:'Provider has no preview',previewUrl:null}];renderVoicePicker()",sandbox);
 assert.equal(nodes.vpCount.textContent,'2 voices found');
 assert.match(nodes.vpCards.innerHTML,/vp-card current/);
 assert.match(nodes.vpCards.innerHTML,/Urdu &lt;Narrator&gt;/);
 assert.match(nodes.vpCards.innerHTML,/class="vp-avatar tone-/);
 assert.match(nodes.vpCards.innerHTML,/data-voice-action="favorite"/);
 assert.match(nodes.vpCards.innerHTML,/Preview voice sample/);
 assert.match(nodes.vpCards.innerHTML,/disabled title="Preview unavailable"/);
 assert.match(nodes.vpCards.innerHTML,/middle aged/);
 vm.runInContext("voicePickerError='Provider temporarily unavailable';renderVoicePicker()",sandbox);
 assert.match(nodes.vpCards.innerHTML,/Retry voice search/);
 assert.match(nodes.vpCards.innerHTML,/Provider temporarily unavailable/);
});

test('voice selector filters native language labels without losing multilingual synthesis setting',()=>{
 const js=fs.readFileSync(require.resolve('../public/voice-picker.js'),'utf8');
 const sandbox={document:{addEventListener:()=>{}},voiceOptions:{speechLanguages:[{code:'en',name:'English'},{code:'hi',name:'Hindi'},{code:'ur',name:'Urdu'}]}};
 vm.createContext(sandbox);
 vm.runInContext(js,sandbox);
 assert.equal(vm.runInContext("voicePickerMatchesLanguage({language:'en',languages:['en']},'hi')",sandbox),false);
 assert.equal(vm.runInContext("voicePickerMatchesLanguage({language:null,languages:[]},'hi')",sandbox),false);
 assert.equal(vm.runInContext("voicePickerMatchesLanguage({language:'hi-IN'},'hi')",sandbox),true);
 assert.equal(vm.runInContext("voicePickerMatchesLanguage({languages:['Urdu']},'ur')",sandbox),true);
 assert.equal(vm.runInContext("voicePickerMatchesLanguage({language:'en'},'unknown')",sandbox),false);
 assert.match(js,/voicePickerChangeLanguage/);
 assert.match(js,/voicePickerFetch\(\)/);
 assert.match(js,/target\.value=code/);
 assert.match(js,/No .*labelled voices/);
});


test('language-aware catalog requests fetch distinct provider voices and reject unlabelled defaults',async()=>{
 const f=fixture(),calls=[];
 f.client.getModels=async()=>[{...models[0],languages:[...models[0].languages,{language_id:'hi'}]}];
 f.client.getLanguages=async p=>p==='minimax'?[{code:'English',name:'English'}]:[...langs,{code:'hi',name:'Hindi'}];
 f.client.getDefaultVoices=async args=>{
  calls.push(args);
  if(args.language==='ur')return {voices:[
    {voice_id:'a',name:'Default English',labels:{gender:'female',accent:'american'}},
    {voice_id:'ur-native',name:'Urdu narrator',labels:{language:'ur',accent:'pakistani'}},
    {voice_id:'hi-native',name:'Hindi narrator',language:'hi'}
  ]};
  if(args.language==='hi')return {voices:[
    {voice_id:'hi-native',name:'Hindi narrator',language:'hi-IN'},
    {voice_id:'ur-native',name:'Urdu narrator',language:'ur'}
  ]};
  return {voices:[{voice_id:'a',name:'Default English'}]};
 };
 const base='https://cmmtools.site/api/voice-options';
 await f.studio.handle(req({},'GET'),{},new URL(base+'?language=ur'),'/api/voice-options');
 assert.deepEqual(f.sent.at(-1).body.voices.map(x=>x.id),['ur-native']);
 assert.equal(f.sent.at(-1).body.voices[0].previewUrl,null);
 await f.studio.handle(req({},'GET'),{},new URL(base+'?language=hi'),'/api/voice-options');
 assert.deepEqual(f.sent.at(-1).body.voices.map(x=>x.id),['hi-native']);
 assert.deepEqual(calls.map(c=>c.language),['ur','hi']);
 await f.studio.handle(req({},'GET'),{},new URL(base),'/api/voice-options');
 assert.deepEqual(f.sent.at(-1).body.voices.map(x=>x.id),['a']);
 await assert.rejects(f.studio.handle(req({},'GET'),{},new URL(base+'?language=madeup'),'/api/voice-options'),{statusCode:400});
});

test('unknown language listings do not reuse 21 untagged English default voices',async()=>{
 const f=fixture(),calls=[];
 f.client.getDefaultVoices=async args=>{
   calls.push(args);
   return {voices:[{voice_id:'english',name:'Bella',labels:{accent:'american',gender:'female'}}]};
 };
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-options?language=ur'),'/api/voice-options');
 assert.equal(f.sent.at(-1).body.voices.length,0);
 assert.equal(f.sent.at(-1).body.voiceCatalogLanguage,'ur');
 assert.equal(calls.length,2,'try language-filtered listing then a discovery search');
 assert.equal(calls[1].search,'Urdu');
});

test('Vibi default voices forwards language in GET catalog query only when provided',async()=>{
 const c=new VibiClient({apiKey:'test'}),paths=[];
 c.request=async path=>{paths.push(path);return {voices:[]}};
 await c.getDefaultVoices({pageSize:60,language:'ur',search:'narrator'});
 await c.getDefaultVoices({pageSize:30});
 assert.equal(paths[0],'/v1/default-voices?page_size=60&search=narrator');
 assert.equal(paths[1],'/v1/default-voices?page_size=30');
});


test('language-specific library route shows shared Urdu voices without loading models or MiniMax catalog',async()=>{
 const f=fixture(),calls=[];
 f.client.getModels=async()=>{throw Error('model catalog should not be called for picking')};
 f.client.getLanguages=async()=>{throw Error('language catalog should not be called for picking')};
 f.client.getSharedVoices=async options=>{
   calls.push(options);return {voices:[
     {voice_id:'amjid',name:'Amjid - Urdu Documentary Narrator',language:'ur',gender:'male',preview_url:'https://storage.googleapis.com/elevenlabs/amjid.mp3'},
     {voice_id:'saira',name:'Saira - Urdu Storyteller',language:'ur',preview_url:'https://storage.googleapis.com/elevenlabs/saira.mp3'}
   ],has_more:true};
 };
 const route='/api/voice-library',url=new URL('https://cmmtools.site/api/voice-library?language=ur');
 await f.studio.handle(req({},'GET'),{},url,route);
 const body=f.sent.at(-1).body;
 assert.equal(body.source,'shared');assert.equal(body.language,'ur');assert.equal(body.hasMore,true);
 assert.deepEqual(body.voices.map(v=>v.id),['amjid','saira']);
 assert.equal(body.voices[0].previewUrl,'/api/voice-preview/amjid?language=ur');
 assert.equal(calls.length,1);
 assert.equal(calls[0].timeoutMs,5000);
 assert.equal(calls[0].search,'Urdu','selected language must become effective provider search');
 f.client.downloadVoicePreview=async u=>({data:Buffer.from('ID3audio'),contentType:'audio/mpeg'});
 const response={writeHead(status,headers){this.status=status;this.headers=headers},end(data){this.data=data}};
 await f.studio.handle(req({},'GET'),response,new URL('https://cmmtools.site/api/voice-preview/amjid?language=ur'),'/api/voice-preview/amjid');
 assert.equal(response.data.toString(),'ID3audio');
 assert.equal(f.created.length,0,'previews never submit a paid generation');
});


test('native-language dropdown applies effective voice search even when Vibi ignores its language parameter',async()=>{
 const f=fixture(),calls=[];
 f.client.getSharedVoices=async opts=>{
   calls.push(opts);
   if(opts.search==='Urdu')return {voices:[
     {voice_id:'jon',name:'Jon - Children Storyteller',description:'Warm American male storyteller',language:'en',labels:{accent:'american'}},
     {voice_id:'reva',name:'Reva - Warm Urdu Narration',description:'Natural Urdu narration from Pakistan',labels:{gender:'female',accent:'pakistani'},preview_url:'https://storage.googleapis.com/public/reva.mp3'},
     {voice_id:'amjid',name:'Amjid - Documentary Narrator',description:'Deep professional Urdu voice',language:'ur'},
     {voice_id:'monika',name:'Monika Sogam - Premium Hindi Commercial',description:'Expressive Hindi voice',language:'hi'}
   ],has_more:false};
   if(opts.search==='Hindi')return {voices:[
     {voice_id:'hindi',name:'Anika - Natural Hindi Narrator',language:'hi'},
     {voice_id:'amjid',name:'Amjid - Documentary Narrator',language:'ur'}
   ]};
   return {voices:[{voice_id:'jon',name:'Jon - Children Storyteller',language:'en'}]};
 };
 for(const [code,expected] of [['ur',['reva','amjid']],['hi',['hindi']]]){
   await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-library?language='+code),'/api/voice-library');
   assert.deepEqual(f.sent.at(-1).body.voices.map(v=>v.id),expected);
 }
 assert.deepEqual(calls.map(x=>x.search),['Urdu','Hindi'],'dropdown must invoke text search, not language param alone');
 assert.equal(calls[0].language,'ur');
 assert.equal(calls[0].pageSize,100);
 assert.equal(f.created.length,0);
});

test('keyword and selected native language remain independent voice-library filters',async()=>{
 const f=fixture(),calls=[];
 f.client.getSharedVoices=async opts=>{
   calls.push(opts.search);
   if(opts.search==='Urdu')return {voices:[
     {voice_id:'amjid',name:'Amjid - Documentary',description:'Urdu professional narrator'},
     {voice_id:'reva',name:'Reva - Urdu Narration',description:'Warm Urdu storytelling'},
     {voice_id:'jon',name:'Jon',description:'American narration',language:'en'}
   ]};
   return {voices:[]};
 };
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-library?language=ur&search=Amjid'),'/api/voice-library');
 assert.deepEqual(f.sent.at(-1).body.voices.map(v=>v.id),['amjid']);
 assert.deepEqual(calls,['Urdu']);
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-library?language=ur&search=Urdu'),'/api/voice-library');
 assert.deepEqual(f.sent.at(-1).body.voices.map(v=>v.id),['amjid','reva']);
});

test('unsupported or timed out shared voice endpoints fall back without repeated 30s language queries',async()=>{
 const f=fixture(),defaults=[];
 f.client.getSharedVoices=async()=>{const e=new Error('The operation was aborted');e.name='TimeoutError';throw e};
 f.client.getDefaultVoices=async args=>{defaults.push(args);return {voices:[{voice_id:'general-english',name:'Bella',language:'en'}]}};
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-library?language=ur'),'/api/voice-library');
 const body=f.sent.at(-1).body;
 assert.equal(body.source,'default');assert.equal(body.voices.length,0);
 assert.match(body.reason,/shared-voice listing/);
 assert.equal(defaults.length,1);
 assert.equal(defaults[0].search,'Urdu');assert.equal(defaults[0].timeoutMs,5500);
 await assert.rejects(f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-library?language=bad!!'),'/api/voice-library'),{statusCode:400});
});


test('simultaneous shared and default upstream timeouts return a retryable response, not signal timeout',async()=>{
 const f=fixture(),timeout=()=>{const error=new Error('The operation was aborted due to timeout');error.name='TimeoutError';throw error};
 f.client.getSharedVoices=async()=>timeout();
 f.client.getDefaultVoices=async()=>timeout();
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-library?language=ur'),'/api/voice-library');
 const out=f.sent.at(-1).body;
 assert.equal(out.ok,true);assert.equal(out.source,'unavailable');
 assert.deepEqual(out.voices,[]);
 assert.match(out.reason,/did not respond in time/);
 assert.equal(f.created.length,0);
 const picker=fs.readFileSync(require.resolve('../public/voice-picker.js'),'utf8');
 assert.match(picker,/Retry voice search/);
 assert.match(picker,/voicePickerFetch\(\)/);
});
test('Vibi shared-voice GET uses documented pagination and bounded read timeout',async()=>{
 const c=new VibiClient({apiKey:'test'}),calls=[];
 c.request=async(path,options)=>{calls.push({path,options});return {voices:[]}};
 await c.getSharedVoices({language:'ur',search:'Amjid',pageSize:40,page:1,timeoutMs:4500});
 assert.equal(calls.length,1);
 assert.match(calls[0].path,/^\/v1\/shared-voices\?/);
 assert.match(calls[0].path,/language=ur/);
 assert.match(calls[0].path,/search=Amjid/);
 assert.equal(calls[0].options.timeoutMs,4500);
 const js=fs.readFileSync(require.resolve('../public/voice-picker.js'),'utf8');
 assert.match(js,/\/api\/voice-library\?/);
 assert.doesNotMatch(js,/return loadVoiceOptions\(\)/);
});

test('voice catalog exposes same-origin preview and preserves alternate upstream preview fields',async()=>{
 const f=fixture();
 f.client.getDefaultVoices=async()=>({voices:[
  {voice_id:'valid-1',name:'With URL',preview_url:'https://storage.googleapis.com/eleven-public-prod/sample.mp3'},
  {voice_id:'valid-2',name:'Alt URL',preview_audio_url:'https://storage.googleapis.com/eleven-public-prod/sample2.mp3'},
  {voice_id:'no-preview',name:'No URL'}
 ]});
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-options'),'/api/voice-options');
 const entries=f.sent.at(-1).body.voices;
 assert.equal(entries[0].previewUrl,'/api/voice-preview/valid-1');
 assert.equal(entries[1].previewUrl,'/api/voice-preview/valid-2');
 assert.equal(entries[2].previewUrl,null);
});

test('voice preview endpoint authenticates and returns provider sample without customer credits',async()=>{
 const f=fixture(),samples=[];
 f.client.getDefaultVoices=async()=>({voices:[{voice_id:'voice-1',preview_url:'https://storage.googleapis.com/eleven-public-prod/sample.mp3'}]});
 f.client.downloadVoicePreview=async url=>{samples.push(url);return {data:Buffer.from('ID3abc'),contentType:'audio/mpeg'};};
 const response={writeHead(status,headers){this.status=status;this.headers=headers;},end(bytes){this.bytes=bytes;}};
 await f.studio.handle(req({},'GET'),response,new URL('https://cmmtools.site/api/voice-preview/voice-1'),'/api/voice-preview/voice-1');
 assert.equal(response.status,200);
 assert.equal(response.headers['content-type'],'audio/mpeg');
 assert.equal(response.headers['cache-control'],'private, max-age=300');
 assert.equal(response.bytes.toString(),'ID3abc');
 assert.equal(f.created.length,0);
 assert.equal(samples.length,1);
 await assert.rejects(f.studio.handle(req({},'GET'),{},null,'/api/voice-preview/other-voice'),{statusCode:404});
 const denied=fixture({requireUser:async()=>{throw Object.assign(Error('Login'),{statusCode:401});}});
 await assert.rejects(denied.studio.handle(req({},'GET'),{},null,'/api/voice-preview/voice-1'),{statusCode:401});
});

test('shared voice previews try alternate samples and refresh broken links for the same voice',async()=>{
 const f=fixture(),downloads=[];
 const stale='https://storage.googleapis.com/previews/stale.mp3';
 const alternate='https://storage.googleapis.com/previews/alternate.mp3';
 const fresh='https://storage.googleapis.com/previews/fresh.mp3';
 f.client.getSharedVoices=async({search})=>({voices:[
  {voice_id:'other',name:'Other Urdu voice',preview_url:'https://storage.googleapis.com/previews/other.mp3'},
  {voice_id:'selected',name:'Selected Urdu voice',preview_url:search==='selected'?fresh:stale,sample_url:alternate}
 ]});
 let alternateAvailable=true,freshAvailable=true;
 f.client.downloadVoicePreview=async address=>{
  downloads.push(address);
  if((address===alternate&&alternateAvailable)||(address===fresh&&freshAvailable))
   return {data:Buffer.from('ID3abc'),contentType:'audio/mpeg'};
  throw Object.assign(Error('Sample unavailable'),{statusCode:404});
 };
 await f.studio.handle(req({},'GET'),{},new URL('https://cmmtools.site/api/voice-library?language=ur'),'/api/voice-library');
 const response={writeHead(status){this.status=status;},end(bytes){this.bytes=bytes;}};
 const url=new URL('https://cmmtools.site/api/voice-preview/selected?language=ur');
 const play=()=>f.studio.handle(req({},'GET'),response,url,url.pathname);
 await play();
 assert.equal(response.status,200);
 assert.deepEqual(downloads,[stale,alternate]);
 downloads.length=0;alternateAvailable=false;
 await play();
 assert.deepEqual(downloads,[alternate,stale,fresh]);
 assert.equal(response.bytes.toString(),'ID3abc');
 downloads.length=0;freshAvailable=false;
 await assert.rejects(play(),{statusCode:404});
 assert.deepEqual(downloads,[fresh,alternate,stale]);
 assert.equal(f.created.length,0);
});

test('Vibi media preview fetch allows only trusted HTTPS sources and rejects nonaudio samples',async()=>{
 const client=new VibiClient({apiKey:'test-key'});
 await assert.rejects(client.downloadVoicePreview('http://127.0.0.1/private'),/not supported/);
 await assert.rejects(client.downloadVoicePreview('https://untrusted.invalid/sample.mp3'),/not supported/);
 const saved=global.fetch;
 try{
  global.fetch=async(url,init)=>{
   assert.equal(init.method,'GET');
   assert.equal(init.redirect,'manual');
   assert.equal(new URL(url).hostname,'storage.googleapis.com');
   assert.equal(init.headers['xi-api-key'],undefined,'external storage must not receive Vibi API key');
   return {ok:true,headers:new Map([['content-type','audio/mpeg'],['content-length','6']]),body:(async function*(){yield Buffer.from('ID3abc');})()};
  };
  const response=await client.downloadVoicePreview('https://storage.googleapis.com/eleven-public-prod/sample.mp3');
  assert.equal(response.contentType,'audio/mpeg');
  assert.equal(response.data.toString(),'ID3abc');
  global.fetch=async()=>({ok:true,headers:new Map([['content-type','text/html']]),body:(async function*(){yield Buffer.from('<html>');})()});
  await assert.rejects(client.downloadVoicePreview('https://storage.googleapis.com/eleven-public-prod/sample.mp3'),/did not return audio/);
 }finally{global.fetch=saved;}
});

test('idempotency hashes include file content, reject mismatched replays and retain original receipt',async()=>{
 const context=S.request('request-key',{text:'Hello',sample:{data:Buffer.from('abc')},expectedCost:1});
 assert.deepEqual(context,S.request('request-key',{text:'Hello',sample:{data:Buffer.from('abc')},expectedCost:2}));
 assert.notEqual(context.hash,S.request('request-key',{text:'Hello',sample:{data:Buffer.from('def')}}).hash);
 const conn={execute:async sql=>sql.includes('voice_studio_requests')?[[{request_hash:context.hash,generation_id:'g'}]]:[[{id:'g',user_id:1}]]};assert.equal((await S.findReplay(conn,1,context)).id,'g');
 await assert.rejects(S.findReplay(conn,1,{...context,hash:'other'}),{statusCode:409});
});
test('provider final-usage adjustments use the saved account rate and are idempotent',async()=>{
 let cost=100,balance=1000,adjustments=0,commits=0;
 const conn={beginTransaction:async()=>{},commit:async()=>commits++,rollback:async()=>{},release:()=>{},execute:async(sql,args)=>{
  if(sql.startsWith('SELECT credits,plan_code FROM users'))return [[{credits:balance}]];
  if(sql.startsWith('SELECT status'))return [[{status:'processing',credits_cost:cost}]];
  if(sql.startsWith('UPDATE users'))balance-=args[0];
  if(sql.startsWith('INSERT INTO credit_transactions'))adjustments++;
  if(sql.startsWith('UPDATE generations'))cost=args[0];return [{}];
 }};
 const db={getConnection:async()=>conn},row={id:'g',user_id:1,credits_cost:100,provider_cost:40,provider_meta:JSON.stringify({billingRate:1.05})};
 await S.settle(db,row,20);assert.equal(cost,3.4464);assert.equal(balance,1096.5536);assert.equal(adjustments,1);
 await S.settle(db,row,20);assert.equal(balance,1096.5536);assert.equal(adjustments,1);assert.equal(commits,2);
 await assert.rejects(S.settle(db,row,null),/valid final/);await assert.rejects(S.settle(db,row,10000),/Additional credits/);assert.equal(balance,1096.5536);
});
test('workspace includes all requested tools and compiles with no model or engine dropdown',()=>{
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8'),js=fs.readFileSync(require.resolve('../public/voice-studio.js'),'utf8');
 const section=html.slice(html.indexOf('<section id="voices"'),html.indexOf('<section id="cartoon"'));
 for(const tool of ['speech','dialogue','voice-changer','dubbing','cloning'])assert.ok(section.includes('data-voice-tool="'+tool+'"'));
 for(const control of ['voiceSpeed','voiceStability','voiceSimilarity','voiceStyle','voiceSpeakerBoost','voiceLanguage'])assert.ok(section.includes('id="'+control+'"'));
 assert.doesNotMatch(section,/id="voiceProvider"|id="voiceModel"/);assert.match(html,/voice-studio\.js\?v=\d{8}/);
 new vm.Script(js);for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
});
test('worker claims each paid job once, saves task IDs, and holds uncertain submissions without refund/replay',async()=>{
 const source=fs.readFileSync(require.resolve('../src/worker_admin_settings'),'utf8');
 const section=source.slice(source.indexOf('  async syncVibi(db)'),source.indexOf('  async runOnce()'));
 for(const kind of ['success','timeout','rejected','provider-balance']){
  let submissions=0,refunds=0,held=0,saved=0,deleted=0,claims=0;
  const context={require:p=>p==='./voice_worker'?{submit:async()=>{submissions++;if(kind==='timeout')throw Error('socket reset');if(kind==='provider-balance')throw Object.assign(Error('Payment required'),{definitive:true,statusCode:402});if(kind==='rejected')throw Object.assign(Error('rejected'),{definitive:true});return 'provider-task';}}:require(p),backendFailureMessage:require('../src/provider_errors').backendFailureMessage,refundGeneration:async(_id,_status,message)=>{refunds++;if(kind==='provider-balance')assert.equal(message,'Generation failed due to Backend payment failure, please contact admin');},console:{error:()=>{}},Buffer};
  const Worker=vm.runInNewContext('class Worker {'+section+'};Worker',context),w=new Worker();w.vibiEnabled=true;w.vibi={};w.vibiMaxInflight=1;
  const db={query:async sql=>sql.includes('COUNT(*)')?[[{total:0}]]:[claims?[]:[{id:'job',prompt:'Hello'}]],execute:async(sql,args)=>{
   if(sql.includes("SET status='submitting'")){claims++;return [{affectedRows:1}];}
   if(sql.includes("SET status='submitted'")){saved++;assert.deepEqual(Array.from(args),['provider-task','job']);}
   if(sql.includes("SET status='submit_error'")&&args)held++;
   if(sql.startsWith('DELETE'))deleted++;
   return [{}];
  }};
  await w.submitVibiQueued(db);await w.submitVibiQueued(db);assert.equal(submissions,1);
  assert.equal(saved,kind==='success'?1:0);assert.equal(held,kind==='timeout'?1:0);assert.equal(refunds,['rejected','provider-balance'].includes(kind)?1:0);assert.equal(deleted,kind==='timeout'?0:1);
 }
});
test('real multipart parsing and ffprobe validate media before billing, reject missing/oversized sources',async()=>{
 const {readUpload,probe}=require('../src/voice_upload'),{Readable}=require('node:stream');
 function wav(seconds){const frames=8000*seconds,b=Buffer.alloc(44+frames*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*2,40);return b;}
 const bytes=wav(1),boundary='test-boundary';
 const payload=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="payload"\r\n\r\n{"operation":"voice-changer"}\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="source.wav"\r\nContent-Type: audio/wav\r\n\r\n'),bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]);
 const stream=()=>{const req=Readable.from(payload);req.headers={'content-type':'multipart/form-data; boundary='+boundary};return req;};
 const parsed=await readUpload(stream());assert.deepEqual(parsed.sample.data,bytes);assert.equal(parsed.sample.mimeType,'audio/wav');
 const info=await probe(parsed.sample);assert.equal(info.video,false);assert.ok(Math.abs(info.duration-1)<.01);
 await assert.rejects(readUpload(stream(),{maxBytes:10}),{statusCode:413});
 await assert.rejects(probe({data:Buffer.from('invalid audio')}),{statusCode:400});
});
test('voice debit, input chunks and replay receipt commit together and retries never debit twice',async()=>{
 const dbModule=require('../src/db'),original=dbModule.getPool,path=require.resolve('../src/voice_generations');delete require.cache[path];
 let balance=10000,debits=0,chunks=[],receipt=null,generation=null,failChunk=false,snapshot;
 const conn={beginTransaction:async()=>{snapshot={balance,debits,chunks:[...chunks],receipt,generation};},commit:async()=>{},rollback:async()=>{({balance,debits,chunks,receipt,generation}=snapshot);},release:()=>{},execute:async(sql,a)=>{
  if(sql.startsWith('SELECT id,credits'))return [[{id:1,status:'active',credits:balance,plan_code:'creator',price_rate:10}]];
  if(sql.includes('FROM voice_studio_requests'))return [receipt?[receipt]:[]];
  if(sql.includes('FROM generations WHERE id='))return [generation?[generation]:[]];
  if(sql.includes('COUNT(*)'))return [[{total:0}]];
  if(sql.startsWith('INSERT INTO generations'))generation={id:a[0],user_id:1,status:'queued',mode:a[4],model:a[5],prompt:a[6],credits_cost:a[7],provider_meta:a[10]};
  if(sql.startsWith('INSERT INTO voice_input_chunks')){if(failChunk)throw Error('Input write failed');chunks.push(a[2]);}
  if(sql.startsWith('UPDATE users')){balance-=a[0];debits++;}
  if(sql.startsWith('INSERT INTO voice_studio_requests'))receipt={request_hash:a[2],generation_id:a[3]};
  return [{}];
 }};
 const db={getConnection:async()=>conn,execute:async()=>[[generation]]};dbModule.getPool=()=>db;
 try{
  const {createVoiceGenerationForUser}=require('../src/voice_generations');
  const file={data:Buffer.alloc(2*1024*1024+1)},options={provider:'vibi',mode:'dubbing',model:'Dubbing',costOverride:50,providerCost:20,inputFile:file,providerParams:{operation:'dubbing'},studioRequest:S.request('voice-test-key',{operation:'dubbing',sample:file})};
  failChunk=true;await assert.rejects(createVoiceGenerationForUser(1,{text:'Dub source'},options),/Input write failed/);assert.equal(balance,10000);assert.equal(receipt,null);assert.equal(chunks.length,0);
  failChunk=false;const first=await createVoiceGenerationForUser(1,{text:'Dub source'},options);assert.equal(first.credits_cost,3.4464);assert.equal(debits,1);assert.equal(chunks.length,3);assert.equal(Buffer.concat(chunks).length,file.data.length);
  const replay=await createVoiceGenerationForUser(1,{text:'Dub source'},options);assert.equal(replay.id,first.id);assert.equal(debits,1);assert.equal(balance,9996.5536);
 }finally{dbModule.getPool=original;delete require.cache[path];}
});
test('Vibi voice conversion removes both the plan margin and all customer price multipliers',async()=>{
 const b=require('../src/billing'),{PLANS,LEGACY_PLANS}=require('../src/plans');
 assert.equal(b.VIBI_CREDITS_PER_PKR,69.637);assert.equal(b.vibiToCustomerCredits(69.637),12);assert.equal(b.vibiToCustomerCredits(1000),172.3221);
 for(const plan of [...Object.values(PLANS),...Object.values(LEGACY_PLANS)])for(const price_rate of [1,1.05,60000/42000,10]){
  const user={plan_code:plan.code,price_rate},basis=b.voiceCreditsPerPkr(user),source=1000,cost=b.vibiToCustomerCredits(source,basis);
  assert.equal(basis,plan.credits/plan.pricePkr);
  assert.ok(cost*(plan.pricePkr/plan.credits)<=source/69.637+1e-12,'customer cash value cannot exceed provider cost');
 }
 const normal=fixture(),boosted=fixture({rate:async()=>99});
 for(const f of [normal,boosted])await f.studio.handle(req({text:'Hello',voiceId:'a',languageCode:'en'}),{},null,'/api/voice-cost');
 assert.equal(normal.sent[0].body.cost,boosted.sent[0].body.cost);
 const a=await require('../src/story_tiers').previewTierQuotes({getRate:async()=>1.05}),z=await require('../src/story_tiers').previewTierQuotes({getRate:async()=>2});
 assert.equal(a[0].breakdown.narration,z[0].breakdown.narration);assert.equal(a[0].credits,3344.74);
 assert.equal(b.sourceToCustomerCredits(2),5,'legacy image pricing is unchanged');
});

'use strict';
let voiceTool='speech',voiceQuote=null,voiceKey=null,voiceKeySignature=null,voiceOptionsSeq=0;
let pendingClone=null;
function voiceApi(path,options={}){return api(path,{...options,headers:{...(options.headers||{}),'x-cmm-voice':'1'}});}
function voiceMessage(message,error=false){const m=$('voiceMsg');m.className='msg '+(error?'err':'muted');m.textContent=message;}
function voiceInvalidate(){voiceQuote=null;++voiceCostRequestSeq;$('voiceCost').textContent='—';}
function voiceControlLabels(){
 for(const [name,format] of [['Speed',v=>Number(v).toFixed(2)],['Stability',v=>Math.round(v*100)+'%'],['Similarity',v=>Math.round(v*100)+'%'],['Style',v=>Math.round(v*100)+'%']]){
  const input=$('voice'+name),out=$('voice'+name+'Value');if(input&&out)out.textContent=format(input.value);
 }
}
function setVoiceTool(tool){
 voiceTool=tool;voiceInvalidate();
 document.querySelectorAll('[data-voice-tool]').forEach(b=>{b.classList.toggle('primary',b.dataset.voiceTool===tool);b.classList.toggle('secondary',b.dataset.voiceTool!==tool);b.setAttribute('aria-pressed',String(b.dataset.voiceTool===tool));});
 const cloning=tool==='cloning',dialogue=tool==='dialogue',upload=['voice-changer','dubbing'].includes(tool);
 $('voiceCompose').classList.toggle('hide',cloning);$('voiceClonePanel').classList.toggle('hide',!cloning);
 $('voiceSpeakerRows').classList.toggle('hide',!dialogue);$('voiceTextWrap').classList.toggle('hide',upload);
 $('voiceUploadWrap').classList.toggle('hide',!upload);$('voiceDubLanguages').classList.toggle('hide',tool!=='dubbing');
 $('voicePrimaryVoice').classList.toggle('hide',dialogue);$('voiceLanguageWrap').classList.toggle('hide',upload);
 $('voicePauseWrap').classList.toggle('hide',!dialogue);$('voiceNoiseWrap').classList.toggle('hide',tool!=='voice-changer');
 $('voiceSettingsPanel').classList.toggle('hide',cloning||tool==='dubbing');
 $('voiceModelName').textContent=tool==='voice-changer'?'ElevenLabs speech-to-speech v2':tool==='dubbing'?'ElevenLabs · Service-managed dubbing model':'Eleven v4';
 $('voiceText').placeholder=dialogue?'Alice: Hello, how are you?\nBob: Great! What are we creating today?':'Type or paste your speech text…';
 $('voiceUploadHelp').textContent=tool==='voice-changer'?'Audio · up to 50 MB and 5 minutes':'Audio or video · up to 100 MB and 2.5 hours';
 $('voiceFile').accept=tool==='voice-changer'?'audio/*':'audio/*,video/mp4,video/quicktime,video/webm';
 $('generateVoiceBtn').textContent=tool==='dubbing'?'Start dubbing':tool==='voice-changer'?'Change voice':dialogue?'Generate dialogue':'Generate speech';
 applyVoiceCapabilities();
 voiceMessage((tool==='speech'||dialogue)&&voiceOptions.modelError?voiceOptions.modelError:'');
}
function applyVoiceCapabilities(){
 const speech=voiceTool==='speech'||voiceTool==='dialogue',caps=speech?(voiceOptions.model?.capabilities||{}):{similarity:true,style:true,speakerBoost:true};
 for(const [key,node] of [['speed','voiceSpeed'],['similarity','voiceSimilarity'],['style','voiceStyle'],['speakerBoost','voiceSpeakerBoost']]){
  $(node).disabled=!caps[key];$(node+'Wrap').classList.toggle('hide',!caps[key]);
 }
 $('voiceStability').step=caps.discreteStability?'.5':'.01';
 if(caps.discreteStability)$('voiceStability').value=String(Math.round(Number($('voiceStability').value)*2)/2);
 $('generateVoiceBtn').disabled=speech?(!voiceOptions.model||!voiceOptions.voices?.length):!voiceOptions.voices?.length;
 $('voiceSettingsNote').textContent=speech?'Only controls supported by Eleven v4 are shown.':'Speech-to-speech preserves your recording’s delivery. Speed is controlled by the source audio.';
 voiceControlLabels();
}
function fillVoiceLanguages(node,items,preferred='en'){
 const old=node.value;node.innerHTML=items.map(l=>'<option value="'+escapeHtml(l.code)+'">'+escapeHtml(l.name)+'</option>').join('');
 node.value=items.some(l=>l.code===old)?old:items.some(l=>l.code===preferred)?preferred:(items[0]?.code||'');
}
async function loadVoiceOptions(){
 if(!config?.voice?.enabled)return;const seq=++voiceOptionsSeq;
 try{
  const pickerOpen=Boolean($('voicePickerDialog')?.open);
  const nativeLanguage=pickerOpen&&!(typeof voicePickerShowCompatible==='boolean'&&voicePickerShowCompatible)?$('vpLanguage').value:'';
  const params=new URLSearchParams({search:$('voiceSearch').value.trim()});
  if(nativeLanguage)params.set('language',nativeLanguage);
  const d=await api('/api/voice-options?'+params.toString());if(seq!==voiceOptionsSeq)return;
  // Preserve choices across remote searches: filtered results must not reset the chosen voice.
  const incoming=Array.isArray(d.voices)?d.voices:[],previous=voiceOptions.voices||[],old=$('voiceSelect').value;
  voiceOptions={...d,voices:[...new Map([...previous,...incoming].map(v=>[v.id,v])).values()]};
  $('voiceSelect').innerHTML=voiceSelectOptions();if(voiceOptions.voices.some(v=>v.id===old))$('voiceSelect').value=old;
  $('voiceText').maxLength=d.model?.maxTextChars||5000;
  fillVoiceLanguages($('voiceLanguage'),d.speechLanguages||[]);
  fillVoiceLanguages($('voiceDubSource'),d.dubbingLanguages||[]);fillVoiceLanguages($('voiceDubTarget'),d.dubbingLanguages||[],'ur');
  fillVoiceLanguages($('cloneLanguage'),d.cloneLanguages||[],'English');fillVoiceLanguages($('cloneSpeechLanguage'),d.cloneLanguages||[],'English');
  $('clonePrice').textContent=Number.isFinite(d.cloneCost)?Number(d.cloneCost).toLocaleString(undefined,{maximumFractionDigits:4})+' credits':'Pricing unavailable';
  for(const row of document.querySelectorAll('.voice-speaker-row')){
   const select=row.querySelector('[data-speaker-voice]'),value=select.value;select.innerHTML=voiceSelectOptions();if(voiceOptions.voices.some(v=>v.id===value))select.value=value;
   fillVoiceLanguages(row.querySelector('[data-speaker-language]'),d.speechLanguages||[]);
  }
  if(!$('voiceDialogueSpeakers').children.length){addVoiceSpeaker('Alice');addVoiceSpeaker('Bob');}
  if(typeof updateVoicePickerCatalog==='function')updateVoicePickerCatalog(incoming);
  applyVoiceCapabilities();voiceInvalidate();if(d.modelError&&['speech','dialogue'].includes(voiceTool))voiceMessage(d.modelError,true);
 }catch(e){voiceMessage(e.message,true);$('generateVoiceBtn').disabled=true;if(typeof voicePickerCatalogError==='function')voicePickerCatalogError(e.message);}
}
function voiceSelectOptions(){return (voiceOptions.voices||[]).map(v=>'<option value="'+escapeHtml(v.id)+'">'+escapeHtml(v.name)+'</option>').join('');}
function addVoiceSpeaker(name=''){
 if($('voiceDialogueSpeakers').children.length>=8)return;
 const row=document.createElement('div');row.className='voice-speaker-row';
 row.innerHTML='<div class="control-grid"><input data-speaker-name aria-label="Speaker name" maxlength="40" placeholder="Speaker name" value="'+escapeHtml(name)+'"><div><select data-speaker-voice aria-label="Speaker voice">'+voiceSelectOptions()+'</select><button type="button" class="btn secondary vp-speaker-picker" data-pick-speaker>Browse voices</button></div><select data-speaker-language aria-label="Speaker language"></select><button type="button" class="btn secondary" data-remove-speaker>Remove</button></div>';
 fillVoiceLanguages(row.querySelector('[data-speaker-language]'),voiceOptions.speechLanguages||[]);
 row.querySelector('[data-remove-speaker]').onclick=()=>{row.remove();voiceInvalidate();};row.querySelector('[data-pick-speaker]').onclick=()=>openVoicePicker(row.querySelector('[data-speaker-voice]'));row.oninput=voiceInvalidate;row.onchange=voiceInvalidate;
 $('voiceDialogueSpeakers').appendChild(row);voiceInvalidate();
}
function playVoiceSample(audio,url,name,onError,onPlaying=null){
 const unavailable=()=>onError('The provider sample for '+name+' is unavailable. You can still select this voice.');
 audio.pause();audio.src=url.href;
 audio.onplaying=onPlaying;
 audio.onerror=unavailable;
 audio.load();
 audio.play().catch(error=>{
  if(audio.onerror!==unavailable||error.name==='AbortError')return;
  if(error.name==='NotAllowedError')onError('Playback was blocked by the browser. Press play on the audio player.');
  else unavailable();
 });
}
function previewStudioVoice(){
 const v=(voiceOptions.voices||[]).find(v=>v.id===$('voiceSelect').value),audio=$('voicePreview');
 if(!v?.previewUrl){voiceMessage('This voice has no provider preview sample.');return;}
 try{
  const url=new URL(v.previewUrl,window.location.origin);
  if(url.origin!==window.location.origin||!url.pathname.startsWith('/api/voice-preview/'))
   throw Error('Invalid voice preview source.');
  audio.classList.remove('hide');
  voiceMessage('Loading '+v.name+'…');
  playVoiceSample(audio,url,v.name,message=>voiceMessage(message,true),()=>voiceMessage(v.name));
 }catch(e){voiceMessage('Preview unavailable for this voice.',true);}
}
function voiceInput(){
 const body={operation:voiceTool,text:$('voiceText').value.trim(),voiceId:$('voiceSelect').value,languageCode:$('voiceLanguage').value,
  speed:Number($('voiceSpeed').value),stability:Number($('voiceStability').value),similarityBoost:Number($('voiceSimilarity').value),style:Number($('voiceStyle').value),useSpeakerBoost:$('voiceSpeakerBoost').checked,removeNoise:$('voiceNoise').checked,
  sourceLanguage:$('voiceDubSource').value,targetLanguage:$('voiceDubTarget').value,pauseBetweenTurns:Number($('voicePause').value)};
 if(voiceTool==='dialogue')body.speakers=[...document.querySelectorAll('.voice-speaker-row')].map(row=>({name:row.querySelector('[data-speaker-name]').value.trim(),voiceId:row.querySelector('[data-speaker-voice]').value,languageCode:row.querySelector('[data-speaker-language]').value}));
 const file=['voice-changer','dubbing'].includes(voiceTool)?$('voiceFile').files[0]:null;
 if(['voice-changer','dubbing'].includes(voiceTool)&&!file)throw Error('Choose a source media file.');
 if(file&&file.size>(voiceTool==='voice-changer'?50:100)*1024*1024)throw Error('This file exceeds the upload limit.');
 const signature=JSON.stringify({...body,file:file?{name:file.name,size:file.size,lastModified:file.lastModified}:null});
 return {body,file,signature};
}
function voiceRequest(input){if(!input.file)return {method:'POST',body:JSON.stringify(input.body)};const form=new FormData();form.append('payload',JSON.stringify(input.body));form.append('file',input.file,input.file.name);return {method:'POST',body:form};}
function scheduleVoiceCost(){voiceInvalidate();clearTimeout(voiceCostTimer);if(['speech','dialogue'].includes(voiceTool)&&$('voiceText').value.trim())voiceCostTimer=setTimeout(updateVoiceCost,500);}
async function updateVoiceCost(){
 const seq=++voiceCostRequestSeq;
 try{
  const input=voiceInput();$('voiceCost').textContent='…';const d=await voiceApi('/api/voice-cost',voiceRequest(input));
  if(seq!==voiceCostRequestSeq)return;voiceQuote={signature:input.signature,cost:Number(d.cost)};$('voiceCost').textContent=Number(d.cost).toLocaleString(undefined,{maximumFractionDigits:4});
  voiceMessage(d.sourceDuration?'Source duration: '+Number(d.sourceDuration).toFixed(1)+' seconds. Final provider usage is reconciled after processing.':'');
 }catch(e){if(seq===voiceCostRequestSeq){voiceQuote=null;$('voiceCost').textContent='—';voiceMessage(e.message,true);}}
}
async function createVoiceGeneration(){
 const button=$('generateVoiceBtn');button.disabled=true;
 try{
  let input=voiceInput();if(!voiceQuote||voiceQuote.signature!==input.signature)await updateVoiceCost();
  input=voiceInput();if(!voiceQuote||voiceQuote.signature!==input.signature)throw Error('Check the credit estimate before generating.');
  if(voiceKeySignature!==input.signature){voiceKey=crypto.randomUUID();voiceKeySignature=input.signature;}
  input.body.requestKey=voiceKey;input.body.expectedCost=voiceQuote.cost;voiceMessage('Uploading and queueing…');
  const d=await voiceApi('/api/voice-generations',voiceRequest(input));me=d.user;syncUser();voiceKey=null;voiceKeySignature=null;
  if(input.file)$('voiceFile').value='';else $('voiceText').value='';voiceInvalidate();voiceMessage('Queued. Your result will appear in voice history.');
  await Promise.all([loadVoiceGenerations(),loadDashboard(),loadCredits()]);
 }catch(e){voiceMessage(e.message,true);}finally{applyVoiceCapabilities();}
}
async function loadVoiceGenerations(){
 if(!config?.voice?.enabled||voiceGenerationLoadPending)return;voiceGenerationLoadPending=true;
 try{const d=await api('/api/voice-generations');voiceGenerations=d.generations||[];renderVoiceHistory();}catch(e){if(e.status===401)location.reload();}finally{voiceGenerationLoadPending=false;}
}
async function loadVoiceClones({reportError=true}={}){
 if(!config?.voice?.enabled)return;
 try{
  const d=await api('/api/voice-clones');voiceClones=d.clones||[];
  $('voiceCloneList').innerHTML=voiceClones.length?voiceClones.map(c=>'<div class="provider-access-item" style="padding:10px"><div><strong>'+escapeHtml(c.voice_name)+'</strong><div class="muted">'+escapeHtml(c.language_tag||'')+'</div>'+(c.error_message?'<div class="msg err">'+escapeHtml(c.error_message)+'</div>':'')+'</div><span class="badge '+escapeHtml(c.status)+'">'+escapeHtml(c.status)+'</span></div>').join(''):'<div class="muted">No cloned voices yet.</div>';
  const select=$('cloneSpeechVoice'),old=select.value;select.innerHTML=voiceClones.filter(c=>c.status==='done').map(c=>'<option value="'+Number(c.id)+'">'+escapeHtml(c.voice_name)+'</option>').join('');if([...select.options].some(o=>o.value===old))select.value=old;
  $('cloneSpeechBtn').disabled=!select.value;
 }catch(e){if(reportError)$('cloneVoiceMsg').textContent='Could not refresh your cloned voices. Try refreshing Voice Studio.';}
}

async function prepareCloneAudio(file){
 const type=file.type.toLowerCase();
 const generic=!type||type==='application/octet-stream';
 const mp3=['audio/mpeg','audio/mp3','audio/x-mp3'].includes(type)||(generic&&/\.mp3$/i.test(file.name));
 const wav=['audio/wav','audio/x-wav','audio/wave','audio/vnd.wave'].includes(type)||(generic&&/\.wav$/i.test(file.name));
 if((mp3||wav)&&file.size<=15*1024*1024){
  const mimeType=mp3?'audio/mpeg':'audio/wav';
  return new File([file],mp3?'voice-sample.mp3':'voice-sample.wav',{type:mimeType});
 }

 // Convert recordings (such as iPhone M4A) to a compact, provider-compatible WAV.
 const sampleRate=24000;
 let audio;
 try{
  const Context=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  const context=new Context(1,1,sampleRate);
  audio=await context.decodeAudioData(await file.arrayBuffer());
 }catch{
  throw new Error('This browser could not open the recording. Choose a playable MP3, WAV, or M4A file.');
 }
 if(audio.duration<10||audio.duration>300)throw new Error('Use a voice sample lasting 10 seconds to 5 minutes.');
 const dataBytes=audio.length*2;
 const buffer=new ArrayBuffer(44+dataBytes),header=new DataView(buffer);
 const label=(offset,value)=>{for(let i=0;i<value.length;i++)header.setUint8(offset+i,value.charCodeAt(i));};
 label(0,'RIFF');header.setUint32(4,36+dataBytes,true);
 label(8,'WAVE');label(12,'fmt ');header.setUint32(16,16,true);
 header.setUint16(20,1,true);header.setUint16(22,1,true);
 header.setUint32(24,audio.sampleRate,true);header.setUint32(28,audio.sampleRate*2,true);
 header.setUint16(32,2,true);header.setUint16(34,16,true);
 label(36,'data');header.setUint32(40,dataBytes,true);
 const channels=Array.from({length:audio.numberOfChannels},(_,i)=>audio.getChannelData(i));
 for(let i=0;i<audio.length;i++){
  let sum=0;
  for(const channel of channels)sum+=channel[i];
  const sample=Math.max(-1,Math.min(1,sum/channels.length));
  header.setInt16(44+i*2,Math.round(sample*(sample<0?32768:32767)),true);
 }
 return new File([buffer],'voice-sample.wav',{type:'audio/wav'});
}

async function createVoiceClone(){
 const b=$('cloneVoiceBtn'),m=$('cloneVoiceMsg'),input=$('cloneVoiceFile'),file=input.files[0],name=$('cloneVoiceName').value.trim();
 if(b.disabled)return;
 if(!file||!name){m.textContent='Choose an audio sample and a voice name.';return;}
 if(file.size>20*1024*1024){m.textContent='Voice samples must be 20 MB or smaller.';return;}
 const data={voice_name:name,language_tag:$('cloneLanguage').value,gender:$('cloneGender').value,preview_text:$('clonePreview').value||'Hello'};
 const signature=JSON.stringify(data);
 if(pendingClone?.source!==file||pendingClone.signature!==signature){
  pendingClone={source:file,signature,key:crypto.randomUUID(),audio:null};
 }
 const request=pendingClone;
 b.disabled=true;m.textContent='Preparing your voice recording…';
 try{
  const audio=request.audio??=await prepareCloneAudio(file);
  m.textContent='Uploading clone sample…';
  let uploads=null;
  if(audio.size>=512*1024){
   try{uploads=await uploadReferencesDirect([{kind:'audio',item:{file:audio,filename:audio.name}}],m);}
   catch(error){if(error.status&&error.status<500)throw error;}
  }
  const fields={...data,requestKey:request.key};
  let body;
  if(uploads?.length){
   body=JSON.stringify({...fields,audioUploads:uploads.map(entry=>entry.upload)});
   m.textContent='Submitting your clone…';
  }else{
   m.textContent='Uploading clone sample…';
   body=new FormData();
   for(const [key,value] of Object.entries(fields))body.append(key,value);
   body.append('file',audio,audio.name);
  }
  const result=await voiceApi('/api/voice-clones',{method:'POST',body,signal:AbortSignal.timeout(120000)});
  if(!result?.clone?.id)throw new Error('The server did not confirm the clone. Try again with the same sample.');
  pendingClone=null;
  if(input.files[0]===file)input.value='';
  m.textContent='Clone queued. Refresh to check its progress.';
  await Promise.allSettled([loadVoiceClones({reportError:false}),loadCredits(),loadDashboard()]);
 }catch(error){
  m.textContent=error.status===413?'The host rejected the upload size. Try a shorter recording.'
   : ['TypeError','TimeoutError','AbortError'].includes(error.name)
    ? 'The upload connection was interrupted. Tap Create cloned voice again to retry.'
    : error.message;
 }finally{b.disabled=false;}
}
let cloneSpeechKey=null,cloneSpeechSignature=null;
async function createCloneSpeech(){
 const b=$('cloneSpeechBtn'),m=$('cloneSpeechMsg');b.disabled=true;
 try{
  const body={operation:'clone-speech',cloneId:Number($('cloneSpeechVoice').value),text:$('cloneSpeechText').value.trim(),languageCode:$('cloneSpeechLanguage').value,speed:Number($('cloneSpeechSpeed').value)};
  const signature=JSON.stringify(body);if(signature!==cloneSpeechSignature){cloneSpeechKey=crypto.randomUUID();cloneSpeechSignature=signature;}
  if(!body.text||!body.cloneId)throw Error('Choose your completed clone and enter text.');
  const quote=await voiceApi('/api/voice-cost',{method:'POST',body:JSON.stringify(body)});
  // Show the quote before a second deliberate click submits the paid request.
  if(b.dataset.quoteSignature!==signature||Number(b.dataset.quoteCost)!==quote.cost){b.dataset.quoteSignature=signature;b.dataset.quoteCost=String(quote.cost);m.textContent=Number(quote.cost).toLocaleString(undefined,{maximumFractionDigits:4})+' credits. Click Generate with clone again to submit.';return;}
  await voiceApi('/api/voice-generations',{method:'POST',body:JSON.stringify({...body,requestKey:cloneSpeechKey,expectedCost:quote.cost})});
  cloneSpeechKey=null;cloneSpeechSignature=null;delete b.dataset.quoteSignature;$('cloneSpeechText').value='';m.textContent='Cloned speech queued.';await Promise.all([loadVoiceGenerations(),loadCredits(),loadDashboard()]);
 }catch(e){m.textContent=e.message;}finally{b.disabled=!$('cloneSpeechVoice').value;}
}
async function refreshVoiceStudio(){await Promise.all([loadVoiceOptions(),loadVoiceGenerations(),loadVoiceClones()]);}

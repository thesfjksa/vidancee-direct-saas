
'use strict';
let voicePickerTab='all',voicePickerTarget=null,voicePickerLatest=[],voicePickerTimer=null,voicePickerPlaying=null,voicePickerLoading=false,voicePickerShowCompatible=false,voicePickerError='',voicePickerRequestSeq=0,voicePickerSource='default',voicePickerNotice='';
const voicePickerFavoriteKey='cmm_voice_favorites_v1';
function voicePickerFavorites(){try{return new Set(JSON.parse(localStorage.getItem(voicePickerFavoriteKey)||'[]').filter(x=>typeof x==='string'));}catch{return new Set();}}
function voicePickerStoredFavorites(){try{const rows=JSON.parse(localStorage.getItem('cmm_voice_favorite_records_v1')||'[]');return Array.isArray(rows)?rows.filter(x=>x&&typeof x.id==='string'&&typeof x.name==='string').slice(0,200):[];}catch{return [];}}
function voicePickerSaveFavorites(ids){
 try{
  localStorage.setItem(voicePickerFavoriteKey,JSON.stringify([...ids]));
  const known=[...(voiceOptions.voices||[]),...voicePickerStoredFavorites()];
  localStorage.setItem('cmm_voice_favorite_records_v1',JSON.stringify([...new Map(known.filter(x=>ids.has(x.id)).map(v=>[v.id,v])).values()].slice(0,200)));
 }catch{}
}
function voicePickerSelectNode(){return $('voicePickerDialog');}
function voicePickerText(s){return String(s??'').trim();}
function voicePickerField(voice,field){return voicePickerText(voice[field]);}
function voicePickerCurrentId(){return $('voiceSelect')?.value||'';}
function updateVoiceSelectedLabel(){
 const v=(voiceOptions.voices||[]).find(x=>x.id===voicePickerCurrentId());
 const label=$('voiceSelectedLabel');if(label)label.textContent=v?.name||'Choose a voice';
}
function voicePickerSetFilters(){
 const voices=voicePickerSelectNode()?.open?voicePickerLatest:(voiceOptions.voices||[]);
 const fields=['accent','quality','gender','age','category'];
 for(const field of fields){
  const node=$('vp'+field[0].toUpperCase()+field.slice(1));if(!node)continue;
  const old=node.value,values=[...new Set(voices.map(v=>voicePickerField(v,field)).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  node.innerHTML='<option value="">Any</option>'+values.map(v=>'<option value="'+escapeHtml(v)+'">'+escapeHtml(v)+'</option>').join('');
  node.value=values.includes(old)?old:'';
  node.disabled=!values.length;
 }
 const lng=$('vpLanguage');if(lng){
  const old=lng.value,langs=voiceOptions.speechLanguages||[];
  lng.innerHTML='<option value="">Any language</option>'+langs.map(l=>'<option value="'+escapeHtml(l.code)+'">'+escapeHtml(l.name)+'</option>').join('');
  lng.value=langs.some(l=>l.code===old)?old:'';
 }
}
function updateVoicePickerCatalog(incoming){
 voicePickerLatest=Array.isArray(incoming)?incoming:[];
 voicePickerLoading=false;voicePickerError='';
 updateVoiceSelectedLabel();
 voicePickerSetFilters();
 const dialog=voicePickerSelectNode();if(dialog?.open)renderVoicePicker();
}
function voicePickerCatalogError(message){voicePickerLoading=false;voicePickerError=String(message||'Unable to load the voice catalog.');renderVoicePicker();}
async function voicePickerFetch(){
 clearTimeout(voicePickerTimer);
 const seq=++voicePickerRequestSeq;
 voicePickerLoading=true;voicePickerError='';voicePickerLatest=[];
 const language=$('vpLanguage').value;
 const params=new URLSearchParams({search:$('vpSearch').value.trim()});
 if(language)params.set('language',language);
 if(voicePickerShowCompatible||voicePickerTab==='default')params.set('mode','defaults');
 renderVoicePicker();
 try{
  const d=await api('/api/voice-library?'+params.toString());
  if(seq!==voicePickerRequestSeq||!voicePickerSelectNode()?.open)return;
  voicePickerSource=d.source||'default';
  voicePickerNotice=d.reason||'';
  const incoming=Array.isArray(d.voices)?d.voices:[];
  // Persist a new chosen voice in the generation selector, but never merge old
  // English defaults into the language-specific browse results.
  if(typeof voiceOptions!=='undefined'){
    voiceOptions.voices=[...new Map([...(voiceOptions.voices||[]),...incoming].map(v=>[v.id,v])).values()];
  }
  updateVoicePickerCatalog(incoming);
 }catch(e){
  if(seq===voicePickerRequestSeq&&voicePickerSelectNode()?.open)voicePickerCatalogError(e.message);
 }
}
function openVoicePicker(target){
 voicePickerTarget=target&&target.tagName==='SELECT'?target:$('voiceSelect');
 const dialog=voicePickerSelectNode();if(!dialog)return;
 voicePickerTab='all';voicePickerShowCompatible=false;$('vpSearch').value='';$('voiceSearch').value='';
 for(const node of dialog.querySelectorAll('[data-vp-filter]'))node.value=node.id==='vpSort'?'provider':'';
 voicePickerSetFilters();
 // Start browsing the full catalogue. The user explicitly applies a native-language
 // filter when they select a language in the popup.
 $('vpLanguage').value='';
 voicePickerLatest=[];
 for(const tab of dialog.querySelectorAll('[data-vp-tab]'))tab.setAttribute('aria-selected',String(tab.dataset.vpTab==='all'));
 if(!dialog.open)dialog.showModal();
 voicePickerFetch();
 $('vpSearch').focus();
}
function closeVoicePicker(){
 clearTimeout(voicePickerTimer);++voicePickerRequestSeq;
 const dlg=voicePickerSelectNode();if(dlg?.open)dlg.close();
 const audio=$('vpAudio');if(audio){audio.pause();audio.removeAttribute('src');audio.load();}
 voicePickerPlaying=null;voicePickerTarget=null;
}
function voicePickerChangeTab(tab){
 voicePickerTab=tab;
 voicePickerSelectNode().querySelectorAll('[data-vp-tab]').forEach(node=>node.setAttribute('aria-selected',String(node.dataset.vpTab===tab)));
 if(tab==='favourites')renderVoicePicker();else voicePickerFetch();
}
function voicePickerSetSearch(){
 clearTimeout(voicePickerTimer);
 const search=$('vpSearch').value.trim();
 voicePickerTimer=setTimeout(()=>{voicePickerFetch();},350);
 voicePickerLoading=true;voicePickerLatest=[];renderVoicePicker();
}
function voicePickerReset(){
 $('vpSearch').value='';$('voiceSearch').value='';
 for(const node of voicePickerSelectNode().querySelectorAll('[data-vp-filter]'))node.value=node.id==='vpSort'?'provider':'';
 voicePickerTab='all';voicePickerShowCompatible=false;voicePickerSelectNode().querySelectorAll('[data-vp-tab]').forEach(n=>n.setAttribute('aria-selected',String(n.dataset.vpTab==='all')));
 voicePickerFetch();
}
function voicePickerMatchesLanguage(v,code){
 if(!code||voicePickerShowCompatible||voicePickerSource==='shared')return true;
 const name=(voiceOptions.speechLanguages||[]).find(l=>l.code===code)?.name?.toLowerCase()||'';
 const values=[v.language,...(v.languages||[])].filter(x=>typeof x==='string').map(x=>x.trim().toLowerCase());
 return values.some(tag=>[code.toLowerCase(),name].some(term=>term&&(tag===term||tag.startsWith(term+'-')||tag.startsWith(term+'_'))));
}
function voicePickerChangeLanguage(){
 const code=$('vpLanguage').value;
 voicePickerShowCompatible=false;
 const target=voicePickerTarget?.closest('.voice-speaker-row')?.querySelector('[data-speaker-language]')||$('voiceLanguage');
 if(code&&target&&[...target.options].some(o=>o.value===code)){
  target.value=code;
  voiceInvalidate();
  scheduleVoiceCost();
 }
 voicePickerFetch();
}
function voicePickerMatches(v){
 const search=$('vpSearch').value.trim().toLowerCase();
 const corpus=[v.id,v.name,v.description,v.accent,v.category,v.gender,v.age,v.quality].map(x=>voicePickerText(x)).join(' ').toLowerCase();
 if(search&&!corpus.includes(search))return false;
 if(!voicePickerMatchesLanguage(v,$('vpLanguage').value))return false;
 for(const field of ['accent','quality','gender','age','category']){
  const filter=$('vp'+field[0].toUpperCase()+field.slice(1)).value.toLowerCase();
  if(filter&&voicePickerField(v,field).toLowerCase()!==filter)return false;
 }
 return true;
}
function voicePickerFiltered(){
 const favorites=voicePickerFavorites();
 const all=[...new Map([...voicePickerStoredFavorites(),...voicePickerLatest].map(v=>[v.id,v])).values()];
 const pool=voicePickerTab==='favourites'?all:voicePickerLatest;
 let matches=pool.filter(v=>{
  if(voicePickerTab==='favourites'&&!favorites.has(v.id))return false;
  if(voicePickerTab==='library'&&voicePickerSource!=='shared')return false;
  if(voicePickerTab==='default'&&voicePickerSource!=='default')return false;
  return voicePickerMatches(v);
 });
 const sort=$('vpSort').value;
 if(sort==='name')matches=matches.slice().sort((a,b)=>a.name.localeCompare(b.name));
 if(sort==='usage')matches=matches.slice().sort((a,b)=>(b.usageCount||0)-(a.usageCount||0));
 return matches;
}
function voicePickerBadge(value){return value?'<span>'+escapeHtml(value)+'</span>':'';}
function renderVoicePicker(){
 const root=$('vpCards');if(!root)return;
 const matches=voicePickerFiltered(),favorites=voicePickerFavorites(),current=voicePickerTarget?.value||voicePickerCurrentId();
 const language=$('vpLanguage').selectedOptions?.[0]?.textContent||'Any language';
 const langCode=$('vpLanguage').value;
 if(voicePickerLoading){
  $('vpStatus').textContent='Searching '+(langCode?language+'-labelled':'available')+' voices…';
  root.innerHTML='<div class="vp-empty">Searching the connected provider voice catalogue…</div>';return;
 }
 if(voicePickerError){
  $('vpStatus').textContent='Voice catalogue unavailable';
  root.innerHTML='<div class="vp-empty">'+escapeHtml(voicePickerError)+'</div>';return;
 }
 $('vpStatus').textContent='Showing '+matches.length+' '+(langCode&&!voicePickerShowCompatible?language+'-labelled ':'')+'voice'+(matches.length===1?'':'s')+'. '+(langCode?('Generation language: '+language+'. '):'')+(voicePickerShowCompatible?'Showing multilingual defaults, not verified native-language voices.':voicePickerSource==='shared'?'From Vibi shared-voice catalog.':'Voice labels are limited by the provider catalogue.')+(voicePickerNotice?' '+voicePickerNotice:'');
 if(!matches.length){
  const desc=voicePickerTab==='library'?'The connected Vibi catalog has no separate verified shared-voice collection.':langCode
   ?'No '+language+'-labelled voices are currently exposed by the connected Vibi default-voice catalog. Multilingual default voices can still synthesize '+language+'.'
   :'No voices match these filters. Try resetting them or searching another name.';
  root.innerHTML='<div class="vp-empty">'+escapeHtml(voicePickerSource==='unavailable'?(voicePickerNotice||'The voice library did not respond. Please retry.'):desc)+
    (voicePickerSource==='unavailable'?'<p><button type="button" class="vp-reset" data-voice-action="retry">Retry voice search</button></p>':langCode&&voicePickerTab==='all'?'<p><button type="button" class="vp-reset" data-voice-action="compatible">Browse multilingual default voices</button></p>':'')+'</div>';return;
 }
 root.innerHTML=matches.map(v=>{
  const active=current===v.id,liked=favorites.has(v.id);
  return '<article class="vp-card'+(active?' current':'')+'"><div class="vp-title">'+escapeHtml(v.name)+'</div>'+
   '<div class="vp-description">'+escapeHtml(v.description||'Listen to a sample and select this voice for your project.')+'</div>'+
   '<div class="vp-badges">'+voicePickerBadge(v.quality)+voicePickerBadge(v.gender)+voicePickerBadge(v.age)+voicePickerBadge(v.accent)+voicePickerBadge(v.category)+'</div>'+
   '<div class="vp-card-actions"><button type="button" class="vp-favorite" data-voice-action="favorite" data-voice-id="'+escapeHtml(v.id)+'" aria-label="'+(liked?'Remove from':'Add to')+' favourites" aria-pressed="'+liked+'">'+(liked?'♥':'♡')+'</button>'+
   '<button type="button" data-voice-action="play" data-voice-id="'+escapeHtml(v.id)+'" '+(!v.previewUrl?'disabled title="Preview unavailable"':'')+'>▶ Play</button>'+
   '<button type="button" class="vp-use" data-voice-action="use" data-voice-id="'+escapeHtml(v.id)+'">'+(active?'Selected':'Use')+'</button></div></article>';
 }).join('');
}
function previewVoicePickerVoice(id){
 const v=[...(voiceOptions.voices||[]),...voicePickerStoredFavorites()].find(x=>x.id===id),audio=$('vpAudio');
 if(!v?.previewUrl){$('vpNowPlaying').textContent='This voice has no provider preview audio.';return;}
 try{
  const url=new URL(v.previewUrl,window.location.origin);
  if(url.origin!==window.location.origin||!url.pathname.startsWith('/api/voice-preview/'))
   throw Error('Voice preview must come from the protected site player.');
  if(voicePickerPlaying===id&&!audio.paused){audio.pause();return;}
  voicePickerPlaying=id;$('vpNowPlaying').textContent='Loading '+v.name+'…';
  audio.pause();audio.src=url.href;audio.load();
  audio.onplaying=()=>{$('vpNowPlaying').textContent=v.name;};
  audio.onerror=()=>{$('vpNowPlaying').textContent='Provider sample could not be loaded for '+v.name+'.';};
  audio.play().catch(()=>{$('vpNowPlaying').textContent='Could not play sample. Check browser audio permissions or try another voice.';});
 }catch{$('vpNowPlaying').textContent='This voice has no valid preview link.';}
}
function useVoicePickerVoice(id){
 const v=[...(voiceOptions.voices||[]),...voicePickerStoredFavorites()].find(x=>x.id===id),target=voicePickerTarget||$('voiceSelect');
 if(!v||!target)return;
 if(!voiceOptions.voices.some(x=>x.id===v.id))voiceOptions.voices.push(v);
 if(![...target.options].some(o=>o.value===id)){
  const option=document.createElement('option');option.value=id;option.textContent=v.name;target.appendChild(option);
 }
 target.value=id;
 voiceInvalidate();scheduleVoiceCost();
 updateVoiceSelectedLabel();closeVoicePicker();
}
document.addEventListener('click',event=>{
 const action=event.target.closest('[data-voice-action]');
 if(!action||!voicePickerSelectNode()?.contains(action))return;
 const id=action.dataset.voiceId;
 if(action.dataset.voiceAction==='retry')voicePickerFetch();
 else if(action.dataset.voiceAction==='compatible'){voicePickerShowCompatible=true;voicePickerFetch();}
 else if(action.dataset.voiceAction==='use')useVoicePickerVoice(id);
 else if(action.dataset.voiceAction==='play')previewVoicePickerVoice(id);
 else if(action.dataset.voiceAction==='favorite'){
  const fav=voicePickerFavorites();fav.has(id)?fav.delete(id):fav.add(id);voicePickerSaveFavorites(fav);renderVoicePicker();
 }
});
document.addEventListener('DOMContentLoaded',()=>{
 const dlg=voicePickerSelectNode();if(!dlg)return;
 dlg.addEventListener('click',event=>{if(event.target===dlg)closeVoicePicker();});
 dlg.addEventListener('close',()=>{const audio=$('vpAudio');if(audio)audio.pause();voicePickerTarget=null;});
 $('vpSearch').addEventListener('input',voicePickerSetSearch);
 for(const node of dlg.querySelectorAll('[data-vp-filter]'))node.addEventListener('change',node.id==='vpLanguage'?voicePickerChangeLanguage:renderVoicePicker);
 dlg.querySelectorAll('[data-vp-tab]').forEach(node=>node.addEventListener('click',()=>voicePickerChangeTab(node.dataset.vpTab)));
 $('vpReset').addEventListener('click',voicePickerReset);
 $('vpClose').addEventListener('click',closeVoicePicker);
});

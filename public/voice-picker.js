
'use strict';
let voicePickerTab='all',voicePickerTarget=null,voicePickerLatest=[],voicePickerTimer=null,voicePickerPlaying=null;
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
 const voices=voiceOptions.voices||[];
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
 updateVoiceSelectedLabel();
 voicePickerSetFilters();
 const dialog=voicePickerSelectNode();if(dialog?.open)renderVoicePicker();
}
function openVoicePicker(target){
 voicePickerTarget=target&&target.tagName==='SELECT'?target:$('voiceSelect');
 const dialog=voicePickerSelectNode();if(!dialog)return;
 voicePickerTab='all';$('vpSearch').value='';$('voiceSearch').value='';
 for(const node of dialog.querySelectorAll('[data-vp-filter]'))node.value='';
 voicePickerSetFilters();
 voicePickerLatest=(voiceOptions.voices||[]).slice();
 for(const tab of dialog.querySelectorAll('[data-vp-tab]'))tab.setAttribute('aria-selected',String(tab.dataset.vpTab==='all'));
 if(!dialog.open)dialog.showModal();
 renderVoicePicker();
 $('vpSearch').focus();
}
function closeVoicePicker(){
 clearTimeout(voicePickerTimer);
 const dlg=voicePickerSelectNode();if(dlg?.open)dlg.close();
 const audio=$('vpAudio');if(audio){audio.pause();audio.removeAttribute('src');audio.load();}
 voicePickerPlaying=null;voicePickerTarget=null;
}
function voicePickerChangeTab(tab){
 voicePickerTab=tab;
 voicePickerSelectNode().querySelectorAll('[data-vp-tab]').forEach(node=>node.setAttribute('aria-selected',String(node.dataset.vpTab===tab)));
 renderVoicePicker();
}
function voicePickerSetSearch(){
 clearTimeout(voicePickerTimer);
 const search=$('vpSearch').value.trim();
 voicePickerTimer=setTimeout(()=>{$('voiceSearch').value=search;loadVoiceOptions().catch(()=>{});},350);
 renderVoicePicker();
}
function voicePickerReset(){
 $('vpSearch').value='';$('voiceSearch').value='';
 for(const node of voicePickerSelectNode().querySelectorAll('[data-vp-filter]'))node.value='';
 voicePickerTab='all';voicePickerSelectNode().querySelectorAll('[data-vp-tab]').forEach(n=>n.setAttribute('aria-selected',String(n.dataset.vpTab==='all')));
 loadVoiceOptions().catch(()=>{});renderVoicePicker();
}
function voicePickerMatchesLanguage(v,code){
 if(!code)return true;
 const tags=(v.languages||[]).map(x=>voicePickerText(x).toLowerCase());
 const lang=voicePickerText(v.language).toLowerCase();
 if(!tags.length&&!lang)return false; // Unknown language cannot be claimed as a match.
 const name=(voiceOptions.speechLanguages||[]).find(x=>x.code===code)?.name||'';
 return [code.toLowerCase(),name.toLowerCase()].some(x=>x&&(tags.includes(x)||lang===x));
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
 const favorites=voicePickerFavorites(),query=$('vpSearch').value.trim(),all=[...new Map([...(voiceOptions.voices||[]),...voicePickerStoredFavorites()].map(v=>[v.id,v])).values()];
 const pool=query&&voicePickerTab!=='favourites'?all.filter(v=>voicePickerLatest.some(x=>x.id===v.id)):all;
 let matches=pool.filter(v=>{
  if(voicePickerTab==='favourites'&&!favorites.has(v.id))return false;
  if(voicePickerTab==='library'&&!(v.category&&/shared|professional|community|library/i.test(v.category)))return false;
  if(voicePickerTab==='default'&&v.category&&/shared|community|library/i.test(v.category))return false;
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
 $('vpStatus').textContent='Showing '+matches.length+' voice'+(matches.length===1?'':'s')+' from the connected catalog. Some voices have limited filter metadata.';
 if(!matches.length){
  const desc=voicePickerTab==='library'?'The connected provider has not supplied a separate shared/community voice library.':'No voices match these filters. Try resetting them or searching another name.';
  root.innerHTML='<div class="vp-empty">'+escapeHtml(desc)+'</div>';return;
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
 if(!v?.previewUrl){$('vpNowPlaying').textContent='Preview not available';return;}
 try{
  const url=new URL(v.previewUrl);
  if(url.protocol!=='https:')throw Error('Only secure previews are supported.');
  if(voicePickerPlaying===id&&!audio.paused){audio.pause();return;}
  voicePickerPlaying=id;$('vpNowPlaying').textContent=v.name;audio.src=url.href;audio.play().catch(()=>{$('vpNowPlaying').textContent='Preview unavailable';});
 }catch{$('vpNowPlaying').textContent='Preview unavailable';}
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
 if(action.dataset.voiceAction==='use')useVoicePickerVoice(id);
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
 for(const node of dlg.querySelectorAll('[data-vp-filter]'))node.addEventListener('change',renderVoicePicker);
 dlg.querySelectorAll('[data-vp-tab]').forEach(node=>node.addEventListener('click',()=>voicePickerChangeTab(node.dataset.vpTab)));
 $('vpReset').addEventListener('click',voicePickerReset);
 $('vpClose').addEventListener('click',closeVoicePicker);
});

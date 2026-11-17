'use strict';
const managedEnabled=document.getElementById('managedEnabled'),managedConsent=document.getElementById('managedConsent'),managedSave=document.getElementById('managedSave'),managedStatus=document.getElementById('managedStatus');
chrome.storage.local.get(['managedEnabled','managedConsent']).then(flags=>{managedEnabled.checked=flags.managedEnabled===true;managedConsent.checked=flags.managedConsent===true;});
managedSave.addEventListener('click',()=>{
 if(managedSave.disabled)return;
 if(managedEnabled.checked&&!managedConsent.checked){managedStatus.textContent='Confirm the profile routing notice first.';return;}
 const enabled=managedEnabled.checked,consent=managedConsent.checked;
 const grant=enabled?chrome.permissions.request({permissions:['webRequest','webRequestAuthProvider']}):Promise.resolve(true);
 managedSave.disabled=true;
 void (async()=>{
  try{
   if(!await grant)throw Error('Proxy permissions were not granted.');
   const result=await new Promise((resolve,reject)=>chrome.runtime.sendMessage({type:'CMMTOOLS_MANAGED_SAVE',enabled,consent},response=>{
    if(chrome.runtime.lastError||!response?.ok)reject(Error(chrome.runtime.lastError?.message||response?.error||'Could not save.'));else resolve(response);
   }));
   managedStatus.textContent=result.ok?'Saved. Close AIVID tabs and open Studio. Sign in to CMMTools if the connection page asks.':'Could not save.';
  }catch(e){managedStatus.textContent=e.message;}finally{managedSave.disabled=false;}
 })();
});

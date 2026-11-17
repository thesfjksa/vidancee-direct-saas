'use strict';
const q=new URLSearchParams(location.search),extensionId=q.get('extensionId'),nonce=q.get('nonce');
const message=document.getElementById('status'),retry=document.getElementById('retry');
let busy=false;
async function connect(){
 if(busy)return;busy=true;retry.disabled=true;
 try{
  if(!/^[a-p]{32}$/.test(extensionId||'')||!/^[a-f0-9]{32}$/.test(nonce||'')||!window.chrome?.runtime?.sendMessage)throw Error('Open this connection page from the installed CMMTools extension.');
  const r=await fetch('/api/extension/proxy-config',{credentials:'same-origin',cache:'no-store',redirect:'error'});
  const result=await r.json();if(!r.ok||!result.ok)throw Error(result.error||'Could not load your connection.');
  message.textContent='Connecting the extension…';
  await new Promise((resolve,reject)=>chrome.runtime.sendMessage(extensionId,{type:'CMMTOOLS_MANAGED_CONFIG',nonce,config:result.config},response=>{
   if(chrome.runtime.lastError||!response?.ok)reject(Error('This connection request expired or the extension is unavailable. Close Studio and open it again.'));else resolve();
  }));
  message.textContent='Connected. Return to your Studio window.';
 }catch(e){message.textContent=e.message||'Connection failed. Sign in and retry.';}
 finally{busy=false;retry.disabled=false;}
}
retry.addEventListener('click',connect);void connect();

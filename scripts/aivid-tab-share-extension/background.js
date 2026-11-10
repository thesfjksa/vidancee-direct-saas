'use strict';
// Clicking the extension on the ordinary manually opened AIVID tab grants the
// short-lived activeTab permission for screenshots. Never inject page scripts.
const isAivid=url=>{
 try{const u=new URL(url);return u.protocol==='https:'&&(u.hostname==='aivid.dev'||u.hostname.endsWith('.aivid.dev'));}catch{return false;}
};
chrome.action.onClicked.addListener(async tab=>{
 try{
  if(!tab?.id||!Number.isInteger(tab.windowId)||!isAivid(tab.url||'')){
   await chrome.windows.create({url:chrome.runtime.getURL('controller.html?invalid=1'),type:'popup',width:460,height:620});
   return;
  }
  const target=chrome.runtime.getURL('controller.html')+'?tab='+encodeURIComponent(tab.id)+'&window='+encodeURIComponent(tab.windowId);
  await chrome.windows.create({url:target,type:'popup',width:460,height:620,focused:true});
 }catch(error){console.warn('Unable to open manual tab sharing controller:',error?.message||error);}
});

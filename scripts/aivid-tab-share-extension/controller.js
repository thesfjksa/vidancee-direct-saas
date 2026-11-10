'use strict';
// This controller NEVER uses chrome.scripting, chrome.debugger, CDP, Playwright
// or JavaScript executed on AIVID. It invokes only Edge's tab screenshot API.
const ORIGIN='https://cmmtools.site';
const $=id=>document.getElementById(id);
const query=new URLSearchParams(location.search);
const tabId=Number(query.get('tab')),windowId=Number(query.get('window'));
const validSelection=Number.isSafeInteger(tabId)&&tabId>0&&Number.isSafeInteger(windowId)&&windowId>0;
const isAivid=value=>{
  try{const u=new URL(value);return u.protocol==='https:'&&(u.hostname==='aivid.dev'||u.hostname.endsWith('.aivid.dev'));}catch{return false;}
};
let token='',expires=0,sharing=false,busy=false,timer=null,lastMessage='';
function notice(message,error=false){
 if(message===lastMessage&&!error)return;
 lastMessage=message;$('status').textContent=message;$('status').classList.toggle('error',error);
}
function buttons(){
 $('pair').disabled=busy||sharing||!validSelection;
 $('start').disabled=busy||sharing||!token||Date.now()>=expires;
 $('stop').disabled=busy||!token;
}
async function request(route,body,headers={}){
 const response=await fetch(ORIGIN+'/api/aivid-tab-share/'+route,{
  method:'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',
  headers,body
 });
 let result;
 try{result=await response.json();}catch{throw Error('CMMTools did not return a valid sharing response.');}
 if(!response.ok||!result?.ok)throw Error(result?.error||'CMMTools rejected the request.');
 return result;
}
async function checkSelected(){
 if(!validSelection)throw Error('Open https://aivid.dev manually and click the CMMTools extension icon while its tab is active.');
 const tab=await chrome.tabs.get(tabId);
 const [current]=await chrome.tabs.query({active:true,windowId});
 if(!tab||!current||tab.id!==current.id||!tab.active||!isAivid(tab.url||'')||!isAivid(current.url||''))
  throw Error('Sharing paused. Select the original AIVID tab in your normal Edge window.');
 return true;
}
async function captureOnce(){
 if(!sharing||busy)return;
 if(Date.now()>=expires){sharing=false;token='';notice('Pairing expired. Generate a new code in CMMTools Admin.',true);buttons();return;}
 busy=true;
 try{
  await checkSelected();
  let data=await chrome.tabs.captureVisibleTab(windowId,{format:'jpeg',quality:42});
  // Recheck AFTER capture so a rapid tab change cannot publish another tab.
  await checkSelected();
  let bytes=await (await fetch(data)).arrayBuffer();
  if(bytes.byteLength>350*1024){
    data=await chrome.tabs.captureVisibleTab(windowId,{format:'jpeg',quality:22});
    await checkSelected();bytes=await (await fetch(data)).arrayBuffer();
  }
  if(bytes.byteLength>350*1024)throw Error('AIVID screenshot exceeds 350 KiB. Reduce Edge zoom or window size.');
  await request('frame',bytes,{'content-type':'image/jpeg','x-cmm-share-token':token});
  notice('Sharing the selected AIVID tab (read-only).\nYou can operate AIVID normally in Edge. Keep this controller open.');
 }catch(error){
  const message=error?.message||'Screenshot capture stopped.';
  if(/expired|revoked|rejected|disabled|401|403/i.test(message)){
   sharing=false;token='';clearInterval(timer);timer=null;
  }
  notice(message,true);
 }finally{busy=false;buttons();}
}
$('pair').addEventListener('click',async()=>{
 if(busy)return;busy=true;buttons();
 try{
  await checkSelected();
  const code=$('code').value.trim().toUpperCase();
  if(!/^[A-F0-9]{32}$/.test(code))throw Error('Paste the 32-character code shown in CMMTools Admin.');
  const result=await request('pair',JSON.stringify({code}),{'content-type':'application/json'});
  token=result.token;expires=Date.parse(result.expiresAt);
  $('code').value='';notice('Paired securely. Click Start sharing to begin view-only screenshots.');
 }catch(e){notice(e.message||'Pairing failed.',true)}
 finally{busy=false;buttons();}
});
$('start').addEventListener('click',()=>{
 if(!token||Date.now()>=expires||sharing)return;
 sharing=true;buttons();notice('Sharing enabled. Select the AIVID tab in normal Edge. No remote controls are enabled.');
 // Low-frequency still frames, not full-rate video or a script controlling AIVID.
 timer=setInterval(captureOnce,2500);
 void captureOnce();
});
$('stop').addEventListener('click',async()=>{
 if(busy)return;sharing=false;clearInterval(timer);timer=null;
 busy=true;buttons();
 try{if(token)await request('disconnect',JSON.stringify({}),{'content-type':'application/json','x-cmm-share-token':token});}
 catch(e){notice('Sharing stopped locally. Server revoke failed; Admin can revoke the session.',true);}
 finally{token='';expires=0;busy=false;buttons();notice('Sharing stopped. Re-pair to restart.');}
});
window.addEventListener('pagehide',()=>{clearInterval(timer);sharing=false;token='';});
if(!validSelection)notice('No AIVID tab selected. Open AIVID manually, select its tab, then click the extension icon.',true);
else notice('Enter the one-time pairing code from CMMTools Admin. Your normal Edge AIVID tab stays untouched.');
buttons();

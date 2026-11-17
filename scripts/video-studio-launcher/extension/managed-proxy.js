'use strict';
(function(root){
 class ManagedProxy {
  constructor(api,manager,deadline=120000){this.api=api;this.manager=manager;this.deadline=deadline;this.pending=null;}
  async refresh(studioId){
   const flags=await this.api.storage.local.get(['managedEnabled','managedConsent']);
   if(!flags.managedEnabled)return;
   if(!flags.managedConsent||!await this.manager.permitted())throw Error('Open Connection settings and allow the managed connection first.');
   if(this.pending)throw Error('A managed connection is already opening.');
   const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);const nonce=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
   let resolve,reject;const done=new Promise((yes,no)=>{resolve=yes;reject=no;});
   const state={nonce,studioId,resolve,reject,windowId:null,timer:null};this.pending=state;
   state.timer=setTimeout(()=>this.cancel('Connection timed out. Sign in to CMMTools and reopen Studio.'),this.deadline);
   try{
    const window=await this.api.windows.create({url:'https://cmmtools.site/extension/connect?extensionId='+this.api.runtime.id+'&nonce='+nonce,type:'popup',incognito:false,width:650,height:620,focused:true});
    state.windowId=window.id;await done;
   }finally{
    clearTimeout(state.timer);if(this.pending===state)this.pending=null;
    if(state.windowId)await this.api.windows.remove(state.windowId).catch(()=>{});
   }
  }
  async accept(message,sender){
   const state=this.pending;let url;try{url=new URL(sender.url);}catch{return false;}
   if(!state||!state.windowId||url.origin!=='https://cmmtools.site'||url.pathname!=='/extension/connect'||sender.tab?.windowId!==state.windowId||message.nonce!==state.nonce)return false;
   const flags=await this.api.storage.local.get(['managedEnabled','managedConsent']);
   if(!flags.managedEnabled||!flags.managedConsent)return false;
   if(message.config?.enabled!==true||message.config?.includeDirect!==false)throw Error('Admin connection is not enabled.');
   // Never take routing consent from the website; it was granted in packaged Options.
   await this.manager.save({...message.config,directNetworkConfirmed:true});
   state.resolve();return true;
  }
  cancel(message='Connection cancelled.'){
   const state=this.pending;if(!state)return;this.pending=null;clearTimeout(state.timer);state.reject(Error(message));
  }
  removed(id){if(this.pending&&(id===this.pending.windowId||id===this.pending.studioId))this.cancel();}
 }
 if(typeof module!=='undefined')module.exports=ManagedProxy;else root.CMMManagedProxy=ManagedProxy;
})(globalThis);

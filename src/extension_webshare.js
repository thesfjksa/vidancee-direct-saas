'use strict';
const {importProxies} = require('./webshare_proxy.js');
const CORE = require('../scripts/video-studio-launcher/extension/proxy-core.js');
const CONFIG = 'extension_webshare_managed';
const failure = (message,statusCode=400) => Object.assign(Error(message),{statusCode});
function createExtensionWebshare({get,set,readProxies=importProxies}) {
  async function config() {
    let saved;
    try {saved=JSON.parse(await get(CONFIG,'{}'));} catch {throw failure('Saved Webshare configuration is unavailable.',503);}
    return {enabled:saved.enabled===true,country:saved.country||'',servers:Array.isArray(saved.servers)?saved.servers:[],apiKey:typeof saved.apiKey==='string'?saved.apiKey:''};
  }
  return {
    async save(body) {
      if(typeof body.enabled!=='boolean')throw failure('Choose whether the managed Webshare connection is enabled.');
      const country=String(body.country||'').trim().toUpperCase();if(country&&!/^[A-Z]{2}$/.test(country))throw failure('Use a two-letter country code or leave it blank.');
      const supplied=typeof body.apiKey==='string'?body.apiKey.trim():'';
      const key=supplied||(await config()).apiKey;
      if(!key){if(body.enabled)throw failure('Enter your Webshare API key first.');await set(CONFIG,JSON.stringify({enabled:false,country,servers:[]}),{secret:true});return this.status();}
      let imported;
      try {imported=await readProxies({permissions:{contains:async()=>true}},{apiKey:key,country});}
      catch {throw failure('Webshare sync failed. Check the saved key, direct proxy plan, country filter and connection.',502);}
      const normalized=CORE.normalize({enabled:body.enabled,includeDirect:false,directNetworkConfirmed:true,servers:imported.servers});
      // Validate and import before replacing any working settings. Both secrets use existing encrypted app_settings.
      await set(CONFIG,JSON.stringify({...normalized,country,apiKey:key}),{secret:true});
      return this.status();
    },
    async status() {const c=await config();return {enabled:c.enabled===true,configured:!!c.apiKey,serverCount:c.servers?.length||0,country:c.country||''};},
    async disable(){const c=await config();await set(CONFIG,JSON.stringify({...c,enabled:false}),{secret:true});return this.status();},
    async customer(user) {
      if(!user||user.status!=='active')throw failure('Sign in to your CMMTools account first.',401);
      const c=await config();
      if(!c.enabled||!c.servers.length)throw failure('The managed Webshare connection is not enabled. Contact CMMTools Admin.',503);
      return CORE.normalize({enabled:true,includeDirect:false,directNetworkConfirmed:true,servers:c.servers});
    }
  };
}
function connectPage() {
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CMMTools connection</title><body style="font:16px/1.6 system-ui;background:#0b1420;color:#edf5ff;padding:40px;max-width:620px;margin:auto"><h1>Connecting your Studio</h1><p id="status" role="status">Loading the connection configured by CMMTools Admin…</p><p><a style="color:#9bdfff" href="/app" target="_blank" rel="noopener noreferrer">Sign in to CMMTools</a></p><button id="retry" type="button">Retry connection</button><p>This shares the managed proxy settings with the CMMTools extension in this browser. Your Webshare account key stays on the server. Close this window to cancel.</p><script src="/extension/connect.js"></script></body></html>`;
}
module.exports={createExtensionWebshare,connectPage};

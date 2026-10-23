'use strict';
// Account-scoped catalog endpoint. Never log or expose the token.
const ORIGIN='https://888api.xin';
class Api888Client {
  constructor({apiKey='',fetchImpl=fetch}={}){this.apiKey=String(apiKey||'').trim();this.fetch=fetchImpl;}
  async models(){
    if(!this.apiKey)throw Object.assign(new Error('Configure an 888API token in Admin first.'),{statusCode:400});
    let response;
    try{response=await this.fetch(ORIGIN+'/v1/models',{method:'GET',headers:{authorization:'Bearer '+this.apiKey,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});}
    catch{throw Object.assign(new Error('Could not connect to 888API.'),{statusCode:502});}
    if(!response.ok){await response.body?.cancel?.().catch(()=>{});throw Object.assign(new Error(response.status===401||response.status===403?'888API rejected the configured token.':'888API model catalog is unavailable (HTTP '+response.status+').'),{statusCode:502});}
    let body;
    try{const raw=await response.text();if(raw.length>5*1024*1024)throw new Error('too large');body=JSON.parse(raw);}
    catch{throw Object.assign(new Error('888API returned an invalid model catalog.'),{statusCode:502});}
    if(!Array.isArray(body?.data)||!body.data.length)throw Object.assign(new Error('888API model catalog was empty. Existing models were preserved.'),{statusCode:502});
    return body;
  }
}
module.exports={Api888Client,ORIGIN};

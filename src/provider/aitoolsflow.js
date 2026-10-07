'use strict';

function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

function collectSetCookies(headers){
  if(!headers)return [];
  if(typeof headers.getSetCookie==='function') return headers.getSetCookie();
  const single=headers.get('set-cookie');
  if(!single)return [];
  return single.split(/,(?=[^;,]+=)/g);
}

class AiToolsFlowClient {
  constructor({baseUrl,email,password}={}){
    this.baseUrl=String(baseUrl||'https://aitoolsflow.com').replace(/\/$/,'');
    this.email=String(email||'').trim();
    this.password=String(password||'');
    this.cookies=new Map();
    this.loggedIn=false;
  }

  cookieHeader(){
    return [...this.cookies.entries()].map(([k,v])=>k+'='+v).join('; ');
  }

  absorbCookies(headers){
    for(const raw of collectSetCookies(headers)){
      const pair=String(raw||'').split(';',1)[0];
      const eq=pair.indexOf('=');
      if(eq<=0)continue;
      const name=pair.slice(0,eq).trim();
      const value=pair.slice(eq+1).trim();
      if(name)this.cookies.set(name,value);
    }
  }

  async request(path,{method='GET',form=null,headers={},redirect='manual'}={}){
    const init={method,redirect,headers:{'User-Agent':'MehrozAI/1.0',...headers}};
    const cookie=this.cookieHeader();
    if(cookie)init.headers.Cookie=cookie;
    if(form){
      const body=new URLSearchParams();
      for(const [key,value] of Object.entries(form)){
        if(value===undefined||value===null)continue;
        body.set(key,String(value));
      }
      init.body=body;
      init.headers['content-type']='application/x-www-form-urlencoded; charset=UTF-8';
    }
    const response=await fetch(this.baseUrl+path,init);
    this.absorbCookies(response.headers);
    return response;
  }

  async login(force=false){
    if(this.loggedIn&&!force)return true;
    if(!this.email||!this.password)throw new Error('AI Tools Flow login credentials are not configured.');

    const response=await this.request('/login.php',{
      method:'POST',
      form:{email:this.email,password:this.password},
      redirect:'manual',
    });

    const location=String(response.headers.get('location')||'');
    if(![301,302,303].includes(response.status) || !/app\/voice_studio\.php/i.test(location)){
      const text=await response.text().catch(()=> '');
      throw new Error('AI Tools Flow login failed'+(text?' ('+text.slice(0,120)+')':'')+'.');
    }
    if(!this.cookies.has('PHPSESSID')){
      throw new Error('AI Tools Flow login succeeded but no PHP session cookie was returned.');
    }
    this.loggedIn=true;
    return true;
  }

  async authed(path,options={}){
    await this.login();
    let response=await this.request(path,{...options,redirect:options.redirect||'manual'});
    if(response.status===401 || response.status===403 || (response.status===302 && /login\.php/i.test(String(response.headers.get('location')||'')))){
      this.loggedIn=false;
      await this.login(true);
      response=await this.request(path,{...options,redirect:options.redirect||'manual'});
    }
    return response;
  }

  async estimateCost(text){
    const payload={text:String(text||'')};
    const candidates=['/app/process_api.php','/app/api/process_api.php','/process_api.php'];
    let lastError=null;
    for(const path of candidates){
      try{
        const response=await this.authed(path,{method:'POST',form:payload});
        if(!response.ok)continue;
        const data=await response.json();
        if(data&&data.success===true&&Number.isFinite(Number(data.estimated_cost))){
          return {
            cost:Number(data.estimated_cost),
            totalChars:Number(data.total_chars||0),
            isEnglish:data.is_english,
            multiplier:Number(data.multiplier_used||0),
            raw:data,
          };
        }
      }catch(error){ lastError=error; }
    }
    throw lastError||new Error('AI Tools Flow cost estimation endpoint could not be resolved.');
  }

  async getHistory(page=1){
    const response=await this.authed('/app/api/api_voice_studio.php?action=get_history&page='+encodeURIComponent(page),{
      method:'GET'
    });
    if(!response.ok)throw new Error('AI Tools Flow history request failed with HTTP '+response.status+'.');
    const data=await response.json();
    if(!data||data.success!==true||!Array.isArray(data.history))throw new Error('AI Tools Flow returned an invalid history response.');
    return data;
  }

  async checkVersion(){
    const response=await this.authed('/app/api/api_voice_studio.php?action=check_version',{method:'GET'});
    if(!response.ok)throw new Error('AI Tools Flow version check failed with HTTP '+response.status+'.');
    return response.json().catch(()=>({success:true}));
  }

  async generateVoice({text,voiceId,company,accountProvider,modelId,speed=1,stability=0.5,similarityBoost=0.75,style=0,useSpeakerBoost=false}){
    await this.login();
    const before=await this.getHistory(1);
    const known=new Set(before.history.map(item=>String(item.id)));

    const response=await this.authed('/app/api/api_voice_studio.php?action=generate_voice',{
      method:'POST',
      form:{
        text:String(text||''),
        voice_id:String(voiceId||''),
        company:String(company||'elevenlabs'),
        account_provider:String(accountProvider||'Provider 3'),
        model_id:String(modelId||'eleven_multilingual_v2'),
        speed:String(speed),
        stability:String(stability),
        similarity_boost:String(similarityBoost),
        style:String(style),
        use_speaker_boost:useSpeakerBoost?'true':'false',
      },
    });
    if(!response.ok)throw new Error('AI Tools Flow voice submission failed with HTTP '+response.status+'.');
    const data=await response.json();
    if(!data||data.success!==true)throw new Error(data?.message||'AI Tools Flow did not accept the voice generation.');

    const expectedText=String(text||'').trim();
    for(let attempt=0;attempt<6;attempt+=1){
      if(attempt)await sleep(350+attempt*250);
      const history=await this.getHistory(1);
      const candidates=history.history.filter(item=>!known.has(String(item.id)));
      const exact=candidates.find(item=>
        String(item.text_used||'').trim()===expectedText &&
        String(item.voice_name||'')===String(voiceId||'') &&
        String(item.model_id||'')===String(modelId||'')
      );
      const match=exact||candidates[0];
      if(match){
        return {
          id:String(match.id),
          status:String(match.status||'pending').toLowerCase(),
          providerCost:Number(match.characters_used||0),
          outputUrl:match.file_path||null,
          raw:match,
          submission:data,
        };
      }
    }
    throw new Error('AI Tools Flow accepted the task but its history record could not be identified.');
  }

  async getVoiceJob(jobId){
    const wanted=String(jobId);
    for(let page=1;page<=4;page+=1){
      const data=await this.getHistory(page);
      const found=data.history.find(item=>String(item.id)===wanted);
      if(found){
        return {
          id:wanted,
          status:String(found.status||'pending').toLowerCase(),
          outputUrl:found.file_path||null,
          providerCost:Number(found.characters_used||0),
          error:found.error_message||null,
          taskId:found.task_id||null,
          raw:found,
        };
      }
      if(!data.has_more)break;
    }
    return null;
  }
}

module.exports={AiToolsFlowClient};

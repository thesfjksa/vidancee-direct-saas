'use strict';

class VibiClient {
  constructor({baseUrl='https://api.vibi.pro',apiKey}={}){
    this.baseUrl=String(baseUrl||'https://api.vibi.pro').replace(/\/$/,'');
    this.apiKey=String(apiKey||'').trim();
  }

  headers(extra={}){
    if(!this.apiKey)throw new Error('Vibi API key is not configured.');
    return {'xi-api-key':this.apiKey,...extra};
  }

  async request(path,{method='GET',json=null,form=null}={}){
    const init={method,headers:this.headers()};
    if(json!==null){
      init.headers['content-type']='application/json';
      init.body=JSON.stringify(json);
    }else if(form){
      init.body=form;
    }
    const response=await fetch(this.baseUrl+path,init);
    const text=await response.text();
    let data=null;
    try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    if(!response.ok){
      const msg=data?.detail||data?.error||data?.message||('HTTP '+response.status);
      const error=new Error('Vibi API error: '+msg);
      error.statusCode=response.status;
      error.providerResponse=data;
      throw error;
    }
    return data;
  }

  async getMe(){
    return this.request('/v1/auth/me');
  }

  async getModels(provider='elevenlabs'){
    const suffix=provider&&provider!=='elevenlabs'?('?provider='+encodeURIComponent(provider)):'';
    const data=await this.request('/v1/models'+suffix);
    return Array.isArray(data)?data:(data?.models||[]);
  }

  async getDefaultVoices({pageSize=30,search=''}={}){
    const q=new URLSearchParams({page_size:String(pageSize)});
    if(search)q.set('search',search);
    return this.request('/v1/default-voices?'+q.toString());
  }

  async getMiniMaxSystemVoices({page=1,pageSize=30,search='',language='',gender='',accent='',age='',useCases=''}={}){
    const q=new URLSearchParams({page:String(page),page_size:String(pageSize)});
    if(search)q.set('search',search);
    if(language)q.set('language',language);
    if(gender)q.set('gender',gender);
    if(accent)q.set('accent',accent);
    if(age)q.set('age',age);
    if(useCases)q.set('use_cases',useCases);
    return this.request('/v1/minimax/system-voices?'+q.toString());
  }

  async textToSpeech({voiceId,text,modelId,provider='elevenlabs',languageCode,voiceSettings={},exportTranscript=false}){
    const data=await this.request('/v1/text-to-speech/'+encodeURIComponent(voiceId),{
      method:'POST',
      json:{
        text:String(text||''),
        model_id:String(modelId||'eleven_multilingual_v2'),
        provider:String(provider||'elevenlabs'),
        language_code:String(languageCode|| (provider==='minimax'?'English':'en')),
        voice_settings:voiceSettings||{},
        export_transcript:Boolean(exportTranscript),
      },
    });
    return {
      id:String(data.id||''),
      status:String(data.status||'pending').toLowerCase(),
      raw:data,
    };
  }

  async getHistoryDetail(id){
    const data=await this.request('/v1/history/'+encodeURIComponent(id));
    return this.normalizeTask(data);
  }

  normalizeTask(data){
    const result=data?.result&&typeof data.result==='object'?data.result:{};
    return {
      id:String(data?.id||''),
      status:String(data?.status||'pending').toLowerCase(),
      progress:Number(data?.progress||0),
      provider:String(data?.provider||''),
      voiceId:String(data?.voice_id||''),
      modelId:String(data?.model_id||''),
      outputUrl:result.audio_url||null,
      error:data?.error||null,
      charactersUsed:Number(data?.characters_used||0),
      creditsDeducted:Number(data?.credits_deducted||0),
      raw:data,
    };
  }

  async listClonedVoices(){
    const data=await this.request('/v1/minimax/voices');
    return Array.isArray(data?.voices)?data.voices:[];
  }

  async cloneVoice({data,filename,mimeType,voiceName,languageTag='English',gender='Male',needNoiseReduction=true,previewText='Hello'}){
    const form=new FormData();
    const blob=new Blob([data],{type:mimeType||'audio/mpeg'});
    form.append('file',blob,filename||'voice-sample.mp3');
    form.append('voice_name',String(voiceName||'My Voice'));
    form.append('language_tag',String(languageTag||'English'));
    form.append('gender',String(gender||'Male'));
    form.append('need_noise_reduction',needNoiseReduction?'true':'false');
    form.append('preview_text',String(previewText||'Hello').slice(0,200));
    return this.request('/v1/minimax/voices/clone',{method:'POST',form});
  }

  async deleteClonedVoice(id){
    return this.request('/v1/minimax/voices/'+encodeURIComponent(id),{method:'DELETE'});
  }
}

module.exports={VibiClient};

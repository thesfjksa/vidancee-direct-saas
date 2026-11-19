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

  async request(path,{method='GET',json=null,form=null,timeoutMs=null}={}){
    const init={method,headers:this.headers()};
    if(json!==null){
      init.headers['content-type']='application/json';
      init.body=JSON.stringify(json);
    }else if(form){
      init.body=form;
    }
    init.signal=AbortSignal.timeout(Number.isFinite(timeoutMs)?Math.max(1500,Math.min(120000,timeoutMs)):(method==='GET'?30000:120000));
    const response=await fetch(this.baseUrl+path,init);
    const text=await response.text();
    let data=null;
    try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    if(!response.ok){
      const msg=data?.detail||data?.error||data?.message||('HTTP '+response.status);
      const error=new Error('Vibi API error: '+msg);
      error.statusCode=response.status;
      error.definitive=response.status>=400&&response.status<500&&response.status!==408;
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

  async getLanguages(provider='elevenlabs'){
    const data=await this.request('/v1/languages?provider='+encodeURIComponent(provider));
    return Array.isArray(data)?data:(data?.languages||[]);
  }

  async dialogue(params){return this.request('/v1/dialogue',{method:'POST',json:params});}

  async voiceChanger({file,voiceId,voiceSettings,removeNoise=false}){
    const form=new FormData();
    form.append('audio',new Blob([file.data],{type:file.mimeType}),file.filename);
    form.append('voice_id',voiceId);form.append('model_id','eleven_multilingual_sts_v2');
    form.append('voice_settings',JSON.stringify(voiceSettings));
    form.append('remove_background_noise',String(removeNoise));
    return this.request('/v1/voice-changer',{method:'POST',form});
  }

  async dubbing({file,sourceLanguage,targetLanguage,voiceId}){
    // Only completion starts a paid task. Never retry completion automatically.
    let init;
    try{
      init=await this.request('/v1/aidubbing/upload/init',{method:'POST'});
      const size=Number(init.chunk_size);
      if(!init.upload_id||!Number.isSafeInteger(size)||size<1||size>100*1024*1024)throw Error('Invalid dubbing upload session.');
      const count=Math.ceil(file.data.length/size);
      for(let index=0;index<count;index++){
        const form=new FormData();form.append('upload_id',String(init.upload_id));form.append('index',String(index));
        form.append('chunk',new Blob([file.data.subarray(index*size,(index+1)*size)]),'chunk');
        await this.request('/v1/aidubbing/upload/chunk',{method:'POST',form});
      }
    }catch(error){error.definitive=true;throw error;}
    const form=new FormData();
    for(const [key,value] of Object.entries({upload_id:init.upload_id,total_chunks:Math.ceil(file.data.length/Number(init.chunk_size)),filename:file.filename,content_type:file.mimeType,target_language:targetLanguage,source_language:sourceLanguage,provider:'elevenlabs',voice_id:voiceId}))form.append(key,String(value));
    return this.request('/v1/aidubbing/upload/complete',{method:'POST',form});
  }

  async getToolHistory(id,operation){
    const prefix=operation==='dubbing'?'/v1/aidubbing/history/':operation==='voice-changer'?'/v1/voice-changer/history/':'/v1/history/';
    return this.normalizeTask(await this.request(prefix+encodeURIComponent(id)));
  }

  async getDefaultVoices({pageSize=30,search='',language='',timeoutMs=6000}={}){
    const q=new URLSearchParams({page_size:String(Math.min(100,Math.max(1,Number(pageSize)||30)))});
    if(search)q.set('search',String(search).slice(0,100));
    // Do not send undocumented language parameter to the small default catalog:
    // it was previously causing a full 30s timeout followed by another lookup.
    return this.request('/v1/default-voices?'+q.toString(),{timeoutMs});
  }

  async getSharedVoices({language='',search='',pageSize=30,page=0,sort='trending',timeoutMs=5000}={}){
    // ElevenLabs standard read-only shared-voice listing, requested via Vibi's
    // configured gateway. Some gateway deployments don't expose this route.
    const q=new URLSearchParams({page_size:String(Math.min(100,Math.max(1,Number(pageSize)||30))),page:String(Math.max(0,Number(page)||0))});
    if(language)q.set('language',String(language).slice(0,20));
    if(search)q.set('search',String(search).slice(0,100));
    if(['trending','created_date','usage_character_count_1y','cloned_by_count'].includes(sort))q.set('sort',sort);
    return this.request('/v1/shared-voices?'+q.toString(),{timeoutMs});
  }


  // Preview clips are public/provider-hosted resources, not paid TTS requests.
  // The browser must fetch them from CMMTools' origin (the app CSP restricts media-src).
  async downloadVoicePreview(address){
    const base=new URL(this.baseUrl);
    const trusted=(url)=>{
      if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')return false;
      const host=url.hostname.toLowerCase();
      return host==='storage.googleapis.com'||host==='elevenlabs.io'||host.endsWith('.elevenlabs.io')||
        host==='vibi.pro'||host.endsWith('.vibi.pro')||host===base.hostname;
    };
    let current;
    try{current=new URL(address,base);}catch{throw Object.assign(Error('Voice sample URL is invalid.'),{statusCode:404});}
    for(let redirect=0;redirect<4;redirect++){
      if(!trusted(current))throw Object.assign(Error('Voice sample source is not supported.'),{statusCode:404});
      const headers=current.origin===base.origin?this.headers():{};
      const response=await fetch(current,{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');
        if(!location)throw Object.assign(Error('Voice sample redirect is missing.'),{statusCode:502});
        current=new URL(location,current);continue;
      }
      if(!response.ok)throw Object.assign(Error('Voice sample is not available from the provider.'),{statusCode:404});
      const maxBytes=8*1024*1024;
      const size=Number(response.headers.get('content-length'));
      if(Number.isFinite(size)&&size>maxBytes)throw Object.assign(Error('Voice sample exceeds the preview limit.'),{statusCode:413});
      const rawType=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      const mediaTypes=new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav','audio/ogg','audio/webm','application/octet-stream','binary/octet-stream']);
      if(!mediaTypes.has(rawType))throw Object.assign(Error('Provider preview did not return audio.'),{statusCode:502});
      const chunks=[];let bytes=0;
      for await(const piece of response.body){
        const buf=Buffer.from(piece);bytes+=buf.length;
        if(bytes>maxBytes)throw Object.assign(Error('Voice sample exceeds the preview limit.'),{statusCode:413});
        chunks.push(buf);
      }
      if(!bytes)throw Object.assign(Error('Provider preview is empty.'),{statusCode:404});
      const ext=current.pathname.toLowerCase();
      const contentType=rawType==='application/octet-stream'||rawType==='binary/octet-stream'
        ?(ext.endsWith('.wav')?'audio/wav':ext.endsWith('.ogg')?'audio/ogg':ext.endsWith('.m4a')?'audio/mp4':'audio/mpeg')
        :rawType;
      return {data:Buffer.concat(chunks,bytes),contentType};
    }
    throw Object.assign(Error('Too many voice sample redirects.'),{statusCode:502});
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
      creditsDeducted:data?.credits_deducted==null?null:Number(data.credits_deducted),
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


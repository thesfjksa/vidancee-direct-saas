'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const dbModule=require('../src/db.js');
const {Api888Client}=require('../src/provider/api888.js');

const imageOnlyLegacyCaps={
  textOnly:true,totalMax:30,
  image:{supported:true,max:30,min:0,roles:['image_references']},
  video:{supported:false,max:0,min:0,roles:[]},
  audio:{supported:false,max:0,min:0,roles:[]},
};
const oldRow=(id='ss-2.5-720p-v1',opts={})=>({
  id:1,provider:'api888',provider_model_id:id,
  public_model_id:'api888_'+id.replace(/[^a-zA-Z0-9]/g,'_'),
  label:id,media_type:'video',enabled:opts.enabled??1,available:opts.available??1,
  price_override:null,options_json:JSON.stringify({
    durations:[5,10,15,30],resolutions:['720p'],defaultResolution:'720p',
    defaultDuration:5,aspectRatios:['16:9','9:16','1:1'],defaultAspectRatio:'16:9',
    catalogVerified:true,adapterSupported:opts.supported??true,
    referenceCapabilities:imageOnlyLegacyCaps,
    mediaRoles:['image_references'],
    api888:{unit:'CNY',billing:'job',sourceCny:5,secondsField:'duration',imageField:'images'},
  }),
});
function loadWithDb(fake){
  const originalGetPool=dbModule.getPool;
  dbModule.getPool=()=>fake;
  delete require.cache[require.resolve('../src/provider_models.js')];
  return {
    mod:require('../src/provider_models.js'),
    restore:()=>{
      dbModule.getPool=originalGetPool;
      delete require.cache[require.resolve('../src/provider_models.js')];
    },
  };
}

test('A previously synced Seedance 2.5 V1 row exposes video/audio inputs without database writes or reimport',async()=>{
  const row=oldRow();
  const calls=[];
  const fake={query:async(sql,args)=>{
    calls.push(sql);
    assert.match(sql,/^SELECT \* FROM provider_models/);
    return [[row]];
  },execute:async()=>{throw Error('No database mutation allowed')}};
  const {mod,restore}=loadWithDb(fake);
  try{
    const c=await mod.publicProviderCatalog('api888',{});
    assert.equal(c.video.length,1);
    const model=c.video[0];
    assert.equal(model.capabilities.image.max,30);
    assert.equal(model.capabilities.video.max,10);
    assert.equal(model.capabilities.audio.max,10);
    assert.equal(model.capabilities.video.supported,true);
    assert.equal(model.capabilities.audio.supported,true);
    assert.equal(model.defaultAspectRatio,'16:9');
    assert.equal(model.billingRateCredits,5);
    assert.equal(calls.length,1);
    assert.equal(JSON.parse(row.options_json).referenceCapabilities.video.supported,false,'Old database must not mutate');
  }finally{restore()}
});

test('The same stale model uses updated validated transport fields in worker, not old image-only options',async()=>{
  const fake={execute:async(sql)=>{
    assert.match(sql,/WHERE provider=\? AND public_model_id=\? AND media_type=\?/);
    return [[oldRow()]];
  }};
  const {mod,restore}=loadWithDb(fake);
  try{
    const m=await mod.getProviderModelByPublicId('api888','api888_ss_2_5_720p_v1','video');
    assert.equal(m.api888.videoField,'videos');
    assert.equal(m.api888.audioField,'audios');
    const c=new Api888Client({apiKey:'fake-do-not-call'});
    const refs=[
      {url:'https://cmmtools.site/provider-media/1/0?sig=fake',mimeType:'video/mp4'},
      {url:'https://cmmtools.site/provider-media/1/1?sig=fake',mimeType:'audio/mpeg'},
    ];
    const payload=c.videoBody(m,{duration:10,prompt:'Movement and audio',aspectRatio:'9:16'},refs);
    assert.deepEqual(payload.videos,[refs[0].url]);
    assert.deepEqual(payload.audios,[refs[1].url]);
  }finally{restore()}
});

test('Static metadata overlay never activates an unavailable or disabled model',async()=>{
  for(const field of ['enabled','available']){
    const row=oldRow('ss-2.5-720p-v1',{[field]:0});
    const fake={query:async(sql)=>{
      assert.match(sql,/enabled=1 AND available=1/);
      // MySQL denies listing the row when either switch is off.
      return [[...(row.enabled&&row.available?[row]:[])]];
    }};
    const {mod,restore}=loadWithDb(fake);
    try{
      const c=await mod.publicProviderCatalog('api888');
      assert.equal(c.video.length,0);
    }finally{restore()}
  }
});

test('Unreviewed or adapter-unsupported rows are not made billable by a code-side override',async()=>{
 const row=oldRow('ss-2.5-720p-v1',{supported:false});
 const {mod,restore}=loadWithDb({query:async()=>[[row]]});
 try{
   const c=await mod.publicProviderCatalog('api888',{});
   assert.equal(c.video.length,0);
 }finally{restore()}
});

test('Video Studio displays distinct media upload picker actions wired to upload handlers',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
 for(const [button,input,handler] of [
   ['addImageReferenceButton','imageInput','addReferenceFiles'],
   ['addVideoReferenceButton','videoReferenceInput','addVideoReferenceFiles'],
   ['addAudioReferenceButton','audioReferenceInput','addAudioReferenceFiles'],
 ]){
   assert.ok(html.includes('id="'+button+'"'),'Missing visible picker button: '+button);
   assert.ok(html.includes("'"+input+"').click()"),'Picker button must open its file chooser: '+button);
   assert.match(html,new RegExp('id="'+input+'"[^>]+onchange="[^"]*'+handler));
 }
 assert.match(html,/addVideoReferenceButton'\)\.classList\.toggle\('hide',!videoCap\.supported\)/);
 assert.match(html,/addAudioReferenceButton'\)\.classList\.toggle\('hide',!audioCap\.supported\)/);
});

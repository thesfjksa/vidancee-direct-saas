'use strict';

// 888API's account-scoped GET /v1/models is the source of truth for availability.
// This snapshot contains documented media IDs, including unpriced models which
// stay visible to Admin but are NEVER offered for paid generation.
const VIDEO_IDS = String.raw`
jimeng-video-seedance-2.0-fast jimeng-video-seedance-2.0-vip jimeng-video-seedance-2.0-mini jimeng-video-seedance-2.0-fast-vip
seedance2.0-ycy-5s seedance2.0-ycy-10s seedance2.0-ycy-15s doubao-seedance-2-0-fast doubao-seedance-2-0
seedance2.0-full-9img seedance2.0-full-4img seedance2.0-fast-4img seedance2.0-ss seedance2.0-ss-fast
seedance2.0-933-economy seedance2.0-933 seedance2.0-pro-480p seedance2.0-933-fast seedance2.0-933-mini
seedance2.0-480p seedance2.0-720p seedance2.0-stable-480p seedance2.0-stable-720p sd_2.0_mini_special
xin-seedance-2.0-900 xin-seedance-2.0-933 dola-seedance-2.0-fast doubao-seedance-2.0-mini dola-seedance-2.0-900 dola-seedance-2.0-933
seedance2.0-900-wool seedance2.0-933-wool seedance-doubao12-803 seedance-doubao12-813 seedance-doubao12-503
seedance-2.5-c1 seedance2.5-480p-value seedance2.5-480p-plus seedance2.5-480p-pro
seedance2.5-720p-plus seedance2.5-720p-pro seedance2.5-1080p-plus seedance2.5-1080p-pro
xin-seedance-2.5-3010 xin-seedance-2.5-900 dola-seedance-2.5 seedance2.5-vip-30-10-10 seedance2.5-vip-30-0-10
seedance2.5-900-wool seedance2.5-101010-wool seedance2.5-301010-wool dola-seedance-2.5-900 dola-seedance-2.5-301010
seedance-2.5-G2-V seedance2.5-900 seedance2.5-301010 seedance2.5-301010-av seedance2.5-930-1080p
ss-2.5-720p-v1 ss-2.0-933-720p s2-2.5-480p-v2 s2-2.5-720p-v3 s2-2.5-720p-v4 doubao-seedance-2.5
wan30-720p wan30-1080p-fast wan3.0-video wan3.0-video-prime wan3.0-image wan3.0-image-prime
sora2-480p minimax-h3 minimax-h3-c4 pidoi-h3video-2k minimax-h3-480p-t minimax-h3-768p-t
pidoi-omni-flash-720p pidoi-veo31-fast grok-imagine-video-1.5-preview
`.trim().split(/\s+/);
// Documented exact variant IDs. Catalog availability remains account-scoped.
const SORA_VARIANTS=[4,8,12].flatMap(sec=>['16x9','9x16'].flatMap(r=>
 ['','pro-'].map(t=>'sora2-'+t+sec+'s-'+r)));
const GROK_VARIANTS=['grok-imagine-1.0-video','grok-imagine-video',
 'grok-imagine-video-preview','grok-imagine-video-1.5-preview','grok-imagine-video-1.5-fast'];
for(const id of [...SORA_VARIANTS,...GROK_VARIANTS])if(!VIDEO_IDS.includes(id))VIDEO_IDS.push(id);
const IMAGE_IDS = String.raw`
gpt-image-2-1k gpt-image-2 gpt-image-2-plus gpt-image-2-pro gpt-image-2pro gpt-image-2.5-1k gpt-image-2.5-4k gpt-image-2-4k
gpt-image-2.5-flare gpt-image-2.5-flare-4k gpt-image-2.5-sunburst gpt-image-2.5-sunburst-4k
gemini-3-pro-image-preview gemini-3-pro-image-preview-c gemini-3.1-flash-image-preview gemini-3.1-flash-image-preview-c
`.trim().split(/\s+/);

// Published 888API prices in CNY, checked 24 October 2026. Absence does not
// mean zero. Do not enable unknown pricing or silently substitute another SKU.
// [CNY, billing type, min seconds, max seconds, resolution, image refs, video refs, audio refs]
const SPECS = {
  'seedance2.0-933-economy':[5,'job',15,15,'720p',9,3,3],
  'pidoi-h3video-2k':[2.3,'job',15,15,'2k',9,3,3],
  'minimax-h3-480p-t':[0.065,'second',5,15,'480p',9,0,0],
  'minimax-h3-768p-t':[0.07,'second',5,15,'768p',9,0,0],
  'pidoi-omni-flash-720p':[0.8,'job',5,10,'720p',4,3,3],
  'pidoi-veo31-fast':[0.6,'job',4,8,'720p',2,0,0],
  'seedance2.0-933':[5,'job',10,15,'720p',9,3,3],
  'seedance2.0-pro-480p':[3.8,'job',15,15,'480p',9,3,3],
  'seedance2.0-933-fast':[4,'job',10,15,'720p',9,0,0],
  'seedance2.0-933-mini':[1,'job',5,12,'720p',9,0,3],
  'seedance2.0-480p':[0.5,'second',4,15,'480p',0,0,0],
  'seedance2.0-720p':[0.75,'second',4,15,'720p',0,0,0],
  'seedance2.0-stable-480p':[0.4,'second',4,15,'480p',0,0,0],
  'seedance2.0-stable-720p':[0.63,'second',4,15,'720p',0,0,0],
  'wan30-720p':[0.25,'second',4,30,'720p',10,5,5],
  'wan30-1080p-fast':[0.4,'second',4,30,'1080p',10,5,5],
  'wan3.0-video':[0.22,'second',2,30,'720p',10,5,0],
  'wan3.0-video-prime':[0.25,'second',2,30,'720p',10,5,0],
  'wan3.0-image':[0.22,'second',2,30,'720p',10,0,0],
  'wan3.0-image-prime':[0.25,'second',2,30,'720p',10,0,0],
  'seedance2.5-480p-value':[0.45,'second',4,15,'480p',0,0,0],
  'seedance2.5-480p-plus':[0.6,'second',4,15,'480p',0,0,0],
  'seedance2.5-480p-pro':[0.5,'second',4,15,'480p',0,0,0],
  'seedance2.5-720p-plus':[0.9,'second',4,15,'720p',0,0,0],
  'seedance2.5-720p-pro':[0.75,'second',4,15,'720p',0,0,0],
  'seedance2.5-1080p-plus':[1.25,'second',4,15,'1080p',0,0,0],
  'seedance2.5-1080p-pro':[1.25,'second',4,15,'1080p',0,0,0],
  'xin-seedance-2.0-900':[1.7,'job',4,30,'720p',9,0,0],
  'xin-seedance-2.0-933':[3,'job',4,30,'720p',9,3,3],
  'sora2-480p':[4,'job',4,15,'480p',0,0,0],
  'seedance2.0-ss':[2,'job',6,15,'720p',9,0,0],
  'seedance2.0-ss-fast':[1.5,'job',6,15,'720p',9,0,0],
  'ss-2.5-720p-v1':[3.9,'job',5,30,'720p',30,0,0],
  's2-2.5-480p-v2':[5,'job',5,30,'480p',30,0,0],
  's2-2.5-720p-v3':[8,'job',5,30,'720p',30,0,0],
  's2-2.5-720p-v4':[7,'job',5,30,'720p',30,0,0],
  'doubao-seedance-2.5':[6.5,'job',5,30,'720p',9,0,0],
  'seedance2.5-301010':[5.8,'job',5,30,'720p',30,0,0],
  'seedance2.5-301010-av':[5.1,'job',4,30,'720p',30,0,0],
  'seedance2.5-900':[5.7,'job',5,30,'720p',9,0,0],
  'seedance2.5-900-wool':[1.3,'job',5,30,'720p',9,0,0],
  'seedance2.5-101010-wool':[1.5,'job',5,30,'720p',9,0,0],
  'seedance2.5-301010-wool':[1.9,'job',5,30,'720p',9,0,0],
};

Object.assign(SPECS, {
 'seedance2.5-900-wool':[1.1,'job',4,30,'720p',9,0,0],
 'seedance2.0-900-wool':[0.9,'job',4,15,'720p',9,0,0],
 'seedance2.0-933-wool':[1.1,'job',4,15,'720p',9,0,0],
 'seedance2.5-101010-wool':[1.3,'job',4,30,'720p',10,0,0],
 'seedance2.5-301010-wool':[1.7,'job',4,30,'720p',30,0,0],
 'seedance2.5-900':[5.7,'job',5,30,'720p',9,0,0],
 'seedance2.5-301010':[5.8,'job',5,30,'720p',30,0,0],
 'seedance2.5-301010-av':[5.1,'job',4,30,'720p',30,0,0],
 'seedance2.5-930-1080p':[5,'job',5,30,'1080p',9,0,3],
 'ss-2.5-720p-v1':[3.9,'job',5,30,'720p',30,10,10],
 'ss-2.0-933-720p':[1.5,'job',5,15,'720p',9,3,3],
 's2-2.5-480p-v2':[5,'job',5,30,'480p',30,0,10],
 's2-2.5-720p-v3':[8,'job',5,30,'720p',30,10,10],
 's2-2.5-720p-v4':[7,'job',5,30,'720p',30,10,10],
 'seedance2.5-vip-30-10-10':[4,'job',5,30,'720p',30,10,10],
 'seedance2.5-vip-30-0-10':[3.5,'job',30,30,'720p',30,0,10],
 'xin-seedance-2.5-3010':[2.9,'job',4,30,'720p',30,0,10],
 'xin-seedance-2.5-900':[1.7,'job',4,30,'720p',9,0,0],
 'dola-seedance-2.5':[1.7,'job',4,30,'720p',30,0,0],
 'dola-seedance-2.5-900':[1.45,'job',5,30,'720p',9,0,0],
 'dola-seedance-2.5-301010':[1.5,'job',5,30,'720p',30,10,10],
 'dola-seedance-2.0-fast':[1.5,'job',4,15,'720p',9,0,0],
 'dola-seedance-2.0-900':[1.3,'job',4,15,'720p',9,0,0],
 'dola-seedance-2.0-933':[1.5,'job',4,15,'720p',9,3,3],
 'doubao-seedance-2.0-mini':[1.6,'job',5,15,'720p',9,0,0],
 'doubao-seedance-2.5':[6.5,'job',5,30,'720p',9,0,0],
 'seedance-doubao12-803':[1.1,'job',4,12,'720p',8,0,3],
 'seedance-doubao12-813':[1.3,'job',4,12,'720p',8,0,3],
 'seedance-doubao12-503':[0.9,'job',4,12,'720p',5,0,3],
 'sora2-480p':[4,'job',4,15,'480p',0,0,0],
 'pidoi-veo31-fast':[0.6,'job',4,8,'720p',2,0,0],
 'seedance2.0-933-mini':[1,'job',5,12,'720p',9,0,3],
});

// Provider's documented CNY cost and fixed output specs, never infer by name.
Object.assign(SPECS,{
 'seedance2.0-full-4img':[4,'job',4,15,'720p',4,3,1],
 'seedance2.0-fast-4img':[3.5,'job',4,15,'720p',4,3,1],
 'doubao-seedance-2-0-fast':[0.61,'second',4,15,'720p',9,3,3],
});
for(const id of SORA_VARIANTS){
 const secs=Number(id.match(/-(\d+)s-/)[1]);
 SPECS[id]=[0.6,'job',secs,secs,'720p',1,0,0];
}
for(const id of GROK_VARIANTS){
 const preview=id==='grok-imagine-video-1.5-preview',fast=id==='grok-imagine-video-1.5-fast';
 SPECS[id]=[0.2,'job',preview?5:fast?10:6,preview?15:10,'720p',1,0,0];
}
const IMAGE_CNY = {
  'gpt-image-2.5-1k':0.06,'gpt-image-2.5-4k':0.09,
  'gpt-image-2.5-flare':0.05,'gpt-image-2.5-flare-4k':0.09,
  'gpt-image-2.5-sunburst':0.05,'gpt-image-2.5-sunburst-4k':0.09,
  'gpt-image-2':0.075,'gpt-image-2pro':0.075,
  'gemini-3-pro-image-preview':0.075,'gemini-3-pro-image-preview-c':0.075,
  'gemini-3.1-flash-image-preview':0.075,'gemini-3.1-flash-image-preview-c':0.075,
  'gpt-image-2-4k':0.09,
};
const PUBLIC_ID = id => 'api888_' + String(id).replace(/[^a-zA-Z0-9]/g, '_');
const isApi888Model = id => /^api888_/.test(String(id || ''));
const ALL_IDS = new Set([...VIDEO_IDS,...IMAGE_IDS]);
const RATS = ['16:9','9:16','1:1'];
const RATS_FIVE = [...RATS,'4:3','3:4'];
const RATS_WIDE = [...RATS_FIVE,'21:9'];

// Confirmed input arrays and limits from https://888api.xin/docs (25 Oct
// 2026). Specs are prices; input contracts must be checked independently.
// Do not infer upload support solely from a model ID containing "301010".
const VIDEO_INPUTS={
 'seedance2.0-full-4img':{videos:3,audios:1,videoField:'referenceVideos',audioField:'referenceAudios'},
 'seedance2.0-fast-4img':{videos:3,audios:1,videoField:'referenceVideos',audioField:'referenceAudios'},
 'doubao-seedance-2-0-fast':{videos:3,audios:3,videoField:'video_urls',audioField:'audio_urls'},
  'ss-2.5-720p-v1':{videos:10,audios:10},
  's2-2.5-480p-v2':{videos:0,audios:10},
  's2-2.5-720p-v3':{videos:10,audios:10},
  's2-2.5-720p-v4':{videos:10,audios:10},
  'dola-seedance-2.5-301010':{videos:10,audios:10},
  'seedance2.5-930-1080p':{videos:0,audios:3,audioField:'metadata.audios'},
  'wan30-720p':{videos:5,audios:5},
  'wan30-1080p-fast':{videos:5,audios:5},
  'wan3.0-video':{videos:10,audios:0},
  'seedance2.0-933-economy':{videos:3,audios:3},
  'pidoi-h3video-2k':{videos:3,audios:3},
  'pidoi-omni-flash-720p':{videos:3,audios:3},
  'seedance2.0-933':{videos:3,audios:3},
  'seedance2.0-pro-480p':{videos:3,audios:3},
  'seedance2.0-933-mini':{videos:0,audios:3},
  'xin-seedance-2.0-933':{videos:3,audios:3},
  'wan3.0-video-prime':{videos:10,audios:0},
};
const modelVideoRatios=id=>{
 if(SORA_VARIANTS.includes(id))return [id.endsWith('16x9')?'16:9':'9:16'];
 if(GROK_VARIANTS.includes(id))return ['16:9','9:16'];
  if(/^wan3\.0-/.test(id))return ['adaptive',...RATS_WIDE];
  if(/^seedance2\.0-ss(?:-fast)?$/.test(id))return [...RATS,'2:3','3:2'];
  if(/^minimax-h3-(480p|768p)-t$/.test(id))return [...RATS_WIDE,'3:2','2:3'];
  if(id==='seedance2.5-930-1080p')return RATS_WIDE;
  if(id==='seedance2.5-900')return RATS_FIVE;
  return RATS;
};
const makeCaps = (images=0,videos=0,audios=0,requiredImage=false) => ({
  textOnly: !requiredImage, totalMax: images+videos+audios,
  image:{supported:images>0,max:images,min:requiredImage?1:0,
    roles:images?['image_references']:[],requiredRoles:[],maxBytes:10*1024*1024,formats:['jpeg','png','webp']},
  video:{supported:videos>0,max:videos,min:0,roles:videos?['video']:[],maxBytes:25*1024*1024,formats:['mp4']},
  audio:{supported:audios>0,max:audios,min:0,roles:audios?['audio']:[],maxBytes:15*1024*1024,formats:['mp3','wav']},
});
const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
function describedModel(id,type) {
  const isImage=type==='image';
  const spec=SPECS[id],cny=IMAGE_CNY[id];
  const known=isImage?Number(cny)>0:Boolean(spec&&Number(spec[0])>0);
  // Explicitly supported request families. Unreviewed channels are imported
  // as Admin-only entries, never silently mapped to an incompatible API.
  const implemented=known && (
    (isImage && ['gpt-image-2.5-1k','gpt-image-2.5-4k', 'gpt-image-2.5-sunburst','gpt-image-2.5-sunburst-4k','gpt-image-2-4k',
      'gpt-image-2','gpt-image-2pro','gemini-3-pro-image-preview','gemini-3-pro-image-preview-c',
      'gemini-3.1-flash-image-preview','gemini-3.1-flash-image-preview-c'].includes(id)) ||
    (!isImage && (SORA_VARIANTS.includes(id)||GROK_VARIANTS.includes(id))) ||
    (/^seedance2\.[05]-.*wool$/.test(id)) ||
    [// Published, priced models using the existing generic /v1/videos contract.
      // Live account model discovery and Admin access gates still apply.
      'seedance2.0-full-4img','seedance2.0-fast-4img','doubao-seedance-2-0-fast',
      'seedance2.0-933-economy','pidoi-h3video-2k','pidoi-omni-flash-720p','pidoi-veo31-fast',
      'seedance2.0-933','seedance2.0-pro-480p','seedance2.0-933-fast','seedance2.0-933-mini',
      'xin-seedance-2.0-900','xin-seedance-2.0-933',
      'seedance2.0-ss','seedance2.0-ss-fast',
      'seedance2.5-480p-value','seedance2.5-480p-plus','seedance2.5-480p-pro',
      'seedance2.5-720p-plus','seedance2.5-720p-pro',
      'seedance2.5-1080p-plus','seedance2.5-1080p-pro',
      'seedance2.5-900','seedance2.5-301010','seedance2.5-301010-av',
      'dola-seedance-2.5-900','dola-seedance-2.5-301010','doubao-seedance-2.5',
      'ss-2.5-720p-v1','s2-2.5-480p-v2','s2-2.5-720p-v3',
      's2-2.5-720p-v4','seedance2.5-930-1080p',
      // Official per-second video SKUs: all use POST /v1/videos with
      // "seconds" and optional public-URL images (except text-only Seedance).
      'seedance2.0-480p','seedance2.0-720p',
      'seedance2.0-stable-480p','seedance2.0-stable-720p',
      'wan30-720p','wan30-1080p-fast',
      'wan3.0-video','wan3.0-video-prime',
      'wan3.0-image','wan3.0-image-prime',
      'minimax-h3-480p-t','minimax-h3-768p-t',
      // A fixed-price text-only video model.
      'sora2-480p'].includes(id)
  );
  const min=spec?.[2]||5,max=spec?.[3]||15,res=spec?.[4]||'720p';
  const requiredImage=/^minimax-h3-(480p|768p)-t$/.test(id)||/^wan3\.0-image(?:-prime)?$/.test(id)||id==='grok-imagine-video-1.5-preview';
  const inputs=VIDEO_INPUTS[id]||{};
  const refs=isImage?makeCaps(0):makeCaps(spec?.[5]||0,inputs.videos||0,inputs.audios||0,requiredImage);
  if(id==='doubao-seedance-2-0-fast'){refs.video.min=1;refs.textOnly=false;}
  // The upstream limits some multimodal models to 12 total items, even
  // though their individual image/video/audio maxima sum to 15.
  if(['seedance2.0-933-economy','pidoi-h3video-2k','seedance2.0-933',
      'xin-seedance-2.0-933'].includes(id))refs.totalMax=12;
  const videoFlat=spec?.[1]==='job';
  const pricing=isImage?{image:cny||0}:{video_duration_pricing:known?[{resolution:res,cost_per_second:videoFlat?spec[0]/min:spec[0]}]:[]};
  // Flag fixed-per-request billing separately; quoteApi888 applies the same
  // fixed CNY cost at ANY supported duration instead of overcharging by seconds.
  return {
    providerModelId:id,publicModelId:PUBLIC_ID(id),label:id.replace(/[-_]/g,' ').replace(/\b\w/g,m=>m.toUpperCase()),
    mediaType:type,options:{
      catalogVerified:true,adapterSupported:implemented,
      setupReason:implemented?'':known?'This 888API model needs verified request mapping.':'No verified 888API price/contract for this model; keep disabled.',
      gatewayType:type,pricing,api888:{unit:'CNY',billing:isImage?'image':spec?.[1],sourceCny:isImage?cny:spec?.[0],
        secondsField:spec?.[1]==='second'&&id!=='doubao-seedance-2-0-fast'?'seconds':'duration',
        imageField:id==='seedance-2.5-c1'||id==='doubao-seedance-2-0-fast'?'image_urls':
          (/^seedance2\.0-(ss|full-4img|fast-4img)/.test(id)?'referenceImages':'images'),
        videoField:inputs.videos?(inputs.videoField||'videos'):null,
        audioField:inputs.audios?(inputs.audioField||'audios'):null},
      durations:isImage?[]:SORA_VARIANTS.includes(id)?[min]:
        GROK_VARIANTS.includes(id)?(id==='grok-imagine-video-1.5-preview'?[5,6,10,15]:
          id==='grok-imagine-video-1.5-fast'?[10]:[6,10]):
        id==='seedance2.5-900'?[5,10,15,30]:
        ['seedance2.0-933-economy','pidoi-h3video-2k','seedance2.0-pro-480p'].includes(id)?[15]:
        ['seedance2.0-933','seedance2.0-933-fast'].includes(id)?[10,15]:
        id==='pidoi-omni-flash-720p'?[5,10]:
        /^seedance2\.0-ss(?:-fast)?$/.test(id)?[6,8,10,12,15]:
        /^(ss-2\.5-720p-v1|s2-2\.5-(480p-v2|720p-v[34])|seedance2\.5-930-1080p)$/.test(id)?range(5,30):
        id==='pidoi-veo31-fast'?[4,6,8]:id==='doubao-seedance-2.0-mini'?[5,10,15]:range(min,max),
      resolutions:isImage?[]:(id==='pidoi-veo31-fast'?['720p','1080p']:(/^seedance2\.0-ss(?:-fast)?$/.test(id)||id==='seedance2.0-933-mini')?['480p','720p']:[res]),aspectRatios:isImage?(id==='gpt-image-2'?['1:1','16:9','9:16']:['1:1']):modelVideoRatios(id),
      defaultAspectRatio:isImage?'1:1':SORA_VARIANTS.includes(id)&&id.endsWith('9x16')?'9:16':'16:9',
      defaultDuration:min,defaultResolution:res,
      referenceCapabilities:refs,mediaRoles:[...refs.image.roles,...refs.video.roles,...refs.audio.roles],
            supportedOperations:isImage?['text-to-image']:[...(refs.textOnly?['text-to-video']:[]),
        ...((refs.image.supported||refs.video.supported||refs.audio.supported)?['reference-to-video']:[])],
      imageSizes:[],qualities:[],supportsAudio:false,inputLimits:{text:{max_chars:4096}},
    },
  };
}
function api888MediaModels(live=null) {
  const available=live?.data;
  if(live!==null&&!Array.isArray(available))throw new Error('888API returned no model list; existing catalog retained.');
  const entries=live===null?[...VIDEO_IDS.map(id=>({id,type:'video'})),...IMAGE_IDS.map(id=>({id,type:'image'}))]:
    available.filter(v=>typeof v?.id==='string'&&v.id.length<192)
      .map(v=>{
        const id=v.id;
        // A Wan "*-image" model is IMAGE-to-VIDEO, not an image generator.
        // Exact documented video IDs must win over generic word heuristics.
        const type=VIDEO_IDS.includes(id)?'video':
          IMAGE_IDS.includes(id)?'image':
          v.type==='image'||v.media_type==='image'||/image|imagen|banana|seedream|flux/i.test(id)&&!/video/i.test(id)?'image':'video';
        return {id,type};
      });
  if(!entries.length)throw new Error('888API returned no recognized media models; existing catalog retained.');
  return entries.map(v=>describedModel(v.id,v.type));
}
// 888API-only policy: 1 CNY of provider cost == 1 CMM customer credit.
// Fixed-price SKUs are charged once per job; per-second SKUs scale with the
// selected duration. Do not apply USD/CNY FX, the prior x3.5 multiplier or
// general provider credit conversion to this source.
function quoteApi888(model,input={}) {
  const {selection}=require('./vercel_models.js');
  const selected=selection(model,input);
  if(model.adapterSupported===false)
    throw Object.assign(new Error('This 888API model requires additional setup.'),{statusCode:400});
  const billing=String(model.api888?.billing||'');
  const rate=Number(model.api888?.sourceCny);
  if(!Number.isFinite(rate)||rate<=0||!['image','job','second'].includes(billing))
    throw Object.assign(new Error('888API model has no verified source price.'),{statusCode:400});
  const duration=billing==='second'?Number(selected.duration):1;
  if(!Number.isFinite(duration)||duration<=0)
    throw Object.assign(new Error('Invalid 888API billed duration.'),{statusCode:400});
  // Wallets, generation charges, and transaction rows use 4 decimal places.
  // This also preserves e.g. 0.065 CNY/s * 5s = 0.325 credits exactly.
  const sourceCny=Math.round((rate*duration+Number.EPSILON)*10000)/10000;
  if(!Number.isFinite(sourceCny)||sourceCny<=0||sourceCny>999999999)
    throw Object.assign(new Error('888API yuan price exceeds supported precision or range.'),{statusCode:400});
  return {...selected,cost:sourceCny,sourceCny,isEstimate:false,
    pricingMode:billing==='second'?'per_second':'per_request'};
}

module.exports={VIDEO_IDS,IMAGE_IDS,ALL_IDS,SPECS,IMAGE_CNY,SORA_VARIANTS,GROK_VARIANTS,isApi888Model,api888MediaModels,quoteApi888};

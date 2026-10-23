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
 'ss-2.5-720p-v1':[5,'job',5,30,'720p',30,10,10],
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

const IMAGE_CNY = {
  'gpt-image-2.5-1k':0.06,'gpt-image-2.5-4k':0.09,
  'gpt-image-2.5-flare':0.05,'gpt-image-2.5-flare-4k':0.09,
  'gpt-image-2.5-sunburst':0.05,'gpt-image-2.5-sunburst-4k':0.09,
  'gpt-image-2':0.05,'gpt-image-2-4k':0.09,
};
const PUBLIC_ID = id => 'api888_' + String(id).replace(/[^a-zA-Z0-9]/g, '_');
const isApi888Model = id => /^api888_/.test(String(id || ''));
const ALL_IDS = new Set([...VIDEO_IDS,...IMAGE_IDS]);
const RATS = ['16:9','9:16','1:1'];
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
    (isImage && Object.hasOwn(IMAGE_CNY,id)) ||
    (/^seedance2\.[05]-.*wool$/.test(id)) ||
    ['seedance2.5-900','seedance2.5-301010','seedance2.5-301010-av',
      'dola-seedance-2.5-900','doubao-seedance-2.5'].includes(id)
  );
  const min=spec?.[2]||5,max=spec?.[3]||15,res=spec?.[4]||'720p';
  const requiredImage=/^minimax-h3-(480p|768p)-t$/.test(id);
  const refs=isImage?makeCaps(0):makeCaps(spec?.[5]||0,0,0,requiredImage);
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
        secondsField:spec?.[1]==='second'?'seconds':'duration',
        imageField:id==='seedance-2.5-c1'?'image_urls':/^seedance2\.0-ss/.test(id)?'referenceImages':'images'},
      durations:isImage?[]:id==='seedance2.5-900'?[5,10,15,30]:id==='pidoi-veo31-fast'?[4,6,8]:id==='doubao-seedance-2.0-mini'?[5,10,15]:range(min,max),
      resolutions:isImage?[]:[res],aspectRatios:isImage?(id==='gpt-image-2'?['1:1','16:9','9:16']:['1:1']):RATS,
      defaultAspectRatio:isImage?'1:1':'16:9',defaultDuration:min,defaultResolution:res,
      referenceCapabilities:refs,mediaRoles:[...refs.image.roles,...refs.video.roles,...refs.audio.roles],
      supportedOperations:isImage?['text-to-image','image-edit']:['text-to-video',...(refs.image.supported?['reference-to-video']:[])],
      imageSizes:[],qualities:[],supportsAudio:false,inputLimits:{text:{max_chars:4096}},
    },
  };
}
function api888MediaModels(live=null) {
  const available=live?.data;
  if(live!==null&&!Array.isArray(available))throw new Error('888API returned no model list; existing catalog retained.');
  const entries=live===null?[...VIDEO_IDS.map(id=>({id,type:'video'})),...IMAGE_IDS.map(id=>({id,type:'image'}))]:
    available.filter(v=>typeof v?.id==='string'&&v.id.length<192)
      .map(v=>({id:v.id,type:IMAGE_IDS.includes(v.id)||/image|imagen|banana|seedream|flux/i.test(v.id)?'image':'video'}));
  if(!entries.length)throw new Error('888API returned no recognized media models; existing catalog retained.');
  return entries.map(v=>describedModel(v.id,v.type));
}
function quoteApi888(model,input,creditsPerCny) {
  const {quoteGateway}=require('./vercel_models.js');
  if(!(Number(creditsPerCny)>0))throw Object.assign(new Error('Configure the CNY-to-customer-credit rate in Admin.'),{statusCode:400});
  const base=quoteGateway(model,input,Number(creditsPerCny));
  if(model.mediaType!=='video'||model.api888?.billing!=='job')return {...base,sourceCny:base.sourceUsd};
  const sourceCny=Number(model.api888.sourceCny);
  if(!(sourceCny>0))throw new Error('Missing fixed job price.');
  return {...base,cost:Math.ceil(sourceCny*Number(creditsPerCny)-1e-9),sourceCny,sourceUsd:sourceCny};
}
module.exports={VIDEO_IDS,IMAGE_IDS,ALL_IDS,SPECS,IMAGE_CNY,isApi888Model,api888MediaModels,quoteApi888};

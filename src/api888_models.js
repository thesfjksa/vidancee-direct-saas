'use strict';

const { api888PromptLimit } = require('./prompt_limits.js');

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
seedance2.5-900-wool seedance2.5-101010-wool seedance2.5-301010-max seedance2.5-301010-wool dola-seedance-2.5-900 dola-seedance-2.5-301010
seedance-2.5-G2-V seedance-2.5-g5-v2 seedance2.5-900 seedance2.5-301010 seedance2.5-301010-av seedance2.5-930-1080p
ss-2.5-720p-v1 ss-2.5-720p-v3 sd2.5-G3-特惠-1 MC-WAN3-Prime-1080P-30S ss-2.0-933-720p s2-2.5-480p-v2 s2-2.5-720p-v3 s2-2.5-720p-v4 doubao-seedance-2.5
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

// Published 888API prices in CNY, checked 24 October 2026 and re-checked
// against the owner's 25 October model-catalog screenshots and /docs. Where
// the catalog card and the docs table disagree, keep the higher price. Absence does not
// mean zero. Do not enable unknown pricing or silently substitute another SKU.
// [CNY, billing type, min seconds, max seconds, resolution, image refs, video refs, audio refs]
const SPECS = {
  'seedance2.0-933-economy':[5,'job',15,15,'720p',9,3,3],
  'pidoi-h3video-2k':[2,'job',15,15,'2k',9,3,3],
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
  'seedance2.5-480p-plus':[0.5,'second',4,15,'480p',0,0,0],
  'seedance2.5-480p-pro':[0.5,'second',4,15,'480p',0,0,0],
  'seedance2.5-720p-plus':[0.75,'second',4,15,'720p',0,0,0],
  'seedance2.5-720p-pro':[0.75,'second',4,15,'720p',0,0,0],
  // 888API /docs (2 Nov 2026): Plus is ¥0.90/s; Pro remains ¥1.25/s.
  'seedance2.5-1080p-plus':[0.9,'second',4,15,'1080p',0,0,0],
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
  // 888API /docs (2 Nov 2026): ¥7/request, 4–30 s, 720p, 30 images.
  // A/V references remain off until the gateway forwards them in a live probe.
  'seedance2.5-301010-max':[7,'job',4,30,'720p',30,0,0],
  'seedance2.5-900':[5.7,'job',5,30,'720p',9,0,0],
  'seedance2.5-900-wool':[1.3,'job',5,30,'720p',9,0,0],
  'seedance2.5-101010-wool':[1.5,'job',5,30,'720p',9,0,0],
  'seedance2.5-301010-wool':[1.9,'job',5,30,'720p',9,0,0],
};

Object.assign(SPECS, {
 'seedance2.5-900-wool':[1.1,'job',4,30,'720p',9,0,0],
 // 888API catalog (28 Oct 2026): 4–10 s, 720p, 9 reference images. Their
 // ¥0.45 / ¥0.55 is a temporary half price; the regular price is kept here.
 'seedance2.0-900-wool':[0.9,'job',4,10,'720p',9,0,0],
 'seedance2.0-933-wool':[1.1,'job',4,10,'720p',9,0,0],
 'seedance2.5-101010-wool':[1.3,'job',4,30,'720p',10,0,0],
 'seedance2.5-301010-wool':[7,'job',4,30,'720p',30,0,0],
 // https://888api.xin/docs (25 Oct 2026): same contract as 301010-wool, 1080P output.
 'seedance2.5-301010-wool-1080p':[10,'job',4,30,'1080p',30,0,0],
 // Official discounted Mini: duration-billed, 4–15 s, *_urls reference arrays.
 'sd_2.0_mini_special':[0.15,'second',4,15,'720p',9,3,3],
 'seedance2.5-900':[5.7,'job',5,30,'720p',9,0,0],
 'seedance2.5-301010':[5.8,'job',5,30,'720p',30,0,0],
 'seedance2.5-301010-av':[5.1,'job',4,30,'720p',30,0,0],
 // 888API rejects 8 reference images ("参数不符合模型能力", 28 Oct 2026)
 // and accepts 4.
 'seedance2.5-930-1080p':[5,'job',5,30,'1080p',4,0,3],
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
 // 888API's October 2026 model card lists native realistic-video 720p,
 // 5–30 seconds, ¥7 fixed, 30 images + 10 videos + 10 audio references.
 // Field mapping follows the G2-V family and still needs a live test.
 'seedance-2.5-g5-v2':[7,'job',5,30,'720p',30,10,10],
 // 888API /api/pricing, 28 Oct 2026 (当前可用).
 'sd2.5-G3-特惠-1':[6,'job',4,30,'720p',30,10,10],
 'ss-2.5-720p-v3':[6.5,'job',4,30,'720p',30,10,10],
 'MC-WAN3-Prime-1080P-30S':[6.5,'job',5,30,'1080p',10,5,5],
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
 // Catalog card (25 Oct 2026): fixed 15 s 720p, ¥4.5 per video.
 'jimeng-video-seedance-2.0-fast-vip':[4.5,'job',15,15,'720p',2,0,0],
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
  'gpt-image-2':0.05,'gpt-image-2-1k':0.04,'gpt-image-2pro':0.075,
  'gemini-3-pro-image-preview':0.12,'gemini-3-pro-image-preview-c':0.075,
  'gemini-3.1-flash-image-preview':0.1,'gemini-3.1-flash-image-preview-c':0.075,
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
// Field names: 888API's docs list images / videos / audios only for the
// models noted there (Seedance 2.5 G-series, SS/S2 2.5, 301010 wool, SS 2.0
// 933, Xin 933). Every other model takes the general video_urls /
// audio_urls fields ("参考素材怎么传"); an unknown field is silently ignored,
// which made Wan 3.0 render without its reference video (25 Oct 2026).
const VIDEO_INPUTS={
 'seedance2.0-full-4img':{videos:3,audios:1,videoField:'referenceVideos',audioField:'referenceAudios'},
 'seedance2.0-fast-4img':{videos:3,audios:1,videoField:'referenceVideos',audioField:'referenceAudios'},
 'doubao-seedance-2-0-fast':{videos:3,audios:3,videoField:'video_urls',audioField:'audio_urls'},
  'ss-2.5-720p-v1':{videos:10,audios:10},
  'ss-2.5-720p-v3':{videos:10,audios:10},
  'sd2.5-G3-特惠-1':{videos:10,audios:10},
  'MC-WAN3-Prime-1080P-30S':{videos:5,audios:5,videoField:'video_urls',audioField:'audio_urls'},
  's2-2.5-480p-v2':{videos:0,audios:10},
  's2-2.5-720p-v3':{videos:10,audios:10},
  's2-2.5-720p-v4':{videos:10,audios:10},
  'dola-seedance-2.5-301010':{videos:10,audios:10},
   'seedance-2.5-g5-v2':{videos:10,audios:10},
  'seedance2.5-930-1080p':{videos:0,audios:3,audioField:'metadata.audios'},
  'wan30-720p':{videos:5,audios:5,videoField:'video_urls',audioField:'audio_urls'},
  'wan30-1080p-fast':{videos:5,audios:5,videoField:'video_urls',audioField:'audio_urls'},
  'wan3.0-video':{videos:10,audios:0,videoField:'video_urls',audioField:'audio_urls'},
  'seedance2.0-933-economy':{videos:3,audios:3,videoField:'video_urls',audioField:'audio_urls'},
  'pidoi-h3video-2k':{videos:3,audios:3,videoField:'video_urls',audioField:'audio_urls'},
  'pidoi-omni-flash-720p':{videos:3,audios:3,videoField:'video_urls',audioField:'audio_urls'},
  'seedance2.0-933':{videos:3,audios:3,videoField:'video_urls',audioField:'audio_urls'},
  'seedance2.0-pro-480p':{videos:3,audios:3,videoField:'video_urls',audioField:'audio_urls'},
  'seedance2.0-933-mini':{videos:0,audios:3,videoField:'video_urls',audioField:'audio_urls'},
  'xin-seedance-2.0-933':{videos:3,audios:3},
  'wan3.0-video-prime':{videos:10,audios:0,videoField:'video_urls',audioField:'audio_urls'},
  'seedance2.5-301010-wool':{videos:10,audios:10},
  'seedance2.5-301010-wool-1080p':{videos:10,audios:10},
  'ss-2.0-933-720p':{videos:3,audios:3},
  'sd_2.0_mini_special':{videos:3,audios:3,videoField:'video_urls',audioField:'audio_urls'},
};
const modelVideoRatios=id=>{
 if(SORA_VARIANTS.includes(id))return [id.endsWith('16x9')?'16:9':'9:16'];
 if(GROK_VARIANTS.includes(id))return ['16:9','9:16'];
 if(id==='jimeng-video-seedance-2.0-fast-vip')return RATS_WIDE;
  if(/^wan3\.0-/.test(id))return ['adaptive',...RATS_WIDE];
  if(/^seedance2\.0-ss(?:-fast)?$/.test(id))return [...RATS,'2:3','3:2'];
  if(/^minimax-h3-(480p|768p)-t$/.test(id))return [...RATS_WIDE,'3:2','2:3'];
  if(/^seedance2\.5-(930-1080p|301010-wool(-1080p)?)$/.test(id))return RATS_WIDE;
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
// Off while 888API's gateway drops reference videos/audio. Tests of the
// multimodal transport turn it on with setApi888MediaRefs(true).
let GATEWAY_FORWARDS_MEDIA_REFS=process.env.API888_MEDIA_REFS==='on';
const setApi888MediaRefs=on=>{GATEWAY_FORWARDS_MEDIA_REFS=Boolean(on);};

// Owner's choice (25 Oct 2026): only these 888API models are offered, under
// these names (Wan 3.0 720p added the same day). Tests of the wider catalog turn the rest on with
// setApi888OfferAll(true).
// 28 Oct 2026: Seedance 2.5 Full Spec (ss-2.5-720p-v3) and Full HD
// (seedance2.5-930-1080p) are off again at
// the owner's request: its jobs were not finishing at 888API.
// Also 28 Oct 2026: every priced Seedance 2.5 SKU is offered too, each under its
// own customer name (never the raw 888API id). Which ones customers see at a
// given moment follows 888API's live model list and health status.
// 31 Oct 2026: sd_2.0_mini_special retired from the 888API customer offer.
// A new Video Studio alias uses vgenv Origin Fast; keep historical 888API
// IDs and jobs intact for reconciliation.
const OFFERED={
 'seedance-2.5-g5-v2':'Seedance 2.5 Realism',
 'seedance2.5-301010-wool':'Seedance 2.5 Standard',
 'seedance2.5-301010-wool-1080p':'Seedance 2.5 Standard HD',
 'seedance2.0-900-wool':'Seedance 2.0 Economy',
 'sd2.5-G3-特惠-1':'Seedance 2.5 Special',
 'seedance2.0-933-economy':'Seedance 2.0 Realism',
 'seedance2.0-stable-480p':'Seedance 2.0 Stable 480p',
 'wan30-1080p-fast':'Wan 3.0 Fast 1080p',
 'MC-WAN3-Prime-1080P-30S':'Wan 3.0 Prime 1080p',
 'seedance2.0-933-wool':'Seedance 2.0 Economy Plus',
 'seedance2.5-101010-wool':'Seedance 2.5 Lite',
 'seedance2.5-900-wool':'Seedance 2.5 Economy',
 'seedance2.5-900':'Seedance 2.5 Classic',
 'seedance2.5-301010':'Seedance 2.5 Multi-Reference',
 'seedance2.5-301010-av':'Seedance 2.5 Beta',
 'seedance2.5-301010-max':'Seedance 2.5 Max',
 'doubao-seedance-2.5':'Seedance 2.5 Original',
 'dola-seedance-2.5':'Seedance 2.5 Flex',
 'dola-seedance-2.5-900':'Seedance 2.5 Flex Lite',
 'dola-seedance-2.5-301010':'Seedance 2.5 Flex Pro',
 'xin-seedance-2.5-3010':'Seedance 2.5 Swift',
 'xin-seedance-2.5-900':'Seedance 2.5 Swift Lite',
 'seedance2.5-vip-30-10-10':'Seedance 2.5 VIP',
 'seedance2.5-vip-30-0-10':'Seedance 2.5 VIP Long',
 'ss-2.5-720p-v1':'Seedance 2.5 Studio',
 's2-2.5-480p-v2':'Seedance 2.5 Draft',
 's2-2.5-720p-v3':'Seedance 2.5 Cinema',
 's2-2.5-720p-v4':'Seedance 2.5 Director',
 'seedance2.5-480p-value':'Seedance 2.5 Value 480p',
 'seedance2.5-480p-plus':'Seedance 2.5 Plus 480p',
 'seedance2.5-480p-pro':'Seedance 2.5 Pro 480p',
 'seedance2.5-720p-plus':'Seedance 2.5 Plus 720p',
 'seedance2.5-720p-pro':'Seedance 2.5 Pro 720p',
 'seedance2.5-1080p-plus':'Seedance 2.5 Plus 1080p',
 'seedance2.5-1080p-pro':'Seedance 2.5 Pro 1080p',
 'seedance2.0-933':'Seedance 2.0 Standard',
 'wan3.0-video-prime':'Wan 3.0 Video Prime',
 'wan30-720p':'Wan 3.0 Standard',
};
let OFFER_ALL=false;
const setApi888OfferAll=on=>{OFFER_ALL=Boolean(on);};

// Customer-facing names. The label adds resolution and reference limits, so
// SKUs of one family are distinguishable in the model picker.
const NAMES={
 'wan30-720p':'Wan 3.0','wan30-1080p-fast':'Wan 3.0 Fast',
 'wan3.0-video':'Wan 3.0 Video','wan3.0-video-prime':'Wan 3.0 Video Prime',
 'wan3.0-image':'Wan 3.0 Image-to-Video','wan3.0-image-prime':'Wan 3.0 Image-to-Video Prime',
 'minimax-h3-480p-t':'MiniMax H3','minimax-h3-768p-t':'MiniMax H3','pidoi-h3video-2k':'MiniMax H3 Multi-Reference',
 'sd_2.0_mini_special':'Seedance 2.0 Mini Special','doubao-seedance-2.0-mini':'Seedance 2.0 Mini',
 'seedance2.0-933':'Seedance 2.0 Full','seedance2.0-933-economy':'Seedance 2.0 Economy',
 'seedance2.0-933-fast':'Seedance 2.0 Fast','seedance2.0-pro-480p':'Seedance 2.0 Pro',
 'seedance2.0-480p':'Seedance 2.0','seedance2.0-720p':'Seedance 2.0',
 'seedance2.0-stable-480p':'Seedance 2.0 Stable','seedance2.0-stable-720p':'Seedance 2.0 Stable',
 'ss-2.0-933-720p':'Seedance 2.0 SS','jimeng-video-seedance-2.0-fast-vip':'Seedance 2.0 Fast VIP',
 'seedance2.5-480p-value':'Seedance 2.5 Value',
 'seedance2.5-480p-plus':'Seedance 2.5 Plus','seedance2.5-720p-plus':'Seedance 2.5 Plus','seedance2.5-1080p-plus':'Seedance 2.5 Plus',
 'seedance2.5-480p-pro':'Seedance 2.5 Pro','seedance2.5-720p-pro':'Seedance 2.5 Pro','seedance2.5-1080p-pro':'Seedance 2.5 Pro',
 'seedance2.5-930-1080p':'Seedance 2.5','seedance-2.5-g5-v2':'Seedance 2.5 G5 Realistic',
 'seedance2.5-301010-wool':'Seedance 2.5 Economy','seedance2.5-301010-wool-1080p':'Seedance 2.5 Economy',
 'seedance2.5-101010-wool':'Seedance 2.5 Economy','seedance2.5-900-wool':'Seedance 2.5 Economy',
 'sora2-480p':'Sora 2',
 'gpt-image-2':'GPT Image 2','gpt-image-2-1k':'GPT Image 2','gpt-image-2-4k':'GPT Image 2','gpt-image-2pro':'GPT Image 2 Pro',
 'gpt-image-2.5-1k':'GPT Image 2.5','gpt-image-2.5-4k':'GPT Image 2.5',
 'gpt-image-2.5-flare':'GPT Image 2.5 Flare','gpt-image-2.5-flare-4k':'GPT Image 2.5 Flare',
 'gpt-image-2.5-sunburst':'GPT Image 2.5 Sunburst','gpt-image-2.5-sunburst-4k':'GPT Image 2.5 Sunburst',
 'gemini-3-pro-image-preview':'Gemini 3 Pro Image','gemini-3.1-flash-image-preview':'Gemini 3.1 Flash Image',
};
const prettyId=id=>id.replace(/[-_]/g,' ').replace(/\b\w/g,m=>m.toUpperCase());

// gpt-image-2 sizes from https://888api.xin/docs (width and height multiples
// of 16). Other 888API image models use the same WxH size field.
const IMAGE_SIZES={
 '1k':{'1:1':'1024x1024','9:16':'864x1536','16:9':'1536x864'},
 '2k':{'1:1':'2048x2048','9:16':'1152x2048','16:9':'2048x1152'},
 '4k':{'1:1':'2880x2880','9:16':'2160x3840','16:9':'3840x2160'},
};
const imageTier=id=>/-4k$/.test(id)?'4k':id==='gpt-image-2'?'2k':/-1k$/.test(id)?'1k':null;
const imageRatios=id=>/^gpt-image-2-?pro$/.test(id)?['1:1']:['1:1','16:9','9:16'];
function api888ImageSize(id,ratio){
  const sizes=IMAGE_SIZES[imageTier(String(id))||'1k'];
  return imageRatios(String(id)).includes(ratio)?sizes[ratio]:null;
}
function api888Label(id,type,{res,images=0,videos=0,audios=0,requiredImage=false}={}){
  if(OFFERED[id]&&!OFFER_ALL)return OFFERED[id];
  const parts=[NAMES[id]||prettyId(id)];
  if(type==='image'){const tier=imageTier(id);if(tier)parts.push(tier.toUpperCase());return parts.join(' · ');}
  if(res)parts.push(/k$/i.test(res)?res.toUpperCase():res);
  const refs=[];
  if(images)refs.push((requiredImage?'1–':'')+images+' img');
  if(videos)refs.push(videos+' video');
  if(audios)refs.push(audios+' audio');
  parts.push(refs.length?refs.join(' + '):'Text only');
  return parts.join(' · ');
}
function describedModel(id,type) {
  const isImage=type==='image';
  const spec=SPECS[id],cny=IMAGE_CNY[id];
  const known=isImage?Number(cny)>0:Boolean(spec&&Number(spec[0])>0);
  // Explicitly supported request families. Unreviewed channels are imported
  // as Admin-only entries, never silently mapped to an incompatible API.
  // Models that cannot run without a reference video are unusable while the
  // gateway drops video references.
  const needsVideo=['doubao-seedance-2-0-fast','doubao-seedance-2-0'].includes(id);
  // MiniMax H3 is sold from vgenv; the 888API MiniMax models are not offered.
  const vgenvMinimax=/^(minimax-h3|pidoi-h3video)/.test(id);
  const offered=OFFER_ALL||Object.hasOwn(OFFERED,id);
  const implemented=known && offered && !vgenvMinimax && (GATEWAY_FORWARDS_MEDIA_REFS||!needsVideo) && (
    (isImage && ['gpt-image-2.5-1k','gpt-image-2.5-4k', 'gpt-image-2.5-sunburst','gpt-image-2.5-sunburst-4k','gpt-image-2-4k',
      'gpt-image-2.5-flare','gpt-image-2.5-flare-4k','gpt-image-2-1k',
      'gpt-image-2','gpt-image-2pro','gemini-3-pro-image-preview','gemini-3-pro-image-preview-c',
      'gemini-3.1-flash-image-preview','gemini-3.1-flash-image-preview-c'].includes(id)) ||
    (!isImage && (SORA_VARIANTS.includes(id)||GROK_VARIANTS.includes(id))) ||
    (/^seedance2\.[05]-.*wool$/.test(id)) ||
    [// Published, priced models using the existing generic /v1/videos contract.
      // Live account model discovery and Admin access gates still apply.
      'seedance2.0-full-4img','seedance2.0-fast-4img','doubao-seedance-2-0-fast',
      'jimeng-video-seedance-2.0-fast-vip',
      'seedance2.0-933-economy','pidoi-h3video-2k','pidoi-omni-flash-720p','pidoi-veo31-fast',
      'seedance2.0-933','seedance2.0-pro-480p','seedance2.0-933-fast','seedance2.0-933-mini',
      'xin-seedance-2.0-900','xin-seedance-2.0-933',
      'seedance2.0-ss','seedance2.0-ss-fast',
      'seedance2.5-480p-value','seedance2.5-480p-plus','seedance2.5-480p-pro',
      'seedance2.5-720p-plus','seedance2.5-720p-pro',
      'seedance2.5-1080p-plus','seedance2.5-1080p-pro',
      'seedance2.5-900','seedance2.5-301010','seedance2.5-301010-av','seedance2.5-301010-max',
      'dola-seedance-2.5-900','dola-seedance-2.5-301010','seedance-2.5-g5-v2','doubao-seedance-2.5',
      'dola-seedance-2.5','xin-seedance-2.5-3010','xin-seedance-2.5-900',
      'seedance2.5-vip-30-10-10','seedance2.5-vip-30-0-10',
      'ss-2.5-720p-v1','ss-2.5-720p-v3','sd2.5-G3-特惠-1','MC-WAN3-Prime-1080P-30S','s2-2.5-480p-v2','s2-2.5-720p-v3',
      's2-2.5-720p-v4','seedance2.5-930-1080p',
      'doubao-seedance-2.0-mini','ss-2.0-933-720p','seedance2.5-301010-wool-1080p',
      'sd_2.0_mini_special',
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
  // 888API's gateway forwards only `images` on POST /v1/videos: tagged-link
  // tests on 25 Oct 2026 showed reference videos and audio are never fetched
  // (docs/API888.md). Offer image references only until 888API changes that.
  const refs=isImage?makeCaps(0):makeCaps(spec?.[5]||0,
    GATEWAY_FORWARDS_MEDIA_REFS?inputs.videos||0:0,GATEWAY_FORWARDS_MEDIA_REFS?inputs.audios||0:0,requiredImage);
  if(id==='doubao-seedance-2-0-fast'&&GATEWAY_FORWARDS_MEDIA_REFS){refs.video.min=1;refs.textOnly=false;}
  // Total reference-video length: 15 s for Seedance 2.0 (888API docs), 30 s
  // for Seedance 2.5 and Wan (owner-confirmed). Longer uploads are trimmed.
  if(refs.video.max)refs.video.maxTotalSeconds=/2\.5|g5|^wan/i.test(id)?30:15;
  // The upstream limits some multimodal models to 12 total items, even
  // though their individual image/video/audio maxima sum to 15.
  if(['seedance2.0-933-economy','pidoi-h3video-2k','seedance2.0-933',
      'xin-seedance-2.0-933'].includes(id))refs.totalMax=12;
  const videoFlat=spec?.[1]==='job';
  const pricing=isImage?{image:cny||0}:{video_duration_pricing:known?[{resolution:res,cost_per_second:videoFlat?spec[0]/min:spec[0]}]:[]};
  // Flag fixed-per-request billing separately; quoteApi888 applies the same
  // fixed CNY cost at ANY supported duration instead of overcharging by seconds.
  return {
    providerModelId:id,publicModelId:PUBLIC_ID(id),
    label:api888Label(id,type,{res,images:refs.image.max,videos:refs.video.max,audios:refs.audio.max,requiredImage}),
    mediaType:type,options:{
      catalogVerified:true,adapterSupported:implemented,
      setupReason:implemented?'':vgenvMinimax?'MiniMax H3 is offered from vgenv instead.':!offered?'Not offered on CMM Tools.':known?'This 888API model needs verified request mapping.':'No verified 888API price/contract for this model; keep disabled.',
      gatewayType:type,pricing,api888:{unit:'CNY',billing:isImage?'image':spec?.[1],sourceCny:isImage?cny:spec?.[0],
        secondsField:spec?.[1]==='second'&&!['doubao-seedance-2-0-fast','jimeng-video-seedance-2.0-fast-vip','sd_2.0_mini_special'].includes(id)?'seconds':'duration',
        imageField:['seedance-2.5-c1','doubao-seedance-2-0-fast','sd_2.0_mini_special'].includes(id)?'image_urls':
          (id==='jimeng-video-seedance-2.0-fast-vip'||/^seedance2\.0-(ss|full-4img|fast-4img)/.test(id)?'referenceImages':'images'),
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
      resolutions:isImage?[]:(id==='pidoi-veo31-fast'?['720p','1080p']:(/^seedance2\.0-ss(?:-fast)?$/.test(id)||id==='seedance2.0-933-mini')?['480p','720p']:[res]),aspectRatios:isImage?imageRatios(id):modelVideoRatios(id),
      defaultAspectRatio:isImage?'1:1':SORA_VARIANTS.includes(id)&&id.endsWith('9x16')?'9:16':'16:9',
      defaultDuration:min,defaultResolution:res,
      referenceCapabilities:refs,mediaRoles:[...refs.image.roles,...refs.video.roles,...refs.audio.roles],
            supportedOperations:isImage?['text-to-image']:[...(refs.textOnly?['text-to-video']:[]),
        ...((refs.image.supported||refs.video.supported||refs.audio.supported)?['reference-to-video']:[])],
      imageSizes:[],qualities:[],supportsAudio:false,inputLimits:{text:{max_chars:api888PromptLimit(id)}},
    },
  };
}
// Reviewed per-second Seedance contracts. A new upstream SKU still needs its
// own input mapping; a price-table row alone never grants account access.
const SEEDANCE25_DYNAMIC_IDS=Object.keys(SPECS).filter(id=>/^seedance2\.5-/.test(id)&&SPECS[id][1]==='second');
function seedance25LiveRate(pricing,id){
  if(pricing?.success!==true||pricing.group_ratio?.default!==1||!Array.isArray(pricing.data))return null;
  const rows=pricing.data.filter(row=>row?.model_name===id);
  if(rows.length!==1)return null;
  const row=rows[0];
  if(row.quota_type!==1||row.billing_mode!=='tiered_expr'||!Array.isArray(row.enable_groups)||!row.enable_groups.includes('default'))return null;
  // Recognize only the observed seconds * rate expression. Never evaluate
  // provider-supplied code or mistake a flat request price for a second rate.
  const match=String(row.billing_expr||'').match(/^\s*tier\(\s*"base"\s*,\s*\(\s*u\(\s*"seconds"\s*\)\s*\*\s*(\d+(?:\.\d+)?)\s*\)\s*\)\s*$/);
  const rate=Number(match?.[1]);
  return Number.isFinite(rate)&&rate>0&&rate<=10000&&typeof row.model_price==='number'&&Math.abs(rate-row.model_price)<1e-9?rate:null;
}
function applySeedance25LivePrice(model,live){
  if(!SEEDANCE25_DYNAMIC_IDS.includes(model.providerModelId)||!Object.hasOwn(live||{},'pricing'))return model;
  const rate=seedance25LiveRate(live.pricing,model.providerModelId);
  model.options.api888={...model.options.api888,sourceCny:rate,
    priceSource:'888api-public-default',priceCheckedAt:live.pricingCheckedAt||null};
  model.options.pricing.video_duration_pricing=rate===null?[]:[{resolution:model.options.defaultResolution,cost_per_second:rate}];
  if(rate===null){
    model.options.adapterSupported=false;
    model.options.setupReason='A verified live Seedance 2.5 per-second price is unavailable. Import models and prices again.';
  }
  return model;
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
  return entries.map(v=>applySeedance25LivePrice(describedModel(v.id,v.type),live));
}
// 888API-only policy: 1 CNY of provider cost == 1 CMM customer credit.
// Fixed-price SKUs are charged once per job; per-second SKUs scale with the
// selected duration. Do not apply USD/CNY FX, the prior x3.5 multiplier or
// general provider credit conversion to this source.
function quoteApi888(model,input={}) {
  const {cnyToCredits}=require('./billing.js');
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
  // The yuan cost (4 decimals, e.g. 0.065 CNY/s * 5 s = 0.325) is kept for
  // the record; the customer pays it at cost in credits (billing.js).
  const sourceCny=Math.round((rate*duration+Number.EPSILON)*10000)/10000;
  if(!Number.isFinite(sourceCny)||sourceCny<=0||sourceCny>999999)
    throw Object.assign(new Error('888API yuan price exceeds supported precision or range.'),{statusCode:400});
  return {...selected,cost:cnyToCredits(sourceCny),sourceCny,isEstimate:false,
    pricingMode:billing==='second'?'per_second':'per_request'};
}

module.exports={SEEDANCE25_DYNAMIC_IDS,seedance25LiveRate,VIDEO_IDS,IMAGE_IDS,ALL_IDS,SPECS,IMAGE_CNY,SORA_VARIANTS,GROK_VARIANTS,isApi888Model,api888MediaModels,quoteApi888,api888ImageSize,api888Label,setApi888MediaRefs,setApi888OfferAll,OFFERED_API888_MODELS:Object.keys(OFFERED)};


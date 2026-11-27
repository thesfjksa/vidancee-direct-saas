'use strict';

// Reviewed model contracts, 2026-11-27. Public prices come from /api/pricing;
// the authenticated /v1/models list is authoritative for account eligibility.
const {createHash}=require('node:crypto');
const {CNY_PER_USD}=require('./billing');
const BASE_URL='https://api.bjhuiqu.net';
const GROUP='1.3-视频生成'; // Create the token in the 1x video group.
const reviewed=require('./provider/huiqu_catalog.json');
const isHuiquModel=id=>/^huiqu_[a-f0-9]{24}$/.test(String(id||''));
const publicId=id=>'huiqu_'+createHash('sha256').update(id).digest('hex').slice(0,24);
const isVideo=row=>String(row?.tags||'').split(',').includes('视频生成')||row?.supported_endpoint_types?.includes('video-generation');
const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const MiB=1024*1024;
const bad=message=>Object.assign(new Error(message),{statusCode:400});
function priceFor(row,groupRatio){
  if(Number(groupRatio)!==1||!row.enable_groups?.includes(GROUP))return null;
  // Never execute upstream expressions. Accept only the two reviewed linear
  // billing forms; a changed/unknown expression removes the route from sale.
  if(row.billing_expr){
    const match=String(row.billing_expr).match(/^tier\("[^"]+",\s*u\("(seconds|requests)"\)\s*\*\s*(\d+(?:\.\d+)?)\s*\)$/);
    if(!match)return null;
    const price=Number(match[2]);
    return price>0?{unit:match[1]==='seconds'?'second':'request',priceCny:price}:null;
  }
  const price=Number(row.model_price);
  return Number(row.quota_type)===1&&Number.isFinite(price)&&price>0&&String(row.tags||'').includes('按次计费')?{unit:'request',priceCny:price}:null;
}

function huiquMediaModels(pricing,account=null){
  if(pricing?.success!==true||!Array.isArray(pricing.data))throw new Error('Video pricing catalog unavailable.');
  const accountIds=account===null?new Set():new Set(Array.isArray(account.data)?account.data.map(r=>r.id):[]);
  if(account!==null&&!Array.isArray(account?.data))throw new Error('Account model list unavailable.');
  const rows=pricing.data.filter(isVideo);
  if(!rows.length)throw new Error('No video entries in the pricing catalog; inventory unchanged.');
  return rows.map(row=>{
    const id=String(row.model_name||'');
    const spec=Object.hasOwn(reviewed,id)?reviewed[id]:null;
    const price=priceFor(row,pricing.group_ratio?.[GROUP]);
    const accessible=accountIds.has(id);
    const reason=spec?.hold||(!spec?'Unreviewed video route.':!price?'Unsupported or changed billing formula.':!accessible?'Not available to the saved video-group API key.':'');
    const ready=!reason;
    const [min,max]=spec?.seconds||[5,5];
    const durations=range(min,max),resolutions=spec?.resolutions||[spec?.resolution||'720p'];
    const ratios=spec?.ratios||['16:9','9:16'];
    const [images,videos,audios]=spec?.refs||[0,0,0];
    const ref=(kind,max,min,formats,maxBytes)=>({supported:max>0,max,min,roles:max>0?[kind+'_references']:[],formats,maxBytes});
    const caps={textOnly:!spec?.required,totalMax:spec?.total||images+videos+audios,
      image:ref('image',images,spec?.required==='image'?1:0,['jpg','jpeg','png','webp'],10*MiB),
      video:ref('video',videos,0,['mp4','mov'],25*MiB),
      audio:ref('audio',audios,0,['mp3','wav'],15*MiB)};
    if(spec?.videoTotalSeconds)caps.video.maxTotalSeconds=spec.videoTotalSeconds;
    const priceTables={video_duration_prices:[],video_duration_pricing:[]};
    if(price){
      for(const resolution of resolutions){
        if(price.unit==='second')priceTables.video_duration_pricing.push({resolution,cost_per_second:price.priceCny/CNY_PER_USD});
        else priceTables.video_duration_prices.push(...durations.map(duration=>({resolution,duration,cost:price.priceCny/CNY_PER_USD})));
      }
    }
    return {providerModelId:id,publicModelId:publicId(id),label:(spec?.label||id)+' · Huiqu',mediaType:'video',options:{
      catalogVerified:true,adapterSupported:ready,setupReason:reason,eligibility:{status:accessible?'eligible':'ineligible'},
      gatewayType:'video',pricing:priceTables,durations,resolutions,aspectRatios:ratios,defaultResolution:resolutions[0],
      defaultDuration:durations.includes(5)?5:durations[0],defaultAspectRatio:'16:9',
      inputLimits:{text:{max_chars:spec?.promptMax||2000}},referenceCapabilities:caps,
      mediaRoles:[...caps.image.roles,...caps.video.roles,...caps.audio.roles],
      supportedOperations:[...(caps.textOnly?['text-to-video']:[]),'reference-to-video'],
      huiqu:{...spec,price,accessible},
    }};
  });
}
function validateHuiquReferences(model,input,{forQuote=false}={}){
  if(forQuote)return;
  const spec=model.huiqu||{},videos=input.videos||[],images=input.images||[],audios=input.audios||[];
  let reuse=input.reuseImageIds||[];
  if(typeof reuse==='string')reuse=JSON.parse(reuse);
  if(spec.required==='any'&&!videos.length&&!images.length&&!audios.length&&!reuse.length)throw bad('This model requires a reference file.');
  if(videos.length&&(Number(input.duration)<(spec.minVideoDuration||0)||Number(input.duration)>(spec.maxVideoDuration||Infinity)))
    throw bad('The selected duration is not supported with video references.');
  if(videos.length&&(spec.videoTotalSeconds||spec.videoClipSeconds)){
    const {mp4Seconds}=require('./vercel_models');
    const seconds=videos.map(v=>mp4Seconds(v.data));
    if(seconds.some(n=>!Number.isFinite(n)||n<=0||n>(spec.videoClipSeconds||Infinity)+.05)||seconds.reduce((a,b)=>a+b,0)>(spec.videoTotalSeconds||Infinity)+.05)
      throw bad('Reference video duration exceeds this model’s limit.');
  }
}
module.exports={BASE_URL,GROUP,publicId,isHuiquModel,huiquMediaModels,validateHuiquReferences,priceFor};

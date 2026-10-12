'use strict';

const { SMART_IMAGE_SIZES } = require('./smartaipi_images.js');
const DEFAULT_VERCEL_CREDITS_PER_USD = 160 / 0.0265;
const COMMON_RATIOS = ['1:1','16:9','9:16','4:3','3:4','3:2','2:3'];
const GOOGLE_RATIOS = [...COMMON_RATIOS,'4:5','5:4','21:9'];
const fail = message => { throw Object.assign(new Error(message), {statusCode:400}); };
const positive = value => Number.isFinite(Number(value)) && Number(value)>0;
const unique = values => [...new Set((Array.isArray(values)?values:[]))];

// The gateway bills GPT Image models by tokens, so its catalog has no per-image
// price. These are OpenAI's published per-image prices (Images API, standard
// tier) for 1024x1024, 1024x1536 and 1536x1024, checked on 12 October 2026 in
// developers.openai.com/api/docs/guides/image-generation ("Calculating costs").
const OPENAI_SIZES=['1024x1024','1024x1536','1536x1024'];
const OPENAI_IMAGE_USD={
  'gpt-image-1':{low:[0.011,0.016,0.016],medium:[0.042,0.063,0.063],high:[0.167,0.25,0.25]},
  'gpt-image-1-mini':{low:[0.005,0.006,0.006],medium:[0.011,0.015,0.015],high:[0.036,0.052,0.052]},
  'gpt-image-1.5':{low:[0.009,0.013,0.013],medium:[0.034,0.05,0.05],high:[0.133,0.2,0.2]},
  'gpt-image-2':{low:[0.006,0.005,0.005],medium:[0.053,0.041,0.041],high:[0.211,0.165,0.165]},
};
// GPT Image 2.5 has the same output-token price as GPT Image 2 but no published
// per-image table, so it uses GPT Image 2's figures as an estimate.
const OPENAI_IMAGE_ALIASES={'gpt-image-2.5-flare':'gpt-image-2','gpt-image-2.5-sunburst':'gpt-image-2'};

function publishedImageTiers(providerModelId) {
  const name=String(providerModelId||'').replace(/^openai\//,'');
  if (!String(providerModelId||'').startsWith('openai/')) return [];
  const prices=OPENAI_IMAGE_USD[OPENAI_IMAGE_ALIASES[name]||name];
  if (!prices) return [];
  // GPT Image 2 also renders the other presets. OpenAI publishes only these three
  // sizes, and non-square can cost less than square, so other sizes use the
  // highest published price for the quality rather than an area guess.
  const sizes=/^gpt-image-2/.test(name)?unique([...OPENAI_SIZES,...Object.values(SMART_IMAGE_SIZES)]):OPENAI_SIZES;
  return Object.entries(prices).flatMap(([quality,usd])=>sizes.map(size=>{
    const index=OPENAI_SIZES.indexOf(size);
    return {size,quality,cost:index>=0?usd[index]:Math.max(...usd)};
  }));
}

// FLUX 3 is priced by resolution class (768 px to 4K); the catalog lists the
// classes as squares. Other shapes keep the class's pixel count and price.
// Not yet confirmed with a paid request: if the gateway rejects a shape,
// remove it here.
const FLUX3_SHAPES={'bfl/flux-3-image':['1:1','16:9','9:16','4:3','3:4','3:2','2:3']};

function classDimensions(squareSize,ratio) {
  const side=Number(String(squareSize).split('x')[0]);
  const [a,b]=String(ratio).split(':').map(Number);
  if (!side||!a||!b||a===b) return squareSize;
  // Same pixel count as the square class, but never longer than 4096 px.
  const fit=Math.min(1,4096/(side*Math.sqrt(Math.max(a,b)/Math.min(a,b))));
  const w=Math.round(side*fit*Math.sqrt(a/b)/16)*16,h=Math.round(side*fit*Math.sqrt(b/a)/16)*16;
  return w+'x'+h;
}

// Models synced before a change keep their stored options; apply current rules.
function applyModelFixups(model) {
  if (model && FLUX3_SHAPES[model.providerModelId]) model.aspectRatios=[...FLUX3_SHAPES[model.providerModelId]];
  return model;
}

function isGatewayModel(id) { return String(id||'').startsWith('studio_gw_'); }
function publicId(id) { return 'studio_gw_'+String(id).replace(/[^a-zA-Z0-9]/g,'_'); }
function mediaModels(catalog) {
  if(catalog?.catalog_status==='partial')fail('The model catalog was incomplete. The previous catalog has been kept.');
  if (!Array.isArray(catalog?.data) || !catalog.data.length) fail('The live model catalog was empty. The previous catalog has been kept.');
  const models=catalog.data.filter(m=>m.type==='video'||m.type==='image'||m.modalities?.output?.includes('image'));
  if (!models.length || models.some(m=>!m.id||!m.name)) fail('The live media catalog was invalid. The previous catalog has been kept.');
  return models.map(discoverModel);
}

function discoverModel(raw) {
  const id=raw.id, video=raw.type==='video', cap=raw.video_capabilities||{}, ops=cap.supported_operations||[];
  const limits=cap.input_limits||{}, pricing=raw.pricing||{};
  const multimodal=raw.type==='language';
  const specialized=/^(topaz|quiverai)\//.test(id)||/motion-control|flux-pro-1\.0-fill|recraft.*utility/.test(id);
  let aspectRatios=video?unique(cap.supported_aspect_ratios).filter(r=>/^\d+:\d+$/.test(r)):
    id.startsWith('google/')?(id==='google/gemini-nano-banana-2.1'?[...GOOGLE_RATIOS,'1:8','8:1','1:4','4:1']:GOOGLE_RATIOS):id.startsWith('openai/')?
      (/gpt-image-2/.test(id)?Object.keys(SMART_IMAGE_SIZES):['1:1','3:2','2:3']):COMMON_RATIOS;
  // The catalog does not describe raster sizes for these families. Restrict the
  // baseline to documented/common square output rather than inventing controls.
  if (!video && !/^(google|openai|bfl|bytedance|spacexai|recraft)\//.test(id)) aspectRatios=['1:1'];
  const tiers=pricing.image_dimension_quality_pricing||[];
  let imageSizes=id.startsWith('google/')?unique(tiers.map(t=>t.size).filter(s=>s&&s!=='default')):[];
  if (!imageSizes.length && id.startsWith('google/')) imageSizes=['1K'];
  if (id==='bfl/flux-3-image') imageSizes=unique(tiers.map(t=>t.size).filter(s=>/^\d+x\d+$/.test(s)));
  if (imageSizes.some(s=>/^\d+x\d+$/.test(s))) aspectRatios=FLUX3_SHAPES[id]||['1:1'];
  if(id.startsWith('bytedance/seedream-'))imageSizes=/5\.0-pro/.test(id)?['1K','2K']:/4\.0/.test(id)?['1K','2K','4K']:['2K','4K'];
  const qualities=id.startsWith('openai/')?['low','medium','high']:
    tiers.some(t=>t.quality==='low')?['low','medium']:[];
  const imageInput=video?limits.image:
    raw.modalities?.input?.includes('image')||id.startsWith('bytedance/seedream-')||/^(openai\/gpt-image|bfl\/flux-kontext|spacexai\/grok-imagine-image)/.test(id)?{max_count:1}:null;
  const acceptsFrames=video && ops.some(o=>['image-to-video','first-last-frame'].includes(o));
  const acceptsRefs=video && ops.includes('reference-to-video');
  const roles=imageInput?(video?
    unique([...(acceptsFrames?['start_image']:[]),...(ops.includes('first-last-frame')?['end_image']:[]),...(acceptsRefs?['image_references']:[])]):['image_references']):[];
  const textOnly=!video||ops.includes('text-to-video');
  const needsImage=video&&!textOnly&&!acceptsRefs;
  const kind=(input,kindRoles,min=0)=>({supported:Boolean(input&&kindRoles.length),max:input&&kindRoles.length?Math.min(20,Number(input.max_count||1)):0,min,
    roles:kindRoles,requiredRoles:needsImage&&kindRoles.includes('start_image')?['start_image']:[],
    maxBytes:Math.min(25,Number(input?.max_file_size_mb||25))*1024*1024,
    formats:input?.supported_formats||[]});
  const referenceCapabilities={textOnly,totalMax:Math.min(20,Number(limits.max_total_inputs||20)),
    image:kind(imageInput,roles,needsImage?1:0),
    video:kind(acceptsRefs?limits.video:null,acceptsRefs&&limits.video?['video']:[]),audio:{supported:false,max:0,min:0,roles:[]}};
  const rates=pricing.video_duration_pricing||[];
  const modes=unique(rates.map(t=>t.mode).filter(Boolean));
  const options={catalogVerified:true,adapterSupported:!specialized&&(!video||(ops.length>0&&aspectRatios.length>0)),
    setupReason:specialized?'This model requires a specialized editing, vector, or motion-control workflow.':
      video&&!ops.length?'The catalog does not yet expose generation settings for this model.':'',
    gatewayType:raw.type,pricing,inputLimits:limits,supportedOperations:ops,
    eligibility:raw.model_eligibility||null,
    durations:unique(cap.supported_durations_seconds).map(Number).sort((a,b)=>a-b),
    resolutions:unique(cap.supported_resolutions),aspectRatios,
    defaultAspectRatio:aspectRatios.includes(video?'16:9':'1:1')?(video?'16:9':'1:1'):aspectRatios[0],
    defaultDuration:cap.supported_durations_seconds?.includes(5)?5:cap.supported_durations_seconds?.[0],
    defaultResolution:cap.supported_resolutions?.includes('720p')?'720p':cap.supported_resolutions?.[0],
    fps:cap.supported_fps?.[0]||24,modes,defaultMode:modes.includes('std')?'std':modes[0],
    supportsAudio:cap.generate_audio===true,qualities,defaultQuality:qualities.includes('medium')?'medium':qualities[0],
    imageSizes,defaultImageSize:imageSizes.includes('1K')?'1K':imageSizes.includes('1024x1024')?'1024x1024':imageSizes[0],
    mediaRoles:[...roles,...referenceCapabilities.video.roles],referenceCapabilities};
  return {providerModelId:id,publicModelId:publicId(id),label:raw.name,mediaType:video?'video':'image',options};
}

function normalizePriceOverride(value, mediaType) {
  if (value===null || value==='') return null;
  if (!value || typeof value!=='object'||Array.isArray(value)) fail('Use a price object or null to restore catalog pricing.');
  const keys=mediaType==='video'?['perSecond']:['perImage','low','medium','high'];
  if (!Object.keys(value).length||Object.keys(value).some(k=>!keys.includes(k))||Object.values(value).some(n=>!positive(n)||Number(n)>1000))
    fail(mediaType==='video'?'Video pricing must contain a positive perSecond USD rate.':'Image pricing must contain positive perImage or low / medium / high USD rates.');
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,Number(v)]));
}

function modelReady(model) {
  if (!model?.adapterSupported || model?.eligibility?.status==='ineligible') return false;
  try { quoteGateway(model,{},DEFAULT_VERCEL_CREDITS_PER_USD); return true; } catch { return false; }
}

function selection(model,input={}) {
  if (!model?.adapterSupported) fail(model?.setupReason||'This model requires additional setup.');
  if (model.eligibility?.status==='ineligible') fail('This model is unavailable for the configured account. Sync the catalog after updating account access.');
  const choose=(value,values,fallback,label)=>{
    const v=value===undefined||value===''||value===null?fallback:value;
    if (!values.includes(v)) fail('Unsupported '+label+' for this model.');
    return v;
  };
  const aspectRatio=choose(input.aspectRatio||input.aspect_ratio,model.aspectRatios,model.defaultAspectRatio,'aspect ratio');
  const prompt=String(input.prompt||'');
  if (prompt.length>Number(model.inputLimits?.text?.max_chars||8000)) fail('The prompt exceeds this model’s text limit.');
  if (model.mediaType==='image') {
    const quality=model.qualities?.length?choose(input.quality,model.qualities,model.defaultQuality,'image quality'):null;
    if (!model.qualities?.length && input.quality) fail('This model does not support a quality switch.');
    const imageSize=model.imageSizes?.length?choose(input.imageSize,model.imageSizes,model.defaultImageSize,'image resolution'):null;
    if (!model.imageSizes?.length && input.imageSize) fail('This model does not support a resolution switch.');
    return {aspectRatio,quality,imageSize};
  }
  const duration=choose(input.duration===undefined?undefined:Number(input.duration),model.durations,model.defaultDuration,'duration');
  const resolution=choose(input.resolution,model.resolutions,model.defaultResolution,'resolution');
  const generationMode=model.modes?.length?choose(input.generationMode,model.modes,model.defaultMode,'generation mode'):null;
  if (input.generationMode&&!model.modes?.length) fail('This model does not support a mode switch.');
  const generateAudio=input.generateAudio===true||input.generateAudio==='true';
  if (generateAudio&&!model.supportsAudio) fail('This model does not support generated audio.');
  return {aspectRatio,duration,resolution,generationMode,generateAudio};
}

function quoteGateway(model,input={},factor=DEFAULT_VERCEL_CREDITS_PER_USD) {
  const chosen=selection(model,input),p=model.pricing||{},override=model.priceOverride;
  let sourceUsd=null,isEstimate=false;
  if (model.mediaType==='image') {
    const [w,h]=imageDimensions(model,chosen).split('x').map(Number);
    const area=w*h/(1024*1024);
    if (override) {
      const rate=override[chosen.quality]||override.perImage;
      // Admin image rates are a square 1024px estimate; non-square pixel area
      // is applied explicitly, independently for each quality.
      if (positive(rate)) {sourceUsd=Number(rate)*area;isEstimate=true;}
    } else {
      const catalogTiers=p.image_dimension_quality_pricing||[];
      const tiers=catalogTiers.length||positive(p.image)?catalogTiers:publishedImageTiers(model.providerModelId);
      const matches=tiers.filter(t=>
        (!t.size||t.size==='default'||t.size===chosen.imageSize||t.size===w+'x'+h)&&
        (!t.quality||t.quality===chosen.quality)&&!t.style&&!t.operation);
      const ranked=matches.sort((a,b)=>(Number(Boolean(b.size&&b.size!=='default'))+Number(Boolean(b.quality)))-(Number(Boolean(a.size&&a.size!=='default'))+Number(Boolean(a.quality))));
      const cost=ranked[0]?.cost??p.image;
      if (positive(cost)) sourceUsd=Number(cost);
    }
    // Token-based models have additional variable input charges. Their base
    // image quote is an estimate, not an invented conversion of output tokens.
    if (positive(p.input)) isEstimate=true;
  } else if (override?.perSecond) {sourceUsd=Number(override.perSecond)*chosen.duration;isEstimate=true;}
  else {
    const matches=(p.video_duration_pricing||[]).filter(t=>
      (!t.resolution||t.resolution===chosen.resolution)&&(!t.mode||t.mode===chosen.generationMode)&&
      (t.audio===undefined||t.audio===chosen.generateAudio)&&!t.voice_control&&positive(t.cost_per_second));
    const exact=matches.filter(t=>t.resolution===chosen.resolution);
    const applicable=exact.length?exact:matches;
    if (applicable.length) sourceUsd=Math.max(...applicable.map(t=>Number(t.cost_per_second)))*chosen.duration;
    // Video token floors and input duration are not fully exposed by the public
    // catalog. Require an Admin per-second rate rather than silently underquote.
  }
  if (!positive(sourceUsd)) fail('Set a USD price for this model in Admin before enabling generation.');
  if (!positive(factor)||Number(factor)>1000000) fail('The source credit conversion is invalid.');
  const raw=sourceUsd*Number(factor),cost=Math.ceil(raw-Number.EPSILON*Math.abs(raw)*4);
  if (!positive(cost)||cost>999999999) fail('The generation credit price is invalid.');
  return {cost,sourceUsd,isEstimate,...chosen};
}

// Recraft accepts only fixed sizes per aspect ratio (Recraft API appendix);
// any other WxH is rejected with HTTP 400. V4 Pro sizes are exactly double V4.
const RECRAFT_V3_SIZES={'1:1':'1024x1024','2:1':'2048x1024','1:2':'1024x2048','3:2':'1536x1024','2:3':'1024x1536',
  '4:3':'1365x1024','3:4':'1024x1365','5:4':'1280x1024','4:5':'1024x1280','16:9':'1820x1024','9:16':'1024x1820'};
const RECRAFT_V4_SIZES={'1:1':'1024x1024','2:1':'1536x768','1:2':'768x1536','3:2':'1280x832','2:3':'832x1280',
  '4:3':'1216x896','3:4':'896x1216','5:4':'1152x896','4:5':'896x1152','16:9':'1344x768','9:16':'768x1344'};
function recraftSize(id,ratio) {
  if (/recraft-v[23]\b/.test(id)) return RECRAFT_V3_SIZES[ratio];
  const base=RECRAFT_V4_SIZES[ratio];
  if (!base||!/-pro\b/.test(id)) return base;
  return base.split('x').map(n=>Number(n)*2).join('x');
}

function imageDimensions(model,chosen) {
  if (chosen.imageSize&&/^\d+x\d+$/.test(chosen.imageSize))
    return FLUX3_SHAPES[model.providerModelId]?classDimensions(chosen.imageSize,chosen.aspectRatio):chosen.imageSize;
  if (model.providerModelId?.startsWith('openai/')) return SMART_IMAGE_SIZES[chosen.aspectRatio];
  if (model.providerModelId?.startsWith('recraft/')) {
    const size=recraftSize(model.providerModelId,chosen.aspectRatio);
    if (!size) fail('This aspect ratio is not available for this Recraft model.');
    return size;
  }
  const [a,b]=chosen.aspectRatio.split(':').map(Number);
  let long=chosen.imageSize==='4K'?4096:chosen.imageSize==='2K'?2048:chosen.imageSize==='512'?512:1024;
  if(model.providerModelId?.startsWith('bytedance/'))long=Math.round(long*Math.sqrt(Math.max(a,b)/Math.min(a,b))/16)*16;
  return a>=b?long+'x'+Math.round(long*b/a/16)*16:Math.round(long*a/b/16)*16+'x'+long;
}

function videoDimensions(resolution,ratio) {
  const heights={hd:720,fhd:1080,'480p':480,'720p':720,'768p':768,'1080p':1080,'2k':1440,'4k':2160};
  if (/^\d+x\d+$/.test(resolution)) return resolution;
  const short=heights[String(resolution).toLowerCase()];
  if (!short) fail('This video resolution needs a model adapter.');
  const [a,b]=ratio.split(':').map(Number);
  return a>=b?Math.round(short*a/b/2)*2+'x'+short:short+'x'+Math.round(short*b/a/2)*2;
}

function validateReferences(model,input={}) {
  const images=input.images||[],videos=input.videos||[],caps=model.referenceCapabilities;
  const list=value=>{if(value==null||value==='')return [];try{const v=typeof value==='string'?JSON.parse(value):value;if(Array.isArray(v))return v;}catch{}fail('Invalid reference selection.');};
  const reused=list(input.reuseImageIds).length;
  for (const [kind,files,count] of [['image',images,images.length+reused],['video',videos,videos.length]]) {
    const c=caps[kind];
    if (count&&(!c.supported||count>c.max)) fail('Unsupported '+kind+' references or too many files for this model.');
    if (count<c.min) fail('This model requires a reference '+kind+'.');
    for (const file of files) {
      if (!Buffer.isBuffer(file.data)||!file.data.length||file.data.length>c.maxBytes) fail('The reference '+kind+' exceeds this model’s file limit.');
      const format=String(file.mimeType||'').split('/')[1]?.replace('quicktime','mov');
      if (c.formats?.length&&!c.formats.includes(format)&&!(format==='jpeg'&&c.formats.includes('jpg'))) fail('Unsupported reference '+kind+' format for this model.');
    }
  }
  if (images.length+videos.length+reused>caps.totalMax) fail('Too many total reference files for this model.');
  const roles=list(input.referenceOrder).map(r=>r.role);
  const frames=roles.some(r=>r==='start_image'||r==='end_image');
  const refs=roles.some(r=>r==='image_references')||videos.length>0;
  if (frames&&refs) fail('Choose either start/end frames or reference files for this generation.');
  if (model.mediaType==='video'&&!caps.textOnly&&!images.length&&!videos.length&&!reused) fail('This video model requires a reference file.');
}

module.exports={DEFAULT_VERCEL_CREDITS_PER_USD,publishedImageTiers,applyModelFixups,isGatewayModel,publicId,mediaModels,discoverModel,
  normalizePriceOverride,modelReady,selection,quoteGateway,imageDimensions,videoDimensions,validateReferences};

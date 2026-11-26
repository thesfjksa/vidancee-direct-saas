'use strict';

const { CNY_PER_USD } = require('./billing.js');
const BASE_URL = 'https://puream.cn/api/ai/seedance-wan/v1';
const FAMILIES = { seedance20: 'Seedance 2.0', seedance25: 'Seedance 2.5', wan3: 'Wan 3.0' };
const MAX_MEDIA = 50;
const MIB = 1024 * 1024;
const publicId = id => String(id).replace(/-/g, '_');
const isPureamModel = id => /^puream_(?:sd20|sd25|wan3)_[a-f0-9]+$/.test(require('./new_brand.js').storedNewModelId(String(id||'')));
const invalid = message => Object.assign(new Error(message), {statusCode:400});

function pureamMediaModels(catalog) {
  if (!Array.isArray(catalog?.data) || !catalog.data.length || catalog.catalog_sync?.confirmed === false)
    throw new Error('Puream did not return a confirmed model catalog; the existing inventory was preserved.');
  const models = [];
  for (const raw of catalog.data) {
    if (raw?.available !== true || !isPureamModel(publicId(raw.id)) || !FAMILIES[raw.family]) continue;
    const specs = {};
    const pricing = {video_duration_prices:[],video_duration_pricing:[]};
    for (const resolution of raw.resolutions || []) {
      if (!/^(480p|720p|1080p|4k)$/.test(resolution)) continue;
      const durations = [...new Set((raw.durations_by_resolution?.[resolution] || []).filter(n=>Number.isInteger(n)&&n>=1&&n<=30))].sort((a,b)=>a-b);
      const tier = raw.pricing_by_resolution?.[resolution];
      const price = Number(tier?.price_yuan);
      const unit = tier?.billing_unit;
      if (!durations.length || !Number.isFinite(price) || price<=0 || !['successful_video','second'].includes(unit)) continue;
      specs[resolution] = {durations, priceCny:price, unit};
      if (unit==='successful_video') pricing.video_duration_prices.push(...durations.map(duration=>({resolution,duration,cost:price/CNY_PER_USD})));
      else pricing.video_duration_pricing.push({resolution,cost_per_second:price/CNY_PER_USD});
    }
    const resolutions = Object.keys(specs);
    if (!resolutions.length) continue;
    const ratios = (raw.aspect_ratios||[]).filter(r=>['adaptive','16:9','9:16','1:1','4:3','3:4','21:9'].includes(r));
    if (!ratios.length) continue;
    const defaultResolution = resolutions.includes('720p')?'720p':resolutions[0];
    const durations = [...new Set(Object.values(specs).flatMap(s=>s.durations))].sort((a,b)=>a-b);
    const modes = (raw.generation_modes||[]).filter(m=>['reference','first_frame','first_last_frame'].includes(m));
    const limits = raw.reference_limits||{};
    const count = kind => Math.max(0,Math.min(MAX_MEDIA,Math.floor(Number(raw['max_'+kind+'s'])||0)));
    const kind = (name,roles,formats,maxBytes) => ({supported:count(name)>0,max:count(name),min:0,roles:count(name)>0?roles:[],formats,maxBytes});
    const image = kind('image',['image_references'],'jpg jpeg png webp'.split(' '),10*MIB);
    const video = kind('video',['video_references'],['mp4','mov'],25*MIB);
    const audio = kind('audio',['audio_references'],['mp3','wav'],15*MIB);
    if (Number(limits.max_video_seconds_total)>0) video.maxTotalSeconds=Number(limits.max_video_seconds_total);
    if (Number(limits.max_audio_seconds_total)>0) audio.maxTotalSeconds=Number(limits.max_audio_seconds_total);
    const totalMax = Math.min(MAX_MEDIA, Number(limits.max_total_media_files)||image.max+video.max+audio.max);
    models.push({providerModelId:raw.id,publicModelId:publicId(raw.id),label:FAMILIES[raw.family]+' · Puream '+String(raw.name||raw.id).split('·').pop().trim().slice(-6).toUpperCase(),mediaType:'video',options:{
      catalogVerified:true,adapterSupported:true,gatewayType:'video',pricing, durations,resolutions,aspectRatios:ratios,
      defaultResolution,defaultDuration:specs[defaultResolution].durations.at(-1),defaultAspectRatio:ratios.includes('16:9')?'16:9':ratios[0],
      inputLimits:{text:{max_chars:Math.min(20000,Number(raw.max_prompt_characters)||5000)}},
      supportedOperations:[...(raw.requires_reference?[]:['text-to-video']),'reference-to-video'],
      referenceCapabilities:{textOnly:!raw.requires_reference,totalMax,image,video,audio},
      mediaRoles:[...image.roles,...video.roles,...audio.roles],
      modes, defaultMode:modes.includes('reference')?'reference':modes[0]||null,
      puream:{tiers:specs, generationTested:raw.generation_tested===true, audioRequiresVisual:limits.audio_requires_visual===true,
        minAudioSeconds:Number(limits.min_audio_seconds)||0,minVideoSeconds:Number(limits.min_video_seconds)||0,priceCheckedAt:raw.availability_checked_at||catalog.availability_checked_at||null},
    }});
  }
  if (!models.length) throw new Error('No available, priced Puream video models were returned; the existing inventory was preserved.');
  return models;
}

function validatePureamReferences(model, input, {forQuote=false}={}) {
  const images=input.images||[], videos=input.videos||[], audios=input.audios||[];
  let reused=0;
  try { reused=(typeof input.reuseImageIds==='string'?JSON.parse(input.reuseImageIds):input.reuseImageIds||[]).length||0; } catch {}
  const visual=images.length+reused+videos.length;
  if (visual+audios.length>model.referenceCapabilities.totalMax) throw invalid('Too many Puream reference files.');
  if (forQuote) return;
  if (audios.length && model.puream.audioRequiresVisual && !visual) throw invalid('This model requires a visual reference with audio.');
  const mode=input.generationMode||model.defaultMode;
  if (mode==='first_frame'||mode==='first_last_frame') {
    if (images.length+reused!==(mode==='first_frame'?1:2)||videos.length||audios.length) throw invalid('Select the required first or first/last frame images for this mode.');
  }
  const {mp4Seconds}=require('./vercel_models.js');
  const {mp3Seconds,wavSeconds}=require('./wxksai_references.js');
  for (const [kind,files,min] of [['video',videos,model.puream.minVideoSeconds],['audio',audios,model.puream.minAudioSeconds]]) {
    const max=model.referenceCapabilities[kind].maxTotalSeconds;
    if (!files.length||(!max&&!min)) continue;
    const seconds=files.map(file=>kind==='video'?mp4Seconds(file.data):/mpeg|mp3/.test(file.mimeType)?mp3Seconds(file.data):wavSeconds(file.data));
    if (seconds.some(s=>!Number.isFinite(s)||s<=0||s+0.05<min) || (max&&seconds.reduce((a,b)=>a+b,0)>max+0.05)) throw invalid('Puream reference '+kind+' duration is invalid for this model.');
  }
}

module.exports={BASE_URL,pureamMediaModels,isPureamModel,validatePureamReferences};

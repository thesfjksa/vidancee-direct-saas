'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

const studio=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
const head=studio.indexOf('function videoModelGroup(value){');
const tail=studio.indexOf('function rebuildCustomSelect(id){',head);
assert.ok(head>0 && tail>head,'Video Studio model-picker source is present');
const context=vm.createContext({
  escapeHtml:String,
  modelPickerOptionHtml:(_picker,option,index)=>'<button data-index="'+index+'">'+option.textContent+'</button>',
});
vm.runInContext(studio.slice(head,tail),context);

test('Video Studio places MiniMax Beast in the MiniMax dropdown beside H3 variants',()=>{
  const models=[
    {value:'minimax_h3',textContent:'MiniMax H3 Base'},
    {value:'minimax_h3_cinematic',textContent:'MiniMax H3 Cinematic'},
    {value:'minimax_beast',textContent:'Minimax Beast'},
    {value:'dope_seedance_2_0_mini_720p',textContent:'Seedance Mini · Dope'},
  ];
  assert.equal(context.videoModelGroup('minimax_beast'),'MiniMax');
  assert.equal(context.videoModelGroup('minimax_h3_origin'),'MiniMax');
  assert.equal(context.videoModelGroup('dope_seedance_2_0_mini_720p'),null);
  const html=context.videoModelOptionsHtml({options:models,selectedIndex:2});
  const mini=html.match(/<details class="model-picker-group"><summary>MiniMax[\s\S]*?<\/details>/)?.[0];
  assert.ok(mini,'MiniMax collapsible group exists');
  assert.match(mini,/MiniMax H3 Base/);
  assert.match(mini,/MiniMax H3 Cinematic/);
  assert.match(mini,/Minimax Beast/);
  assert.match(mini,/model-picker-count">3<\/span>/);
  assert.ok(!mini.includes('Seedance Mini · Dope'));
});
test('Video Studio groups every restored AIVID offering inside one Premium submenu',()=>{
  const models=[
    {value:'aivid_seedance_2_0_mini',textContent:'Seedance 2.0 (Mini) · Premium'},
    {value:'aivid_seedance_2_0',textContent:'Seedance 2.0 · Premium'},
    {value:'aivid_seedance_2_0_fast',textContent:'Seedance 2.0 (Fast) · Premium'},
    {value:'aivid_seedance_2_5',textContent:'Seedance 2.5 · Premium'},
    {value:'minimax_beast',textContent:'Minimax Beast'},
  ];
  const html=context.videoModelOptionsHtml({options:models,selectedIndex:0});
  const premium=html.match(/<details class="model-picker-group"><summary>Premium[\s\S]*?<\/details>/)?.[0];
  assert.ok(premium);
  assert.match(premium,/model-picker-count">4<\/span>/);
  for(const m of models.slice(0,4)){
    assert.equal(context.videoModelGroup(m.value),'Premium');
    assert.ok(premium.includes(m.textContent),m.value);
  }
  assert.ok(!premium.includes('Minimax Beast'));
});
test('Dope quote failures show a retry action rather than at-submit credits',()=>{
  const start=studio.indexOf('async function updateCost('),end=studio.indexOf('function clearReferenceItems()',start);
  assert.ok(start>0&&end>start);
  const source=studio.slice(start,end);
  assert.match(source,/Price is temporarily unavailable/);
  assert.match(source,/videoPriceRetry/);
  assert.doesNotMatch(source,/'at submit'/);
});
test('required video image references disable Generate until the image is attached',()=>{
  const start=studio.indexOf('function missingRequiredVideoReferences(model){');
  const end=studio.indexOf('async function fetchQuote(body){',start);
  assert.ok(start>0&&end>start);
  const fields={generateBtn:{disabled:false}};
  const state={referenceItems:[],videoReferenceItems:[],audioReferenceItems:[],videoSubmissionInFlight:false,videoReferenceRestoreInFlight:false};
  const ctx=vm.createContext({...state,$:id=>fields[id],
    currentVideoModel:()=>({id:'dope_seedance_2_0_mini_720p',
      capabilities:{
        image:{min:1,requiredRoles:[]},video:{min:0,requiredRoles:[]},audio:{min:0,requiredRoles:[]},
      },
    }),
    premiumPriceFor:()=>null,
  });
  vm.runInContext(studio.slice(start,end),ctx);
  ctx.syncVideoGenerateButton();
  assert.equal(fields.generateBtn.disabled,true);
  ctx.referenceItems.push({role:'image_references'});
  ctx.syncVideoGenerateButton();
  assert.equal(fields.generateBtn.disabled,false);
});

test('video cards show the minimum user credit rate for per-second models',()=>{
  const begin=studio.indexOf('function pickerCreditNumber(');
  const end=studio.indexOf('function modelPickerTags(',begin);
  assert.ok(begin>0&&end>begin);
  const ctx=vm.createContext({config:{pricing:[]},fetchQuote:async()=>({cost:120})});
  vm.runInContext(studio.slice(begin,end),ctx);
  assert.equal(ctx.pickerCreditText({id:'api888_metered',dynamicCost:true,billingMode:'per_second',billingRateCredits:42.25,
    durations:[{seconds:5},{seconds:15}],defaultResolution:'720p'}),
    'Per second · Min 42.25 credits/sec · 5–15s · 720p');
  assert.equal(ctx.pickerCreditText({id:'api888_per_request',dynamicCost:true,billingMode:'per_request',billingRateCredits:360,
    durations:[{seconds:5},{seconds:30}],defaultResolution:'720p'}),
    'Constant price · 360 credits · Up to 30s · 720p');
  assert.equal(ctx.pickerCreditText({id:'minimax_h3',dynamicCost:false,
    resolutions:[{id:'480p',durations:[{seconds:4,cost:20},{seconds:10,cost:40}]}]}),
    'Per second · Min 4 credits/sec · From 20 credits · 4s · 480p');
  assert.equal(ctx.pickerCreditText({id:'flat',dynamicCost:false,
    durations:[{seconds:5,cost:60},{seconds:10,cost:60}]}),
    'Constant price · 60 credits · Up to 10s · Default resolution');
  assert.equal(ctx.pickerCreditText({id:'dynamic',dynamicCost:true,durations:[{seconds:5,cost:null}]}),
    'Price · Checking credits…');
});
test('model picker dynamic estimates use existing quote API and shortest allowed duration',async()=>{
  const begin=studio.indexOf('function pickerCreditNumber(');
  const end=studio.indexOf('function modelPickerTags(',begin);
  let submitted=null;
  const ctx=vm.createContext({config:{pricing:[]},fetchQuote:async body=>{submitted=body;return {cost:1344};}});
  vm.runInContext(studio.slice(begin,end),ctx);
  const model={id:'dope_seedance_2_0_mini_720p',dynamicCost:true,defaultResolution:'720p',
    defaultAspectRatio:'16:9',resolutions:[{id:'720p',durations:[{seconds:15},{seconds:5},{seconds:10}]}]};
  const quote=await ctx.pickerQuote(model);
  assert.equal([quote.badge,quote.amount,quote.detail].join(' · '),
    'Sample price · 1,344 credits · 5s · 720p');
  assert.equal(submitted.model,model.id);
  assert.equal(submitted.duration,5);
  assert.equal(submitted.mediaType,'video');
  assert.equal(submitted.generateAudio,false);
  assert.match(studio,/if\(id==='model'\)watchPickerQuotes\(\)/);
  assert.match(studio,/class="model-picker-price"/);
  assert.match(studio,/model-picker-price-badge/);
});

test('Dope second-priced and generic gateway second-priced SKUs expose billing mode',()=>{
  const {publicVideoModel}=require('../src/provider_models.js');
  const defaults={publicModelId:'wxksai_wan3_0',label:'Wan 3.0 · Dope',provider:'wxksai',
    resolutions:['720p'],durations:[5,10],defaultResolution:'720p',defaultDuration:5,
    aspectRatios:['16:9'],referenceCapabilities:{}};
  assert.equal(publicVideoModel({...defaults,wxksai:{pricingMode:'second'}}).billingMode,'per_second');
  const flatModel={...defaults,wxksai:{pricingMode:'clip'},
    pricing:{video_duration_prices:[{duration:5,cost:0.2},{duration:10,cost:0.2}]}};
  assert.equal(publicVideoModel(flatModel).billingMode,'per_request');
  // Different length-specific costs must never be called constant.
  assert.equal(publicVideoModel({...flatModel,
    pricing:{video_duration_prices:[{duration:5,cost:0.2},{duration:10,cost:0.4}]}}).billingMode,undefined);
  assert.equal(publicVideoModel({...defaults,provider:'argolink',publicModelId:'argo_test',
    pricing:{video_duration_pricing:[{resolution:'720p',cost_per_second:0.07}]}}).billingMode,'per_second');
});
test('metered models quote each resolution and display their cheapest per-second credits',async()=>{
  const begin=studio.indexOf('function pickerCreditNumber(');
  const end=studio.indexOf('function modelPickerTags(',begin);
  const requests=[];
  const ctx=vm.createContext({config:{pricing:[]},fetchQuote:async b=>{
    requests.push(b);
    return {cost:b.resolution==='480p'?100:175};
  }});
  vm.runInContext(studio.slice(begin,end),ctx);
  const model={id:'dope_seedance_2_5_buff',billingMode:'per_second',dynamicCost:true,
    defaultResolution:'720p',defaultAspectRatio:'16:9',resolutions:[
      {id:'480p',durations:[{seconds:10},{seconds:5}]},
      {id:'720p',durations:[{seconds:5},{seconds:10}]},
    ]};
  const quote=await ctx.pickerQuote(model);
  assert.equal([quote.badge,quote.amount,quote.detail].join(' · '),
    'Per second · Min 20 credits/sec · From 100 credits · 5s · 480p');
  assert.equal(requests.length,2);
  assert.ok(requests.every(r=>r.mediaType==='video'&&r.duration===5));
});

test('Dope flat per-clip model shows constant price with maximum duration in credits',async()=>{
  const begin=studio.indexOf('function pickerCreditNumber(');
  const end=studio.indexOf('function modelPickerTags(',begin);
  const requests=[];
  const ctx=vm.createContext({config:{pricing:[]},fetchQuote:async b=>{
    requests.push(b);
    return {cost:4939.2};
  },escapeHtml:String});
  vm.runInContext(studio.slice(begin,end),ctx);
  const model={id:'dope_seedance_2_5_bd_2',billingMode:'per_request',
    dynamicCost:true,defaultResolution:'720p',defaultAspectRatio:'16:9',
    resolutions:[{id:'720p',durations:Array.from({length:27},(_,i)=>({seconds:i+4}))}]};
  const result=await ctx.pickerQuote(model);
  assert.equal([result.badge,result.amount,result.detail].join(' · '),
    'Constant price · 4,939.2 credits · Up to 30s · 720p');
  assert.deepEqual(requests.map(x=>x.duration),[4,30]);
  const markup=ctx.pickerCreditMarkup(result);
  assert.match(markup,/model-picker-price-badge constant/);
  assert.match(markup,/Up to 30s/);
  assert.match(markup,/4,939.2 credits/);
});
test('flat-price label is withheld when extreme durations have different costs',async()=>{
  const begin=studio.indexOf('function pickerCreditNumber(');
  const end=studio.indexOf('function modelPickerTags(',begin);
  const ctx=vm.createContext({config:{pricing:[]},fetchQuote:async b=>({cost:b.duration===5?100:200})});
  vm.runInContext(studio.slice(begin,end),ctx);
  const result=await ctx.pickerQuote({id:'variable',billingMode:'per_request',dynamicCost:true,
    defaultResolution:'1080p',durations:[{seconds:5},{seconds:10},{seconds:15}]});
  assert.equal(result.badge,'Duration-based');
  assert.equal(result.amount,'From 100 credits');
  assert.equal(result.detail,'5–15s · 1080p');
});
test('single-duration fixed-price model is labeled fixed, not multiple-duration constant',()=>{
  const begin=studio.indexOf('function pickerCreditNumber(');
  const end=studio.indexOf('function modelPickerTags(',begin);
  const ctx=vm.createContext({config:{pricing:[]}});
  vm.runInContext(studio.slice(begin,end),ctx);
  const label=ctx.pickerCreditText({id:'one_duration',dynamicCost:false,
    defaultResolution:'720p',durations:[{seconds:10,cost:2116.8}]});
  assert.equal(label,'Fixed price · 2,116.8 credits · 10s · 720p');
});

test('redesigned video cards show credits first, billing type second and compact capability metadata',()=>{
  const from=studio.indexOf('function pickerCreditNumber(');
  const to=studio.indexOf('function ensureCustomSelect(',from);
  assert.ok(from>0&&to>from);
  const model={id:'dope_seedance_2_5_bd_2',billingMode:'per_request',dynamicCost:false,
    defaultResolution:'720p',resolutions:[{id:'720p',durations:[{seconds:4,cost:4939.2},{seconds:30,cost:4939.2}]}]};
  const ctx=vm.createContext({
    config:{pricing:[model]},fetchQuote:async()=>({cost:4939.2}),
    escapeHtml:String,modelPickerSource:(id,i)=>id==='model'&&i===0?model:null,
    normalizedClientCapabilities:()=>({
      image:{supported:true},video:{supported:true},audio:{supported:true},
    }),
  });
  vm.runInContext(studio.slice(from,to),ctx);
  assert.equal(ctx.modelPickerTags('model',0).length,0,
    'do not duplicate resolution or duration tags already shown below the price');
  const markup=ctx.modelPickerOptionHtml('model',{textContent:'Seedance 2.5 BD2 Full · Dope'},0,true);
  assert.ok(markup.indexOf('model-picker-price-value')<markup.indexOf('model-picker-price-badge'),
    'price is visually and structurally ahead of the billing-type badge');
  assert.match(markup,/4,939.2 credits/);
  assert.match(markup,/Constant price/);
  assert.match(markup,/Up to 30s/);
  assert.match(markup,/720p/);
  assert.match(markup,/Image \+ Video \+ Audio refs/);
  assert.doesNotMatch(markup,/model-picker-tags/);
  assert.match(markup,/role="option" aria-selected="true"/);
});
test('async price refresh keeps reference support metadata in the updated card',()=>{
  const markup=studio.slice(studio.indexOf('function pumpPickerQuotes(){'),
    studio.indexOf('function watchPickerQuotes(){'));
  assert.match(markup,/pickerCreditMarkup\(summary,task\.model\)/);
  assert.doesNotMatch(markup,/price\.textContent=label/);
  const css=fs.readFileSync(require.resolve('../public/studio.css'),'utf8');
  assert.match(css,/\.model-picker-price-main\s*\{/);
  assert.match(css,/\.model-picker-meta-dot\s*\{/);
  assert.match(css,/\.custom-select\.model-picker \.custom-select-option:focus-visible/);
  assert.match(css,/\.model-picker-price-value\s*\{[\s\S]*?font-size:\s*14\.5px/);
  assert.match(css,/grid-template-columns:\s*34px minmax\(0,1fr\) 20px/);
});

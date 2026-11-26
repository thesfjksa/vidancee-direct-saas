'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

const studio=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
test('Video Studio renders MiniMax and Dope together in a flat model list',()=>{
  const start=studio.indexOf('function rebuildCustomSelect(id){');
  const end=studio.indexOf('function syncCustomSelect(id){',start);
  assert.ok(start>0&&end>start);
  const models=[
    {value:'minimax_h3',textContent:'MiniMax H3 Base'},
    {value:'minimax_h3_cinematic',textContent:'MiniMax H3 Cinematic'},
    {value:'minimax_beast',textContent:'Minimax Beast'},
    {value:'dope_seedance_2_0_mini_720p',textContent:'Seedance Mini · Dope'},
  ];
  let markup='',sorted=false;
  const options={
    querySelector:()=>null,
    querySelectorAll:()=>[],
    insertAdjacentHTML:(_position,html)=>{markup=html;},
  };
  const menu={querySelector:selector=>selector.includes('.model-picker-options')?options:null};
  const wrap={querySelector:selector=>selector==='.custom-select-menu'?menu:null,classList:{toggle(){}}};
  const select={options:models,selectedIndex:2,closest:()=>wrap};
  const ctx=vm.createContext({
    $:()=>select,customSelectSearchable:id=>id==='model',syncCustomSelect(){},
    modelPickerOptionHtml:(_id,model,index,selected)=>'<button data-index="'+index+'" aria-selected="'+selected+'">'+model.textContent+'</button>',
    sortDopePerformanceOptions:root=>{assert.equal(root,options);sorted=true;},
  });
  vm.runInContext(studio.slice(start,end),ctx);
  ctx.rebuildCustomSelect('model');
  assert.equal((markup.match(/<button /g)||[]).length,models.length);
  assert.doesNotMatch(markup,/<details|<summary/);
  for(const model of models)assert.ok(markup.includes(model.textContent));
  assert.match(markup,/data-index="2" aria-selected="true">Minimax Beast/);
  assert.equal(sorted,true,'The flat list still uses the performance sorter');
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
  const end=studio.indexOf('async function fetchQuote(body,',start);
  assert.ok(start>0&&end>start);
  const fields={generateBtn:{disabled:false}};
  const state={referenceItems:[],videoReferenceItems:[],audioReferenceItems:[],videoSubmissionInFlight:false,videoReferenceRestoreInFlight:false};
  const ctx=vm.createContext({...state,$:id=>fields[id],
    currentVideoModel:()=>({id:'dope_seedance_2_0_mini_720p',
      capabilities:{
        image:{min:1,requiredRoles:[]},video:{min:0,requiredRoles:[]},audio:{min:0,requiredRoles:[]},
      },
    }),
    reviewedVideoPriceRequired:()=>false,reviewedVideoPriceFor:()=>null,
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

test('long video selection requires a successful price review and stale quotes cannot unlock Generate',async()=>{
  const fields={};
  for(const id of ['duration','resolution','resolutionControl','ratio','videoModeControl','videoGenerationMode','videoGenerateAudio','model','prompt','cost','generateBtn','videoPriceNote','videoPriceRetry']){
    fields[id]={value:'',textContent:'',disabled:false,classList:{add(){},remove(){},toggle(){},contains(){return false;}}};
  }
  fields.model.value='minimax_h3';
  fields.duration.value='30';
  fields.duration.selectedIndex=0;
  fields.duration.options=[{dataset:{cost:'608'}}];
  fields.resolution.value='768p';fields.ratio.value='16:9';
  const model={id:'minimax_h3',longVideoMinDuration:16,capabilities:{}};
  let finish,quoteBody;
  const ctx=vm.createContext({
    $:id=>fields[id],config:{pricing:[model]},currentVideoModel:()=>model,
    videoCostRequestSeq:0,referenceItems:[],videoReferenceItems:[],audioReferenceItems:[],
    videoSubmissionInFlight:false,videoReferenceRestoreInFlight:false,
    syncCustomSelect(){},fetchQuote:body=>{quoteBody=body;return new Promise(resolve=>{finish=resolve;});},
  });
  const start=studio.indexOf('let reviewedVideoQuote=null;');
  const end=studio.indexOf('async function fetchQuote(body,',start);
  assert.ok(start>=0&&end>start);
  vm.runInContext(studio.slice(start,end),ctx);
  vm.runInContext(studio.slice(studio.indexOf('async function updateCost('),studio.indexOf('function clearReferenceItems()')),ctx);
  const first=ctx.updateCost();
  assert.equal(fields.generateBtn.disabled,true);
  assert.equal(quoteBody.duration,30);
  assert.equal(fields.cost.textContent,'…');
  finish({cost:731.85,isEstimate:false});
  await first;
  assert.equal(fields.cost.textContent,731.85);
  assert.equal(fields.generateBtn.disabled,false);
  assert.equal(ctx.reviewedVideoPriceFor(model),731.85);
  fields.duration.value='29';
  const second=ctx.updateCost();
  assert.equal(fields.generateBtn.disabled,true);
  fields.duration.value='15';fields.duration.options=[{dataset:{cost:'318.15'}}];
  await ctx.updateCost();
  finish({cost:700,isEstimate:false});
  await second;
  assert.equal(fields.cost.textContent,'318.15');
  assert.equal(fields.generateBtn.disabled,false);
});

test('Cartoon Studio shows a live 30-second price and disables generation while the quote is pending',async()=>{
  const fields={};
  for(const id of ['cartoonDuration','cartoonModel','cartoonRatio','cartoonGenerateBtn','cartoonPriceNote','cartoonPriceRetry','cartoonCost']){
    fields[id]={value:'',textContent:'',disabled:false,classList:{add(){},remove(){},toggle(){}}};
  }
  fields.cartoonModel.value='minimax_h3_cinematic';
  fields.cartoonRatio.value='9:16';
  fields.cartoonDuration.selectedIndex=0;
  fields.cartoonDuration.options=[{value:'30',dataset:{cost:'600'}}];
  const model={id:'minimax_h3_cinematic',longVideoMinDuration:16,defaultResolution:'768p'};
  let finish,request;
  const ctx=vm.createContext({$:id=>fields[id],config:{cartoon:{pricing:[model]}},
    cartoonQuoteSeq:0,cartoonLongPrice:null,cartoonSubmitting:false,cartoonImageFile:null,
    syncCustomSelect(){},fetchQuote:(body)=>{request=body;return new Promise(resolve=>{finish=resolve;});}});
  const a=studio.indexOf('async function updateCartoonCost(){'),b=studio.indexOf('function setCartoonImage(',a);
  assert.ok(a>=0&&b>a);
  vm.runInContext(studio.slice(a,b),ctx);
  const pending=ctx.updateCartoonCost();
  assert.equal(fields.cartoonGenerateBtn.disabled,true);
  assert.equal(request.duration,30);
  finish({cost:620.55});
  await pending;
  assert.equal(ctx.cartoonLongPrice,620.55);
  assert.equal(fields.cartoonCost.textContent,620.55);
  assert.equal(fields.cartoonGenerateBtn.disabled,false);
});

test('Puream models appear exclusively in the expandable New menu with original option indices',()=>{
  const start=studio.indexOf('function rebuildCustomSelect(id){');
  const end=studio.indexOf('function syncCustomSelect(id){',start);
  const models=[
    {value:'minimax_h3',textContent:'MiniMax'},
    {value:'puream_sd25_abcdef123456',textContent:'Custom admin name'},
    {value:'dope_seedance_2_0_mini_720p',textContent:'Dope'},
    {value:'puream_sd20_123456abcdef',textContent:'Seedance 2.0'},
    {value:'puream_wan3_abcdef654321',textContent:'Wan 3.0'},
  ];
  let markup='',sorted=false;
  const options={querySelector:()=>null,querySelectorAll:()=>[],insertAdjacentHTML:(_p,html)=>{markup=html;}};
  const menu={querySelector:selector=>selector.includes('.model-picker-options')?options:null};
  const wrap={querySelector:selector=>selector==='.custom-select-menu'?menu:null,classList:{toggle(){}}};
  const select={options:models,selectedIndex:0,closest:()=>wrap};
  const ctx=vm.createContext({
    $:()=>select,customSelectSearchable:()=>true,syncCustomSelect(){},
    modelPickerOptionHtml:(_id,model,index,selected)=>'<button data-index="'+index+'" aria-selected="'+selected+'">'+model.textContent+'</button>',
    sortDopePerformanceOptions(){sorted=true;},
  });
  vm.runInContext(studio.slice(start,end),ctx);
  ctx.rebuildCustomSelect('model');
  assert.match(markup,/^<details class="model-picker-new-group">/);
  assert.match(markup,/<span class="model-picker-group-name">New<\/span>/);
  assert.match(markup,/3 models/);
  const [group,flat]=markup.split('</details>');
  assert.deepEqual([...group.matchAll(/data-index="(\d+)"/g)].map(m=>Number(m[1])),[1,3,4]);
  assert.deepEqual([...flat.matchAll(/data-index="(\d+)"/g)].map(m=>Number(m[1])),[0,2]);
  assert.equal(sorted,true);
  select.selectedIndex=3;ctx.rebuildCustomSelect('model');
  assert.match(markup,/^<details class="model-picker-new-group" open>/);
  assert.match(markup,/data-index="3" aria-selected="true"/);
  ctx.rebuildCustomSelect('imageModel');
  assert.doesNotMatch(markup,/<details/,'Only Video Studio gets the Puream submenu');
});

test('search expands New, hides nonmatching models, restores collapse and supports searching the submenu name',()=>{
  const start=studio.indexOf('function filterCustomSelectOptions(');
  const end=studio.indexOf('function modelPickerSource(',start);
  const items=['MiniMax','Seedance 2.5','Wan 3.0'].map(textContent=>({textContent,style:{display:''}}));
  const count={textContent:''};
  const group={open:false,hidden:false,dataset:{},contains:item=>items.indexOf(item)>0,querySelector:()=>count};
  let emptyShown=false;
  const wrap={querySelector:s=>s==='.model-picker-new-group'?group:{classList:{toggle:(_s,active)=>{emptyShown=active;}}},
    querySelectorAll:()=>items};
  const ctx=vm.createContext({});vm.runInContext(studio.slice(start,end),ctx);
  ctx.filterCustomSelectOptions(wrap,'Wan');
  assert.equal(group.open,true);assert.equal(group.hidden,false);assert.equal(count.textContent,'1 model');
  assert.deepEqual(items.map(x=>x.style.display),['none','none','']);
  ctx.filterCustomSelectOptions(wrap,'New');
  assert.equal(count.textContent,'2 models');
  assert.deepEqual(items.map(x=>x.style.display),['none','','']);
  ctx.filterCustomSelectOptions(wrap,'missing');
  assert.equal(group.hidden,true);assert.equal(emptyShown,true);
  ctx.filterCustomSelectOptions(wrap,'');
  assert.equal(group.open,false);assert.equal(group.hidden,false);assert.equal(emptyShown,false);
  assert.deepEqual(items.map(x=>x.style.display),['','','']);
});

test('performance sorting preserves the New submenu and ranks nested options without flattening them',()=>{
  const perf=fs.readFileSync(require.resolve('../public/dope-performance.js'),'utf8');
  const start=perf.indexOf('  function sortOptions(root)');
  const end=perf.indexOf('  async function refresh(',start);
  const option=(index,id)=>({dataset:{index:String(index)},matches:s=>s==='.custom-select-option',
    querySelector:()=>({dataset:{dopePerformance:id}})});
  const section=(children)=>({children,contains:()=>false,insertBefore(node,before){
    this.children.splice(this.children.indexOf(node),1);this.children.splice(this.children.indexOf(before),0,node);
  }});
  const pureamA=option(1,'puream_a'),pureamB=option(3,'puream_b'),normalA=option(0,'normal_a'),normalB=option(2,'normal_b');
  const nested=section([pureamA,pureamB]);
  const group={matches:s=>s==='.model-picker-new-group',querySelector:()=>nested};
  const empty={matches:()=>false};
  const root=section([group,normalA,normalB,empty]);
  const metrics={puream_a:{successRate:50,averageLatencyMs:1000},puream_b:{successRate:100,averageLatencyMs:500},
    normal_a:{successRate:0,averageLatencyMs:100},normal_b:{successRate:80,averageLatencyMs:2000}};
  const ctx=vm.createContext({metricsFor:id=>metrics[id],document:{activeElement:null}});
  vm.runInContext(perf.slice(start,end),ctx);ctx.sortOptions(root);
  assert.deepEqual(root.children,[group,normalB,normalA,empty]);
  assert.deepEqual(nested.children,[pureamB,pureamA]);
});

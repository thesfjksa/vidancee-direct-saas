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
  assert.equal(ctx.pickerCreditText({id:'api888_metered',dynamicCost:true,billingMode:'per_second',billingRateCredits:42.25}),
    'Min 42.25 credits/sec');
  assert.equal(ctx.pickerCreditText({id:'api888_per_request',dynamicCost:true,billingMode:'per_request',billingRateCredits:360}),
    'From 360 credits');
  assert.equal(ctx.pickerCreditText({id:'minimax_h3',dynamicCost:false,
    resolutions:[{id:'480p',durations:[{seconds:4,cost:20},{seconds:10,cost:40}]}]}),
    'Min 4 credits/sec · 20 credits min clip');
  assert.equal(ctx.pickerCreditText({id:'flat',dynamicCost:false,
    durations:[{seconds:5,cost:60},{seconds:10,cost:60}]}),'From 60 credits');
  assert.equal(ctx.pickerCreditText({id:'dynamic',dynamicCost:true,durations:[{seconds:5,cost:null}]}),
    'Checking credits…');
});
test('model picker dynamic estimates use existing quote API and shortest allowed duration',async()=>{
  const begin=studio.indexOf('function pickerCreditNumber(');
  const end=studio.indexOf('function modelPickerTags(',begin);
  let submitted=null;
  const ctx=vm.createContext({config:{pricing:[]},fetchQuote:async body=>{submitted=body;return {cost:1344};}});
  vm.runInContext(studio.slice(begin,end),ctx);
  const model={id:'dope_seedance_2_0_mini_720p',dynamicCost:true,defaultResolution:'720p',
    defaultAspectRatio:'16:9',resolutions:[{id:'720p',durations:[{seconds:15},{seconds:5},{seconds:10}]}]};
  assert.equal(await ctx.pickerQuote(model),'1,344 credits · 5s · 720p');
  assert.equal(submitted.model,model.id);
  assert.equal(submitted.duration,5);
  assert.equal(submitted.mediaType,'video');
  assert.equal(submitted.generateAudio,false);
  assert.match(studio,/if\(id==='model'\)watchPickerQuotes\(\)/);
  assert.match(studio,/class="model-picker-price"/);
});

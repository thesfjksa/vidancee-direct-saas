'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
const start=html.indexOf('let videoSubmissionInFlight=false;'),end=html.indexOf('\n}',html.indexOf('async function createGeneration(){',start))+2;
const source=html.slice(start,end);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const enhance=deferred(),upload=deferred(),post=deferred(),forms=[];
 const fields=Object.fromEntries(['generateBtn','genMsg','prompt','cost','model','duration','resolution','ratio','videoGenerationMode','videoGenerateAudio','resolutionControl','videoModeControl'].map(id=>[id,{value:'',textContent:'',disabled:false,setAttribute(){},removeAttribute(){},classList:{contains:()=>id==='videoModeControl'}}]));
 Object.assign(fields.model,{value:'aivid_seedance_2_0_mini'});fields.duration.value='5';fields.resolution.value='480p';fields.ratio.value='16:9';fields.prompt.value='A river';fields.cost.textContent='100';
 const ctx={console,Map,Number,JSON,FormData:class{constructor(){this.parts=[]}append(...v){this.parts.push(v)}},$:id=>fields[id],referenceItems:[],videoReferenceItems:[],audioReferenceItems:[],reusedReferenceGenerationId:null,
  validateClientReferenceSelection(){},prepareGenerationPrompt:async()=>{await enhance.promise;return fields.prompt.value},uploadReferencesDirect:async()=>upload.promise,
  postFormWithProgress:async(path,form)=>{forms.push(form);await post.promise;return{user:{},generation:{}}},currentVideoModel:()=>({unavailable:ctx.unavailable}),syncUser(){},showReferenceNotices(){},
  sameItems:(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]),clearReferenceItems(){},clearVideoReferenceItems(){},clearAudioReferenceItems(){},updatePromptCounts(){},
  enhancedPromptCache:{},pendingEnhancementRequests:{},loadGenerations:async()=>{},loadDashboard:async()=>{},loadCredits:async()=>{}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 return{ctx,fields,enhance,upload,post,forms,run:()=>vm.runInContext('createGeneration()',ctx)};
}
test('model changes cannot unlock a second submission or silently change the first request',async()=>{
 const f=fixture(),first=f.run();f.fields.generateBtn.disabled=false;f.fields.model.value='aivid_seedance_2_5';await f.run();
 f.enhance.resolve();await first;assert.equal(f.forms.length,0);assert.match(f.fields.genMsg.textContent,/changed during submission/);assert.equal(f.fields.prompt.value,'A river');
});
test('reference edits during upload stop before generation is posted and preserve the edits',async()=>{
 const f=fixture();f.ctx.videoReferenceItems=[{key:'v1',role:'video_references',file:{},filename:'one.mp4'}];
 const running=f.run();f.enhance.resolve();await flush();f.ctx.videoReferenceItems.push({key:'v2',role:'video_references',file:{},filename:'two.mp4'});
 f.upload.resolve(null);await running;assert.equal(f.forms.length,0);assert.equal(f.ctx.videoReferenceItems.length,2);assert.match(f.fields.genMsg.textContent,/changed during submission/);
});
test('unchanged submission posts once with a customer price ceiling and preserves later prompt edits',async()=>{
 const f=fixture(),running=f.run();f.enhance.resolve();f.upload.resolve(null);await flush();
 assert.equal(f.forms.length,1);assert.ok(f.forms[0].parts.some(([k,v])=>k==='maxCustomerCredits'&&v==='100'));
 f.fields.prompt.value='My next idea';f.fields.generateBtn.disabled=false;await f.run();assert.equal(f.forms.length,1);
 f.ctx.unavailable=true;f.post.resolve();await running;assert.equal(f.fields.prompt.value,'My next idea');assert.equal(f.fields.generateBtn.disabled,true);
});
test('Premium submission without a displayed price cannot post a generation',async()=>{
 const f=fixture();f.fields.cost.textContent='…';await f.run();assert.equal(f.forms.length,0);assert.match(f.fields.genMsg.textContent,/current Premium price/);
});
test('dynamic quotes expire and refresh instead of retaining stale Premium prices forever',async()=>{
 const a=html.indexOf('const quoteCache=new Map();'),b=html.indexOf('\nasync function updateCost',a);let clock=0,calls=0;
 const ctx={Map,JSON,String,Number,Date:{now:()=>clock},AbortSignal:{timeout:()=>null},api:async()=>({cost:++calls,isEstimate:false})};vm.createContext(ctx);vm.runInContext(html.slice(a,b),ctx);
 const get=()=>vm.runInContext("fetchQuote({model:'aivid_seedance_2_0_mini',duration:5})",ctx);
 assert.equal((await get()).cost,1);assert.equal((await get()).cost,1);clock=16000;assert.equal((await get()).cost,2);assert.equal(calls,2);
});

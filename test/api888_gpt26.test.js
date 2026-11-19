'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {api888MediaModels,api888ImageSize,quoteApi888}=require('../src/api888_models');
const {Api888Client}=require('../src/provider/api888');
const {DEFAULT_IMAGE_MODEL,previewTierQuotes}=require('../src/story_tiers');
function png(w,h){
 const crc=b=>{let c=0xffffffff;for(const n of b){c^=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
 const chunk=(name,payload)=>{const data=Buffer.concat([Buffer.from(name),payload]),header=Buffer.alloc(4),footer=Buffer.alloc(4);header.writeUInt32BE(payload.length);footer.writeUInt32BE(crc(data));return Buffer.concat([header,data,footer]);};
 const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',zlib.deflateSync(Buffer.alloc((w*3+1)*h),{level:1})),chunk('IEND',Buffer.alloc(0))]);
}
const record=()=>api888MediaModels({data:[{id:'gpt-image-2.6'}]})[0];
const model=()=>({...record().options,provider:'api888',providerModelId:'gpt-image-2.6',mediaType:'image'});
test('GPT 2.6 has an exact offered image contract and CNY 0.036 per-image quote',()=>{
 const r=record(),m=model();assert.equal(r.publicModelId,'api888_gpt_image_2_6');assert.equal(r.mediaType,'image');assert.equal(m.adapterSupported,true);
 assert.equal(m.api888.sourceCny,0.036);assert.equal(m.api888.billing,'image');assert.equal(quoteApi888(m,{aspectRatio:'1:1'}).sourceCny,0.036);
 assert.deepEqual(m.aspectRatios,['1:1','16:9','9:16','4:3','3:4']);
 assert.equal(m.referenceCapabilities.image.max,0,'this adapter creates character references from text, not edits');
});
test('all five GPT 2.6 1K presets use the exact model ID with one image POST',async()=>{
 const sizes={'1:1':'1254x1254','16:9':'1672x941','9:16':'941x1672','4:3':'1448x1086','3:4':'1086x1448'};
 for(const [aspectRatio,size] of Object.entries(sizes)){
  let calls=0;const [w,h]=size.split('x').map(Number),data=png(w,h);
  const client=new Api888Client({apiKey:'test-key',fetchImpl:async(url,options)=>{
   calls++;assert.equal(url,'https://888api.xin/v1/images/generations');assert.equal(options.method,'POST');
   assert.deepEqual(JSON.parse(options.body),{model:'gpt-image-2.6',prompt:'A character in a navy coat',n:1,size,response_format:'url'});
   return Response.json({data:[{b64_json:data.toString('base64')}]});
  }});
  assert.equal(api888ImageSize('gpt-image-2.6',aspectRatio),size);
  const result=await client.generateImage(model(),{prompt:'A character in a navy coat',aspectRatio});assert.deepEqual(result.data,data);assert.equal(calls,1);
 }
 assert.equal(api888ImageSize('gpt-image-2.6','2:3'),null);
 await assert.rejects(new Api888Client({fetchImpl:()=>{throw Error('No network expected');}}).generateImage(model(),{aspectRatio:'2:3'}),/Unsupported aspect ratio/);
});
test('new stories and their estimates use GPT 2.6 even if the old environment setting remains',async()=>{
 const old=process.env.STORY_IMAGE_MODEL;process.env.STORY_IMAGE_MODEL='api888_gpt_image_2_1k';
 try{assert.equal(require('../src/story_studio').config().imageModel,'api888_gpt_image_2_6');}finally{if(old===undefined)delete process.env.STORY_IMAGE_MODEL;else process.env.STORY_IMAGE_MODEL=old;}
 assert.equal(DEFAULT_IMAGE_MODEL,'api888_gpt_image_2_6');
 const quotes=await previewTierQuotes({getRate:async()=>1.05});
 assert.ok(quotes.every(q=>q.imageModel==='api888_gpt_image_2_6'));assert.equal(quotes[0].breakdown.images,110.25);
 assert.deepEqual(quotes.map(q=>q.credits),[3344.74,4961.98,8196.47]);
 const earlier=api888MediaModels({data:[{id:'gpt-image-2-1k'}]})[0];assert.equal(earlier.options.adapterSupported,true,'historical image jobs are not retired');
});
test('ambiguous GPT 2.6 submission failures never trigger another paid POST',async()=>{
 let calls=0;const client=new Api888Client({apiKey:'test',fetchImpl:async()=>{calls++;throw Error('socket closed');}});
 await assert.rejects(client.generateImage(model(),{prompt:'A character',aspectRatio:'1:1'}));assert.equal(calls,1);
});
test('previously imported GPT 2.6 rows receive the reviewed mapping only while enabled and account-available',()=>{
 const {serializeProviderModel}=require('../src/provider_models');
 const row={id:26,provider:'api888',provider_model_id:'gpt-image-2.6',public_model_id:'api888_gpt_image_2_6',label:'Unmapped',media_type:'image',enabled:1,available:1,options_json:JSON.stringify({adapterSupported:false,api888:{}})};
 const ready=serializeProviderModel(row);assert.equal(ready.ready,true);assert.equal(ready.api888.sourceCny,0.036);assert.equal(ready.label,'GPT Image 2.6 1K');
 for(const flags of [{enabled:0},{available:0}]){const blocked=serializeProviderModel({...row,...flags});assert.equal(blocked.ready,false);assert.equal(blocked.adapterSupported,false);}
 const unknown=serializeProviderModel({...row,provider_model_id:'gpt-image-unknown'});assert.equal(unknown.ready,false);
});

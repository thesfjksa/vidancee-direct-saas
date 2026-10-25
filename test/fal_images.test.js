'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {describeFalImageModel,FalImageClient,publicId,isFalImageModel}=require('../src/fal_images.js');
const {quoteGateway}=require('../src/vercel_models.js');

const entry=(endpoint,props,required=['prompt'])=>({endpoint_id:endpoint,metadata:{display_name:'Test Model Text to Image',status:'active'},openapi:{
  paths:{['/'+endpoint]:{post:{requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Input'}}}}}}},
  components:{schemas:{Input:{properties:{prompt:{type:'string'},...props},required}}}}});
const imageSize={image_size:{anyOf:[{$ref:'#/components/schemas/ImageSize'},{enum:['square_hd','square','portrait_4_3','portrait_16_9','landscape_4_3','landscape_16_9'],type:'string'}]},num_images:{type:'integer'}};

test('a fal text-to-image model maps presets, custom sizes and per-megapixel prices',()=>{
  const m=describeFalImageModel(entry('fal-ai/flux/dev',imageSize),{unit_price:0.025,unit:'megapixels',currency:'USD'});
  assert.equal(m.publicModelId,'fal_fal_ai_flux_dev');
  assert.equal(m.label,'Test Model');
  assert.equal(m.options.adapterSupported,true);
  assert.equal(m.options.falImage.values['16:9'],'landscape_16_9');
  assert.equal(m.options.falImage.values['3:2'],'custom');
  const model={...m.options,providerModelId:m.providerModelId,mediaType:'image'};
  const quote=quoteGateway(model,{aspectRatio:'16:9'},1000);
  assert.equal(quote.sourceUsd,0.025);
  assert.equal(quote.cost,25);
  const client=new FalImageClient({apiKey:'k'});
  assert.deepEqual(client.input(model,{prompt:'P',aspectRatio:'16:9'}),{prompt:'P',image_size:'landscape_16_9',num_images:1});
  assert.deepEqual(client.input(model,{prompt:'P',aspectRatio:'3:2'}).image_size,{width:1024,height:688});
});

test('aspect-ratio models offer only listed ratios; extra inputs, vectors and unknown units stay off',()=>{
  const m=describeFalImageModel(entry('fal-ai/nano-banana-pro',{aspect_ratio:{enum:['1:1','16:9','9:16','auto']}}),{unit_price:0.15,unit:'image',currency:'USD'});
  assert.deepEqual(m.options.aspectRatios,['1:1','16:9','9:16']);
  assert.equal(m.options.adapterSupported,true);
  assert.equal(describeFalImageModel(entry('fal-ai/flux-subject',imageSize,['prompt','image_url']),{unit_price:0.1,unit:'image',currency:'USD'}).options.adapterSupported,false);
  assert.equal(describeFalImageModel(entry('ideogram/vector/text-to-vector',{aspect_ratio:{enum:['1:1']}}),{unit_price:0.1,unit:'image',currency:'USD'}).options.adapterSupported,false);
  assert.equal(describeFalImageModel(entry('fal-ai/sana',imageSize),{unit_price:0.001,unit:'gpu seconds',currency:'USD'}).options.adapterSupported,false);
  assert.equal(describeFalImageModel(entry('fal-ai/sana',imageSize),null).options.adapterSupported,false);
  assert.equal(isFalImageModel(publicId('fal-ai/sana')),true);
});

test('generation submits to the fal queue, polls, and downloads the image',async()=>{
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(32)]);
  const calls=[];let polls=0;
  const fetchImpl=async(url,init={})=>{
    calls.push([init.method||'GET',String(url)]);
    if(String(url).startsWith('https://queue.fal.run/fal-ai/flux/dev')&&init.method==='POST')
      return Response.json({request_id:'r1',status_url:'https://queue.fal.run/fal-ai/flux/requests/r1/status',response_url:'https://queue.fal.run/fal-ai/flux/requests/r1'});
    if(String(url).endsWith('/status'))return Response.json({status:++polls<2?'IN_PROGRESS':'COMPLETED'});
    if(String(url).endsWith('/requests/r1'))return Response.json({images:[{url:'https://v3b.fal.media/files/out.png'}]});
    if(String(url).startsWith('https://v3b.fal.media/'))return new Response(png,{status:200});
    return new Response('',{status:404});
  };
  const m=describeFalImageModel(entry('fal-ai/flux/dev',imageSize),{unit_price:0.025,unit:'megapixels',currency:'USD'});
  const client=new FalImageClient({apiKey:'k',fetchImpl,pollMs:1});
  const out=await client.generateImage({...m.options,providerModelId:m.providerModelId},{prompt:'cat',aspectRatio:'1:1'});
  assert.equal(out.mimeType,'image/png');
  assert.equal(calls[0][0],'POST');
  assert.equal(polls,2);
});

test('catalog sync reads schemas without the key and falls back to the per-model OpenAPI file',async()=>{
  const {fetchFalImageCatalog}=require('../src/fal_images.js');
  const schema=entry('fal-ai/flux/dev',imageSize).openapi;
  const seen=[];
  const fetchImpl=async(url,init={})=>{
    const u=String(url);seen.push([u,Boolean(init.headers?.authorization)]);
    if(u.includes('/models?category='))return Response.json({models:[{endpoint_id:'fal-ai/flux/dev',metadata:{status:'active'}}],has_more:false});
    if(u.includes('expand=openapi'))return Response.json({models:[{endpoint_id:'fal-ai/flux/dev',metadata:{display_name:'FLUX.1 [dev]'}}]});
    if(u.startsWith('https://fal.ai/api/openapi/'))return Response.json(schema);
    if(u.includes('/models/pricing'))return Response.json({prices:[{endpoint_id:'fal-ai/flux/dev',unit_price:0.025,unit:'megapixels',currency:'USD'}]});
    return new Response('',{status:404});
  };
  const models=await fetchFalImageCatalog({apiKey:'k',fetchImpl});
  assert.equal(models[0].options.adapterSupported,true);
  assert.equal(seen.find(([u])=>u.includes('expand=openapi'))[1],false);
  assert.equal(seen.find(([u])=>u.includes('/models/pricing'))[1],true);
});

test('fal labels: raw names readable, variants told apart, aliases kept once', () => {
  const { distinctLabels } = require('../src/fal_images.js');
  const mk = (id, label, cost = 1) => ({ providerModelId: id, label, options: { adapterSupported: true, pricing: { cost } } });
  const out = distinctLabels([mk('fal-ai/flux/dev', 'FLUX.1 [dev]'), mk('fal-ai/flux-1/dev', 'FLUX.1 [dev]'),
    mk('fal-ai/wan/v2.7/pro/text-to-image', 'Wan'), mk('fal-ai/wan/v2.2-5b/text-to-image', 'Wan'),
    mk('fal-ai/hunyuan-image/v3/text-to-image', 'fal-ai/hunyuan-image/v3/text-to-image')]);
  const by = Object.fromEntries(out.map(m => [m.providerModelId, m]));
  assert.equal(by['fal-ai/flux-1/dev'].options.adapterSupported, false);
  assert.equal(by['fal-ai/flux/dev'].options.adapterSupported, true);
  assert.equal(by['fal-ai/wan/v2.7/pro/text-to-image'].label, 'Wan · V2.7 Pro');
  assert.equal(by['fal-ai/wan/v2.2-5b/text-to-image'].label, 'Wan · V2.2 5b');
  assert.equal(by['fal-ai/hunyuan-image/v3/text-to-image'].label, 'Hunyuan Image V3');
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {describeFalImageModel,FalImageClient,publicId,isFalImageModel}=require('../src/fal_images.js');
const {quoteGateway,validateReferences}=require('../src/vercel_models.js');

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

test('reference capability follows the endpoint schema, and requires a safe quote',()=>{
  const price={unit_price:0.08,unit:'images',currency:'USD'};
  const props={aspect_ratio:{enum:['1:1','16:9']},image_urls:{type:'array',items:{type:'string'},minItems:1,maxItems:3}};
  const edit=describeFalImageModel(entry('fal-ai/sample/edit',props),price);
  const model={...edit.options,providerModelId:edit.providerModelId,mediaType:'image'};
  assert.equal(model.adapterSupported,true);
  assert.match(edit.label,/Image Edit$/);
  assert.deepEqual(model.supportedOperations,['image-to-image']);
  assert.equal(model.referenceCapabilities.image.min,1);
  assert.equal(model.referenceCapabilities.image.max,3);
  assert.equal(quoteGateway(model,{aspectRatio:'1:1'},1000).cost,80);
  assert.throws(()=>validateReferences(model,{}),/requires a reference image/);
  assert.throws(()=>validateReferences(model,{images:[{data:Buffer.from('image'),mimeType:'image/gif'}]}),/format/);
  const refs=[{url:'https://example.com/first.png'},{url:'https://example.com/second.png'}];
  const client=new FalImageClient();
  assert.deepEqual(client.input(model,{prompt:'Edit',aspectRatio:'16:9'},refs),{
    prompt:'Edit',aspect_ratio:'16:9',image_urls:refs.map(ref=>ref.url),
  });
  assert.throws(()=>client.input(model,{prompt:'Edit'}),/reference image count/);
  assert.throws(()=>client.input(model,{prompt:'Edit'},[...refs,...refs]),/reference image count/);

  const optional=describeFalImageModel(entry('fal-ai/sample',props),price);
  assert.equal(optional.options.referenceCapabilities.image.min,0);
  assert.doesNotThrow(()=>validateReferences({...optional.options,mediaType:'image'},{}));
  const variable=describeFalImageModel(entry('fal-ai/sample',props),{...price,unit:'megapixels'});
  assert.equal(variable.options.adapterSupported,true);
  assert.equal(variable.options.referenceCapabilities.image.supported,false);
  assert.equal(describeFalImageModel(entry('fal-ai/sample/edit',props),{...price,unit:'megapixels'}).options.adapterSupported,false);
  assert.equal(describeFalImageModel(entry('fal-ai/sample/edit',props,['prompt','image_urls','mask_url']),price).options.adapterSupported,false);

  const single=describeFalImageModel(entry('fal-ai/single/image-to-image',{...imageSize,image_url:{type:'string'}},['prompt','image_url']),price);
  assert.equal(client.input(single.options,{prompt:'Edit'},[refs[0]]).image_url,refs[0].url);
});

test('generation submits reference URLs to the edit endpoint, polls, and downloads the image',async()=>{
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(32)]);
  const calls=[];let polls=0;
  const fetchImpl=async(url,init={})=>{
    calls.push([init.method||'GET',String(url),init.body]);
    if(String(url).startsWith('https://queue.fal.run/fal-ai/flux/dev')&&init.method==='POST')
      return Response.json({request_id:'r1',status_url:'https://queue.fal.run/fal-ai/flux/requests/r1/status',response_url:'https://queue.fal.run/fal-ai/flux/requests/r1'});
    if(String(url).endsWith('/status'))return Response.json({status:++polls<2?'IN_PROGRESS':'COMPLETED'});
    if(String(url).endsWith('/requests/r1'))return Response.json({images:[{url:'https://v3b.fal.media/files/out.png'}]});
    if(String(url).startsWith('https://v3b.fal.media/'))return new Response(png,{status:200});
    return new Response('',{status:404});
  };
  const m=describeFalImageModel(entry('fal-ai/flux/dev/edit',{...imageSize,image_urls:{type:'array',items:{type:'string'}}}),
    {unit_price:0.025,unit:'image',currency:'USD'});
  const client=new FalImageClient({apiKey:'k',fetchImpl,pollMs:1});
  const reference='https://example.com/reference.png';
  const out=await client.generateImage({...m.options,providerModelId:m.providerModelId},{prompt:'cat',aspectRatio:'1:1'},[{url:reference}]);
  assert.equal(out.mimeType,'image/png');
  assert.deepEqual(calls[0].slice(0,2),['POST','https://queue.fal.run/fal-ai/flux/dev/edit']);
  assert.deepEqual(JSON.parse(calls[0][2]).image_urls,[reference]);
  assert.equal(polls,2);
});

test('catalog sync reads generation and edit schemas without the key and falls back to the per-model OpenAPI file',async()=>{
  const {fetchFalImageCatalog}=require('../src/fal_images.js');
  const textId='fal-ai/flux/dev', editId='fal-ai/nano-banana-2/edit';
  const text=entry(textId,imageSize);
  const edit=entry(editId,{aspect_ratio:{enum:['1:1','16:9']},image_urls:{type:'array',items:{type:'string'}}});
  const seen=[];
  const fetchImpl=async(url,init={})=>{
    const u=String(url);seen.push([u,Boolean(init.headers?.authorization)]);
    if(u.includes('/models?category='))return Response.json({models:[{endpoint_id:u.includes('category=image-to-image')?editId:textId,metadata:{status:'active'}}],has_more:false});
    if(u.includes('expand=openapi'))return Response.json({models:[edit,{endpoint_id:textId,metadata:{display_name:'FLUX.1 [dev]'}}]});
    if(u.startsWith('https://fal.ai/api/openapi/'))return Response.json(text.openapi);
    if(u.includes('/models/pricing'))return Response.json({prices:[
      {endpoint_id:textId,unit_price:0.025,unit:'megapixels',currency:'USD'},
      {endpoint_id:editId,unit_price:0.08,unit:'images',currency:'USD'},
    ]});
    return new Response('',{status:404});
  };
  const models=await fetchFalImageCatalog({apiKey:'k',fetchImpl});
  assert.deepEqual(models.map(model=>model.options.adapterSupported),[true,true]);
  assert.deepEqual(models.map(model=>model.options.referenceCapabilities.image.min),[0,1]);
  assert.equal(models[1].options.referenceCapabilities.image.max,10);
  assert.equal(seen.find(([u])=>u.includes('expand=openapi'))[1],false);
  assert.equal(seen.find(([u])=>u.includes('/models/pricing'))[1],true);
});

test('the fal image worker picks up ready jobs on a shorter interval', t=>{
  const {FalImageQueue}=require('../src/fal_image_queue.js');
  const {VercelQueue}=require('../src/vercel_queue.js');
  const schedule=t.mock.method(VercelQueue.prototype,'schedule',()=>{});
  const queue=new FalImageQueue();
  queue.start();
  queue.schedule();
  queue.sourceReady=true;
  queue.schedule();
  assert.deepEqual(schedule.mock.calls.map(call=>call.arguments),[[700],[5000],[2000]]);
  queue.stop();
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

test('fal GPT image models are priced per image by quality and send the chosen quality',()=>{
  const quality={quality:{type:'string',enum:['auto','low','medium','high']}};
  const g2=describeFalImageModel(entry('openai/gpt-image-2',{...imageSize,...quality}),{unit_price:1,unit:'units',currency:'USD'});
  assert.equal(g2.label,'GPT Image 2');
  assert.equal(g2.options.adapterSupported,true);
  assert.deepEqual(g2.options.qualities,['low','medium','high']);
  const m2={...g2.options,providerModelId:g2.providerModelId,mediaType:'image'};
  assert.equal(quoteGateway(m2,{aspectRatio:'1:1',quality:'high'},1000).sourceUsd,0.214); // $0.211 + prompt
  assert.equal(quoteGateway(m2,{aspectRatio:'1:1'},1000).sourceUsd,0.214); // high by default
  assert.equal(new FalImageClient().input(m2,{prompt:'P',aspectRatio:'1:1',quality:'low'}).quality,'low');
  // GPT Image 1.x takes fixed WxH sizes and fal rounds its price up to the cent.
  const g1=describeFalImageModel(entry('fal-ai/gpt-image-1-mini',{image_size:{type:'string',enum:['auto','1024x1024','1536x1024','1024x1536']},...quality}),null);
  assert.deepEqual(g1.options.aspectRatios,['1:1','3:2','2:3']);
  const m1={...g1.options,providerModelId:g1.providerModelId,mediaType:'image'};
  assert.equal(quoteGateway(m1,{aspectRatio:'3:2',quality:'medium'},1000).sourceUsd,0.02);
  assert.equal(new FalImageClient().input(m1,{prompt:'P',aspectRatio:'3:2',quality:'medium'}).image_size,'1536x1024');
});

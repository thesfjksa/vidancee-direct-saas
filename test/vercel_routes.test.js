const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mediaModels}=require('../src/vercel_models.js');
const source=require('../src/provider/vercel_catalog.json');

test('real gateway HTTP routes encrypt credentials, enforce account/model controls, reserve quoted credits and protect playback',async t=>{
  process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.WORKER_ENABLED='false';process.env.ADMIN_TOKEN='admin-test-only';process.env.WORKER_WAKE_URL='';
  const users=new Map([1,2].map(id=>[id,{id,email:'user'+id+'@example.com',credits:50000,status:'active',plan_code:'pro',role:'user'}]));
  const values=new Map(),jobs=new Map(),outputs=new Map(),access=new Map(),transactions=[];
  const chosen=['google/gemini-nano-banana-2.1','google/veo-3.0-fast-generate-001','openai/gpt-image-2'];
  const modelRows=mediaModels(source).filter(m=>chosen.includes(m.providerModelId)).map((m,i)=>({id:i+1,provider:'vercel',provider_model_id:m.providerModelId,public_model_id:m.publicModelId,label:m.label,media_type:m.mediaType,options_json:JSON.stringify(m.options),enabled:1,available:1}));
  async function execute(sql,args=[]){
    sql=sql.replace(/ = \?/g,'=?').replace(/credits = credits - \?/g,'credits=credits-?');
    if(sql.startsWith('CREATE'))return [[]];
    if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('RELEASE_LOCK'))return [[]];
    if(sql.includes('COUNT(*)'))return [[{total:sql.includes('provider_models')?3:0}]];
    if(sql.includes('SELECT setting_key'))return [[...values.values()]];
    if(sql.includes('INSERT INTO app_settings')){values.set(args[0],{setting_key:args[0],setting_value:args[1],is_secret:args[2]});return [{affectedRows:1}];}
    if(sql.includes('DELETE FROM app_settings')){values.delete(args[0]);return [{affectedRows:1}];}
    if(sql.includes('FROM users WHERE id='))return [[users.get(Number(args[0]))].filter(Boolean)];
    if(sql.startsWith('SELECT provider,enabled'))return [access.get(args[0])||[]];
    if(sql.includes('FROM provider_models')){
      let rows=modelRows.filter(r=>r.provider===args[sql.includes('WHERE id=?')?1:0]||sql.includes("provider='vercel'"));
      if(sql.includes('public_model_id=?'))rows=rows.filter(r=>r.public_model_id===args[1]&&r.media_type===args[2]);
      if(sql.includes('WHERE id=?'))rows=rows.filter(r=>r.id===Number(args[0]));
      if(sql.includes('enabled=1'))rows=rows.filter(r=>r.enabled);if(sql.includes('available=1'))rows=rows.filter(r=>r.available);
      return [rows];
    }
    if(sql.startsWith('UPDATE provider_models SET price_override')){modelRows.find(r=>r.id===args[1]).price_override=args[0];return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE provider_models SET enabled')){const row=modelRows.find(r=>r.id===args[1]&&r.provider===args[2]);if(row)row.enabled=args[0];return [{affectedRows:row?1:0}];}
    if(sql.includes('INSERT INTO generations')){
      let row;
      if(sql.includes("'image'")){
        const [id,user_id,provider,queue_priority,mode,model,aspect_ratio,prompt,credits_cost,provider_cost,provider_cost_unit,image_quality,generation_options]=args;
        row={id,user_id,provider,queue_priority,mode,model,aspect_ratio,prompt,credits_cost,provider_cost,provider_cost_unit,image_quality,generation_options,media_type:'image'};
      }else{
        const [id,user_id,provider,queue_priority,mode,model,duration,resolution,aspect_ratio,prompt,credits_cost,provider_cost,provider_cost_unit,generation_options]=args;
        row={id,user_id,provider,queue_priority,mode,model,duration,resolution,aspect_ratio,prompt,credits_cost,provider_cost,provider_cost_unit,generation_options,media_type:'video'};
      }
      row.status='queued';jobs.set(row.id,row);return [{affectedRows:1}];
    }
    if(sql.includes('INSERT INTO credit_transactions')){transactions.push(args);return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE users SET credits=credits-')){users.get(args[1]).credits-=args[0];return [{affectedRows:1}];}
    if(sql.includes('FROM generations WHERE id=')){const row=jobs.get(args[0]);return [[row].filter(r=>r&&(args.length<2||r.user_id===args[1]))];}
    if(sql.includes('FROM generation_video_outputs'))return [[outputs.get(args[0])].filter(Boolean)];
    if(sql.includes('FROM generation_video_chunks'))return [[{video_data:outputs.get(args[0]).bytes}]];
    if(sql.includes('FROM generation_images'))return [[]];
    throw new Error('Unexpected test SQL: '+sql);
  }
  const db={execute,query:execute,getConnection:async()=>({execute,query:execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){}})};
  const dbModule=require('../src/db.js'),originalDb={...dbModule};
  Object.assign(dbModule,{getPool:()=>db,dbConfigured:()=>true,initDb:async()=>true});
  const auth=require('../src/auth.js'),originalAuth={...auth};
  auth.userFromRequest=async req=>users.get(Number(req.headers['x-test-user']));
  auth.requireUser=async req=>{const user=await auth.userFromRequest(req);if(!user)throw Object.assign(new Error('Authentication required.'),{statusCode:401});return user;};
  const provider=require('../src/provider/vercel.js');const originalCredits=provider.VercelGatewayClient.prototype.credits;
  provider.VercelGatewayClient.prototype.credits=async()=>({balance:'12.00',totalUsed:'3.00'});
  const server=require('../server.js');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));Object.assign(dbModule,originalDb);Object.assign(auth,originalAuth);provider.VercelGatewayClient.prototype.credits=originalCredits;});
  if(!server.listening)await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  async function request(path,{admin=false,user=1,method='GET',body}={}){
    const r=await fetch(origin+path,{method,headers:{...(user?{'x-test-user':String(user)}:{}),...(admin?{'x-admin-token':'admin-test-only'}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:await r.json()};
  }
  assert.equal((await request('/admin/vercel/check',{method:'POST'})).status,401);
  assert.equal((await request('/api/model-cost',{method:'POST',user:null,body:{model:modelRows[0].public_model_id}})).status,401);
  let saved=await request('/admin/provider-settings',{admin:true,method:'POST',body:{vercelApiKey:'gateway-secret-only',vercelEnabled:true,vercelCustomerCreditsPerUsd:1000,allowProviderCharges:true}});
  assert.equal(saved.status,200);assert.equal(saved.data.settings.vercel.apiKeyConfigured,true);
  assert.equal(JSON.stringify(saved).includes('gateway-secret-only'),false);assert.match(values.get('vercel_api_key').setting_value,/^v1:/);assert.equal(values.get('vercel_api_key').is_secret,1);
  const config=await request('/api/config');
  assert.equal(config.data.imagePricing.filter(m=>m.id.startsWith('studio_gw_')).length,2);
  // Video Studio runs on ArgoLink only; gateway video models are not offered.
  assert.equal(config.data.pricing.filter(m=>m.id.startsWith('studio_gw_')).length,0);
  const nano=modelRows.find(m=>m.provider_model_id==='google/gemini-nano-banana-2.1');
  const input={model:nano.public_model_id,prompt:'A flower',aspectRatio:'4:5',imageSize:'2K'};
  const quote=await request('/api/model-cost',{method:'POST',body:{...input,mediaType:'image'}});assert.equal(quote.data.cost,15);
  const image=await request('/api/image-generations',{method:'POST',body:input});assert.equal(image.status,201);assert.equal(image.data.generation.credits_cost,15);assert.equal(image.data.generation.imageSize,'2K');assert.equal(image.data.generation.quality,null);
  const savedImage=jobs.get(image.data.generation.id);assert.equal(savedImage.provider,'vercel');assert.equal(savedImage.provider_cost_unit,'usd-estimate');assert.equal(JSON.parse(savedImage.generation_options).model.providerModelId,nano.provider_model_id);
  const balance=users.get(1).credits;
  for(const bad of [{...input,aspectRatio:'7:3'},{...input,imageSize:'8K'},{...input,quality:'high'}])assert.equal((await request('/api/image-generations',{method:'POST',body:bad})).status,400);
  assert.equal(users.get(1).credits,balance);
  const veo=modelRows.find(m=>m.provider_model_id==='google/veo-3.0-fast-generate-001');
  const videoInput={model:veo.public_model_id,prompt:'A sunrise',duration:8,resolution:'720p',aspectRatio:'16:9',generateAudio:true};
  assert.equal((await request('/api/generations',{method:'POST',body:videoInput})).status,400);
  // A gateway video made before the change still plays.
  const videoId='6f9619ff-8b86-4011-b42d-00c04fc964ff';
  jobs.set(videoId,{id:videoId,user_id:1,provider:'vercel',model:veo.public_model_id,media_type:'video',status:'completed',output_url:'db:video',duration:8,aspect_ratio:'16:9',prompt:'A sunrise',credits_cost:1200});
  const bytes=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
  outputs.set(videoId,{byte_length:bytes.length,mime_type:'video/mp4',bytes});
  const mediaPath='/api/generations/'+videoId+'/media';
  const playback=await fetch(origin+mediaPath,{headers:{'x-test-user':'1',range:'bytes=4-7'}});assert.equal(playback.status,206);assert.deepEqual(Buffer.from(await playback.arrayBuffer()),bytes.subarray(4,8));
  assert.equal((await request(mediaPath,{user:2})).status,404);
  const gpt=modelRows.find(m=>m.provider_model_id==='openai/gpt-image-2');
  // GPT Image is priced from OpenAI's published per-image table without an Admin rate.
  assert.equal((await request('/api/model-cost',{method:'POST',body:{model:gpt.public_model_id,mediaType:'image',quality:'high',aspectRatio:'1:1'}})).data.cost,60); // $0.211 x 280, rounded up
  const rate=await request('/admin/vercel/models/'+gpt.id+'/price',{admin:true,method:'POST',body:{price:{low:0.01,medium:0.03,high:0.1}}});assert.equal(rate.status,200);assert.equal(rate.data.model.ready,true);
  assert.equal((await request('/api/model-cost',{method:'POST',body:{model:gpt.public_model_id,mediaType:'image',quality:'high',aspectRatio:'4:5'}})).data.cost,35); // $0.125 x 280
  assert.equal((await request('/admin/provider-models/'+gpt.id,{admin:true,method:'POST',body:{provider:'vercel',enabled:false}})).status,200);
  assert.equal((await request('/api/model-cost',{method:'POST',body:{model:gpt.public_model_id,mediaType:'image'}})).status,404);
  access.set(1,[{provider:'vercel',enabled:0}]);
  assert.equal((await request('/api/model-cost',{method:'POST',body:{...input,mediaType:'image'}})).status,403);
  assert.equal((await request('/api/image-generations',{method:'POST',body:input})).status,503);
  assert.equal((await request('/api/config')).data.imagePricing.filter(m=>m.id.startsWith('studio_gw_')).length,0);
  assert.equal(transactions.length,1);
  await request('/admin/provider-settings',{admin:true,method:'POST',body:{vercelApiKey:''}});assert.equal(values.has('vercel_api_key'),true);
  assert.equal((await request('/admin/vercel/check',{admin:true,method:'POST'})).data.balance,'12.00');
  const invalid=await request('/admin/provider-settings',{admin:true,method:'POST',body:{vercelApiKey:'replacement-secret',vercelCustomerCreditsPerUsd:0}});assert.equal(invalid.status,400);
  saved=await request('/admin/provider-settings',{admin:true,method:'POST',body:{clearVercelApiKey:true}});assert.equal(saved.data.settings.vercel.apiKeyConfigured,false);assert.equal(values.has('vercel_api_key'),false);
});

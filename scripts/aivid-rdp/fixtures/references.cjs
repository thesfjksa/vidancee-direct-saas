'use strict';
const assert=require('node:assert/strict');
const {html}=require('./form.cjs');
const {diagnosticReferences}=require('../../../src/aivid_probe_assets.js');
const API='https://api.aivid.dev',S3='https://aivid-dev.s3.ap-southeast-1.amazonaws.com/';
const cors={'access-control-allow-origin':'https://aivid.dev','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'*'};
async function checkReferenceFlows(context,Client){
  let mode='normal',generationRequests=0,saved=0;const events=[];
  const client=new Client({maxSourceCredits:30,connect:async()=>{
    const page=await context.newPage();
    await page.route('https://aivid.dev/**',route=>route.fulfill({contentType:'text/html',body:html.replace('<header>0 credits','<header>50 credits')
      .replace('<button onclick="window.generateClicks++">Generate</button>','<button onclick="uploadAndPrepare()">Generate</button>')
      .replace('</main>','<input id="refVideos" onchange="preview(this,&quot;video&quot;)" type="file" accept="video/quicktime,video/mp4" multiple><input id="refAudio" onchange="preview(this,&quot;audio&quot;)" type="file" accept="audio/wav,audio/mpeg" multiple><span id="uploadError"></span></main>')+
      '<script>async function post(path,body){const r=await fetch("'+API+'"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw Error("upload failed");return r.json()};'+
      'async function uploadAndPrepare(){try{const ids={image:[],video:[],audio:[]};for(const [kind,id] of [["image","refImages"],["video","refVideos"],["audio","refAudio"]])for(const file of (window.selectedFiles[kind]||[])){'+
      'const p=(await post("/v2/uploads/presigned-url",{fileName:file.name,fileType:file.type,fileSize:file.size})).data;const form=new FormData();for(const [k,v]of Object.entries(p.fields))form.append(k,v);form.append("file",file);'+
      'const uploaded=await fetch(p.url,{method:"POST",body:form});if(!uploaded.ok)throw Error("storage failed");const saved=(await post("/v2/uploads/presigned-save",{fileName:p.fileName,fileSize:file.size,fileType:file.type,filePath:p.key,folderPath:p.folderPath})).data;ids[kind].push(saved.id);}'+
      'const model={"Seedance 2.0 (Mini)":"seedance-2.0-mini","Seedance 2.0":"seedance-2.0","Seedance 2.0 (Fast)":"seedance-2.0-fast","Seedance 2.5":"seedance-2.5"}[document.getElementById("model").textContent];'+
      'await post("/v2/generations",{model,prompt:document.querySelector("main textarea").value,duration:Number(document.getElementById("duration").value),resolution:document.getElementById("resolution").textContent,aspectRatio:"16:9",isPublic:!privateToggle.checked,mode:"references",imageIds:ids.image,videoIds:ids.video,audioIds:'+ (mode==='wrong_ids'?'[]':'ids.audio')+'});'+
      '}catch(e){document.getElementById("uploadError").textContent=e.message}}</script>'}));
    await page.route(API+'/**',async route=>{
      const r=route.request(),path=new URL(r.url()).pathname;
      if(r.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
      const body=r.postDataJSON();
      if(path==='/v2/uploads/presigned-url'){
        events.push('presign');const key='probe/'+events.length;
        return route.fulfill({headers:cors,json:{data:{url:S3,fields:{key},key,fileName:body.fileName,folderPath:'probe'}}});
      }
      if(path==='/v2/uploads/presigned-save'){
        saved++;events.push('save');return route.fulfill({headers:cors,json:{data:{id:'fixture-reference-'+String(saved).padStart(6,'0'),fileSize:body.fileSize,fileType:body.fileType}}});
      }
      if(path==='/v2/generations'){generationRequests++;events.push('generation');return route.fulfill({headers:cors,json:{id:'fixture-provider-job-0001'}});}
      return route.fulfill({status:400,headers:cors,json:{error:'Unexpected fixture request'}});
    });
    await page.route(S3,route=>{
      if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
      events.push('storage');return route.fulfill({status:mode==='storage_failure'?403:204,headers:cors,body:''});
    });
    return {page,close:async()=>{await page.close().catch(()=>{})}};
  }});
  const value={prompt:'A blue square uses @image1 @video1 @audio1.',duration:5,resolution:'480p',aspectRatio:'16:9'};
  for(const model of ['aivid_seedance_2_0_mini','aivid_seedance_2_0','aivid_seedance_2_0_fast','aivid_seedance_2_5']){
    const result=await client.checkReferences({...value,model},diagnosticReferences());
    assert.equal(result.generationBlocked,true);assert.equal(result.submitted,false);
    assert.equal(result.balanceBefore,50);assert.equal(result.balanceAfter,50);
    assert.deepEqual(result.uploadedCounts,{image:1,video:1,audio:1});
  }
  assert.equal(generationRequests,0);assert.equal(saved,12);
  events.length=0;let reservations=0;
  const result=await client.startVideo(value,diagnosticReferences(),{beforeClick:async()=>{
    assert.deepEqual(events,['presign','storage','save','presign','storage','save','presign','storage','save']);reservations++;
  }});
  assert.equal(result.state,'accepted');assert.equal(reservations,1);assert.equal(generationRequests,1);
  for(mode of ['wrong_ids','storage_failure']){
    const result=await client.startVideo(value,diagnosticReferences(),{beforeClick:async()=>{reservations++}});
    assert.equal(result.state,'rejected');assert.equal(reservations,1);assert.equal(generationRequests,1);
  }
  console.log('Reference flow: image/video/audio uploads, captured IDs, blocked probes, reservation order and failure rejection passed; all upstream endpoints mocked.');
}
module.exports={checkReferenceFlows};

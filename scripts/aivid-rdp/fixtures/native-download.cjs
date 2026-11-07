'use strict';
const assert=require('node:assert/strict');
const {downloadNative,collectSavedVideo}=require('../native.cjs');
async function checkInlineDownload(context){
 const id='6aee348c6467353c0fd7ded1',detail='https://aivid.dev/videos/parent-generation-id';
 const media='https://aivid-dev.ea27a69da769d04e04a51faf6bcc2f00.r2.cloudflarestorage.com/generating/123-'+id+'.mp4?X-Amz-Signature=fixture';
 const historyMedia=media.replace(id,'6aee348c6467353c0fd7ded3');
 const clip=Buffer.from('0000ftypisom0000');
 const page=await context.newPage();let fetches=0,mutations=0,mode='completed';
 const history='https://api.aivid.dev/v2/generations?page=';
 const generate='https://aivid.dev/generate';
 await context.route('**/*',async route=>{
  if(route.request().method()!=='GET'){mutations++;return route.abort();}
  if(route.request().url()===generate)return route.fulfill({contentType:'text/html',body:
   '<main><h2>Recent generations</h2><button onclick="load(2)">Load More</button></main>'+
   '<script>function load(page){return fetch("'+history+'"+page+"&pageSize=20").then(r=>r.json());}load(1);</script>'});
  if(route.request().url().startsWith(history)){
   const page=new URL(route.request().url()).searchParams.get('page');
   const match={_id:id,status:mode==='wrong_media'?'completed':mode,video:mode==='wrong_media'?historyMedia.replace('.com/','.com.evil.test/'):historyMedia};
   const data=page==='2'?(mode==='duplicate'?[match,match]:[match]):[{_id:'unrelated-source-job',status:'completed',video:media}];
   return route.fulfill({headers:{'access-control-allow-origin':'https://aivid.dev'},json:{data,metadata:{totalPages:2}}});
  }
  if(route.request().url()===detail)return route.fulfill({contentType:'text/html',body:'<button onclick="window.open('+JSON.stringify(media).replace(/"/g,'&quot;')+',\'_blank\',\'noopener\')">Download Video</button>'});
  if(route.request().url()===media)return route.fulfill({contentType:'text/html',body:'<video controls src="'+media+'"></video>'});
  return route.abort();
 });
 try{
  await page.goto(detail);
  const count=context.pages().length;
  const result=await downloadNative(page,{timeoutMs:15000,fetchImpl:async(url,options)=>{
   assert.equal(url,media);assert.equal(options.redirect,'error');fetches++;
   return new Response(clip,{headers:{'content-type':'video/mp4','content-length':String(clip.length)}});
  }});
  assert.deepEqual(result.data,clip);assert.equal(fetches,1);assert.equal(mutations,0);
  assert.equal(context.pages().length,count,'inline popup cleaned after successful transfer');
  assert.equal(page.url(),detail,'original work tab remains available');
  const fetchImpl=async url=>{
    assert.equal(url,historyMedia);fetches++;return new Response(clip,{headers:{'content-type':'video/mp4'}});
  };
  const saved=await collectSavedVideo(page,id,{fetchImpl});
  assert.deepEqual(saved,{state:'completed',output:{data:clip,mimeType:'video/mp4'}});
  assert.equal(fetches,2);
  assert.equal(page.url(),generate);
  assert.equal(context.pages().length,count,'history collection never opens a popup');
  for(const state of ['pending','failed']){
    mode=state;
    assert.deepEqual(await collectSavedVideo(page,id,{fetchImpl}),{state});
  }
  mode='duplicate';
  await assert.rejects(collectSavedVideo(page,id,{fetchImpl}),/ambiguous job ID/);
  mode='wrong_media';
  await assert.rejects(collectSavedVideo(page,id,{fetchImpl}),/verified MP4/);
  assert.equal(fetches,2);
  assert.equal(mutations,0);

 }finally{await context.unroute('**/*');await page.close();}
 console.log('Native inline popup (including noopener): exact-job transfer, validated MP4 and owned popup cleanup passed; no paid requests.');
}
module.exports={checkInlineDownload};

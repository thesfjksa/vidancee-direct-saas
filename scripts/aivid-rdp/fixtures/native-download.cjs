'use strict';
const assert=require('node:assert/strict');
const {downloadNative,downloadSavedVideo}=require('../native.cjs');
async function checkInlineDownload(context){
 const id='6aee348c6467353c0fd7ded1',detail='https://aivid.dev/videos/parent-generation-id';
 const media='https://aivid-dev.ea27a69da769d04e04a51faf6bcc2f00.r2.cloudflarestorage.com/generating/123-'+id+'.mp4?X-Amz-Signature=fixture';
 const clip=Buffer.from('0000ftypisom0000');
 const page=await context.newPage();let fetches=0,mutations=0;
 await context.route('**/*',async route=>{
  if(route.request().method()!=='GET'){mutations++;return route.abort();}
  if(route.request().url()==='https://aivid.dev/generate')return route.fulfill({contentType:'text/html',body:'<main><h2>Recent generations</h2><article><video src="'+media.replace(id,'wrong-source-job')+'"></video><button onclick="window.wrongSave=true">Save</button></article><article><video src="'+media+'"></video><button onclick="window.correctSave=true;window.open('+JSON.stringify(media).replace(/"/g,'&quot;')+',\'_blank\',\'noopener\')">Save</button></article></main>'});
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
  await page.goto('https://aivid.dev/generate');
  const saved=await downloadSavedVideo(page,id,{timeoutMs:15000,fetchImpl:async url=>{
    assert.equal(url,media);fetches++;return new Response(clip,{headers:{'content-type':'video/mp4'}});
  }});
  assert.deepEqual(saved.data,clip);assert.equal(fetches,2);
  assert.deepEqual(await page.evaluate(()=>({correct:Boolean(window.correctSave),wrong:Boolean(window.wrongSave)})),{correct:true,wrong:false});
  assert.equal(context.pages().length,count,'history Save popup is closed after collection');
  assert.equal(await downloadSavedVideo(page,'unrelated-source-job',{findTimeoutMs:0}),null);
  await page.locator('main').evaluate(el=>el.append(el.querySelector('article:last-child').cloneNode(true)));
  assert.equal(await downloadSavedVideo(page,id,{findTimeoutMs:0}),null,'ambiguous duplicate matching cards must not click Save');

 }finally{await context.unroute('**/*');await page.close();}
 console.log('Native inline popup (including noopener): exact-job transfer, validated MP4 and owned popup cleanup passed; no paid requests.');
}
module.exports={checkInlineDownload};

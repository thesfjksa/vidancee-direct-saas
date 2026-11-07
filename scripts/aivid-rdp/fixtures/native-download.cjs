'use strict';
const assert=require('node:assert/strict');
const {downloadNative}=require('../native.cjs');
async function checkInlineDownload(context){
 const id='6aee348c6467353c0fd7ded1',detail='https://aivid.dev/videos/'+id;
 const media='https://aivid-dev.ea27a69da769d04e04a51faf6bcc2f00.r2.cloudflarestorage.com/generating/123-'+id+'.mp4?X-Amz-Signature=fixture';
 const clip=Buffer.from('0000ftypisom0000');
 const page=await context.newPage();let fetches=0,mutations=0;
 await context.route('**/*',async route=>{
  if(route.request().method()!=='GET'){mutations++;return route.abort();}
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
 }finally{await context.unroute('**/*');await page.close();}
 console.log('Native inline popup (including noopener): exact-job transfer, validated MP4 and owned popup cleanup passed; no paid requests.');
}
module.exports={checkInlineDownload};

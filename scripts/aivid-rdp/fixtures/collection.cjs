
'use strict';
const assert=require('node:assert/strict');
async function checkCollection(context,Client){
  const id='fixture-existing-video-0001',url='https://aivid.dev/videos/'+id;
  let mode='missing',downloads=0,mutations=0;
  const clip=Buffer.from('0000ftypisom0000');
  const client=new Client({connect:async()=>{
    const page=await context.newPage();
    await page.route('**/*',route=>{
      if(route.request().method()!=='GET'){mutations++;return route.abort();}
      if(route.request().url()!==url)return route.fulfill({status:404,body:''});
      const detail='<dl><dt>Status</dt><dd>'+({processing:'Processing',failed:'Failed',completed:'Completed',unknown:'Unexpected'}[mode]||'Completed')+'</dd></dl><button>Download Video</button>';
      return route.fulfill({contentType:'text/html',body:mode==='missing'?'<main>Video not found.</main>':mode==='loading'?'<main id="body">Loading...</main><script>setTimeout(()=>document.getElementById("body").innerHTML='+JSON.stringify(detail)+',100)</script>':'<main>'+detail+'</main>'});
    });
    return {page,close:async()=>{await page.close()}};
  },download:async page=>{assert.equal(page.url(),url);downloads++;return{data:clip,mimeType:'video/mp4'}}});
  for(mode of ['missing','missing','processing'])assert.deepEqual(await client.collectVideo(id),{state:'pending'});
  assert.equal(downloads,0);
  for(mode of ['completed','loading'])assert.deepEqual(await client.collectVideo(id),{state:'completed',output:{data:clip,mimeType:'video/mp4'}});
  assert.equal(downloads,2);
  mode='failed';assert.deepEqual(await client.collectVideo(id),{state:'failed'});
  mode='unknown';await assert.rejects(client.collectVideo(id),/not recognized/);
  assert.equal(mutations,0);
  console.log('Collection: temporary not-found and processing retry the existing ID; completed/delayed pages download; only explicit failed status fails; no mutation.');
}
module.exports={checkCollection};

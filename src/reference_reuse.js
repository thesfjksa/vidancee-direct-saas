'use strict';

// Image reuse sends pointers to reference images already stored for one of the
// customer's earlier generations instead of downloading and re-uploading them.
// `referenceOrder` lists {kind:'reused',id} and {kind:'upload'} entries in the
// order the customer arranged them; uploads are matched to files in sequence.
async function attachReusedImageReferences(db,userId,body){
  if(body.referenceOrder===undefined)return body;
  const invalid=message=>Object.assign(new Error(message),{statusCode:400});
  let order;
  try{order=JSON.parse(String(body.referenceOrder));}catch{throw invalid('Invalid reference image order.');}
  if(!Array.isArray(order)||order.length>12)throw invalid('Invalid reference image order.');
  const uploads=Array.isArray(body.images)?body.images:[];
  const reusedIds=[];
  for(const item of order){
    if(item?.kind==='upload')continue;
    const id=Number(item?.id);
    if(item?.kind!=='reused'||!Number.isSafeInteger(id)||id<=0||reusedIds.includes(id))throw invalid('Invalid reference image order.');
    reusedIds.push(id);
  }
  if(order.length-reusedIds.length!==uploads.length)throw invalid('Invalid reference image order.');
  let stored=new Map();
  if(reusedIds.length){
    const generationId=String(body.reuseGenerationId||'');
    if(!/^[0-9a-f-]{36}$/i.test(generationId))throw invalid('The reused generation reference is invalid.');
    const [rows]=await db.execute(
      `SELECT gi.id,gi.filename,gi.mime_type,gi.image_data
       FROM generation_images gi JOIN generations g ON g.id=gi.generation_id
       WHERE gi.generation_id=? AND g.user_id=? AND gi.id IN (${reusedIds.map(()=>'?').join(',')})`,
      [generationId,userId,...reusedIds]);
    await require('./object_storage.js').hydrateBlobs(rows,'image_data');
    stored=new Map(rows.map(row=>[Number(row.id),row]));
    if(stored.size!==reusedIds.length)throw invalid('One or more reused reference images are no longer available. Upload them again.');
  }
  let next=0;
  body.images=order.map(item=>{
    if(item.kind==='upload')return uploads[next++];
    const row=stored.get(Number(item.id));
    return {filename:String(row.filename||'reference-image').slice(0,255),mimeType:row.mime_type,data:row.image_data};
  });
  delete body.referenceOrder;delete body.reuseGenerationId;
  return body;
}

module.exports={attachReusedImageReferences};

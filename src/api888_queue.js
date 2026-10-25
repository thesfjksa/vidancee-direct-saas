'use strict';
const {VercelQueue,savedOptions}=require('./vercel_queue.js');
const {Api888Client}=require('./provider/api888.js');
const {errorDetails}=require('./activity_log.js');
class Api888Queue extends VercelQueue{
  constructor(options={}){super({...options,provider:'api888',clientFactory:options.clientFactory||((o)=>new Api888Client(o))});this.videoTimeoutMs=3*60*60*1000;}
  apiKey(s){return s.api888ApiKey||'';}
  sourceEnabled(s){return Boolean(s.api888Enabled);}
  maxInflight(s){return s.api888MaxInflight||2;}
  // Reference files kept in cloud storage are handed to 888API as 24-hour
  // presigned links: downloading large videos through the web host was too
  // slow, and 888API then rendered without the reference.
  async references(db,job){
    const refs=await super.references(db,job);
    if(job.media_type==='image'||!refs.length)return refs;
    const {blobRefKey,configuredStorage}=require('./object_storage.js');
    const [rows]=await db.execute('SELECT position_index,media_data FROM generation_media WHERE generation_id=? AND LENGTH(media_data)<512 ORDER BY position_index',[job.id]);
    const keys=new Map(rows.map(r=>[Number(r.position_index),blobRefKey(r.media_data)]).filter(([,k])=>k));
    if(!keys.size)return refs;
    const store=await configuredStorage({requireEnabled:false});
    if(!store)return refs;
    return refs.map(ref=>{
      const position=Number(String(ref.url).match(/\/provider-media\/[0-9a-f-]{36}\/(\d+)/i)?.[1]);
      const key=keys.get(position);
      return key?{...ref,url:store.presign(key,{expires:86400,contentType:ref.mimeType})}:ref;
    });
  }
  async submit(db,job,client){
    const options=savedOptions(job),model=await this.getModel('api888',job.model,job.media_type);
    if(!model?.ready)throw new Error('888API model cannot currently accept generation.');
    const refs=await this.references(db,job);
    if(job.media_type==='image'){
      const result=await client.generateImage(model,options,refs);
      return this.complete(db,job,result);
    }
    // Log metadata, never customer prompts, signed reference links or credentials.
    this.log(job,'job.request_prepared','888API video parameters checked',{
      model:model.providerModelId,duration:options.duration,resolution:options.resolution,
      billedTimeField:model.api888?.secondsField==='seconds'?'seconds':'duration',
      imageReferenceCount:refs.filter(r=>r.mimeType?.startsWith('image/')).length,
      videoReferenceCount:refs.filter(r=>r.mimeType?.startsWith('video/')).length,
      audioReferenceCount:refs.filter(r=>r.mimeType?.startsWith('audio/')).length,
    });
    const id=await client.startVideo(model,options,refs);
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify({requestId:id}),id.slice(0,191),job.id]);
  }
  // A successful status check removes any previous transient polling warning.
  // This does not clear real failures, completed jobs or refunded jobs.
  async markProcessing(db,job){
    await db.execute("UPDATE generations SET status='processing',error_message=NULL,updated_at=UTC_TIMESTAMP() WHERE id=? AND status IN ('submitted','processing') AND refunded_at IS NULL",[job.id]);
  }
  async pollJob(db,client,job){
    let op={};
    try{op=JSON.parse(job.provider_operation||'{}');}catch{}
    if(!op.requestId)throw new Error('888API operation ID missing.');
    const result=await client.videoStatus(op.requestId);
    if(result.status==='pending')return this.markProcessing(db,job);
    if(result.status==='failed')return this.refund(job.id,'failed','888API could not complete the video. Credits were refunded.',null);
    let video;
    try{video=await client.videoContent(op.requestId,result.url);}
    catch(error){
      if(error.unretrievableOutput===true){
        this.log(job,'job.video_output_unavailable',
          '888API completed video was not accessible via safe downloads; generation refunded.',
          errorDetails(error),'error');
        return this.refund(job.id,'failed',
          'Video finished at 888API, but the provider supplied unsafe download links. Credits were refunded.',
          null);
      }
      throw error;
    }
    return this.complete(db,job,video);
  }
}
module.exports={Api888Queue};

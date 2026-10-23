'use strict';
const {VercelQueue,savedOptions}=require('./vercel_queue.js');
const {Api888Client}=require('./provider/api888.js');
class Api888Queue extends VercelQueue{
  constructor(options={}){super({...options,provider:'api888',clientFactory:options.clientFactory||((o)=>new Api888Client(o))});this.videoTimeoutMs=3*60*60*1000;}
  apiKey(s){return s.api888ApiKey||'';}
  sourceEnabled(s){return Boolean(s.api888Enabled && Number(s.api888UsdCnyRate)>=1 && Number(s.api888UsdCnyRate)<=20);}
  maxInflight(s){return s.api888MaxInflight||2;}
  async submit(db,job,client){
    const options=savedOptions(job),model=await this.getModel('api888',job.model,job.media_type);
    if(!model?.ready)throw new Error('888API model cannot currently accept generation.');
    const refs=await this.references(db,job);
    if(job.media_type==='image'){
      const result=await client.generateImage(model,options,refs);
      return this.complete(db,job,result);
    }
    const id=await client.startVideo(model,options,refs);
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify({requestId:id}),id.slice(0,191),job.id]);
  }
  async pollJob(db,client,job){
    let op={};
    try{op=JSON.parse(job.provider_operation||'{}');}catch{}
    if(!op.requestId)throw new Error('888API operation ID missing.');
    const result=await client.videoStatus(op.requestId);
    if(result.status==='pending')return this.markProcessing(db,job);
    if(result.status==='failed')return this.refund(job.id,'failed','888API could not complete the video. Credits were refunded.',null);
    return this.complete(db,job,await client.videoContent(op.requestId,result.url));
  }
}
module.exports={Api888Queue};

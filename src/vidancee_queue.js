'use strict';
const {ArgoLinkQueue}=require('./argolink_queue.js');
const {savedOptions}=require('./vercel_queue.js');
const {VidanceeClient}=require('./provider/vidancee.js');
const {failureMessage}=require('./provider_errors.js');
class VidanceeQueue extends ArgoLinkQueue{
  constructor(options={}){super({clientFactory:o=>new VidanceeClient(o),...options,provider:'vidancee'});this.videoTimeoutMs=3*60*60*1000;}
  apiKey(s){return JSON.stringify([s.vidanceeEmail||'',s.vidanceePassword||'']);}
  sourceEnabled(s){return Boolean(s.vidanceeEnabled&&s.vidanceeEmail&&s.vidanceePassword);}
  maxInflight(){return 1;}
  // The base queue constructs clients using {apiKey}; override to populate credentials.
  async runOnce(db,settings=null){
    const s=settings||await this.getSettings();this.settings=s;
    const fingerprint=this.apiKey(s);
    if(fingerprint!==this.fingerprint){
      this.fingerprint=fingerprint;
      this.client=s.vidanceeEmail&&s.vidanceePassword?new VidanceeClient({email:s.vidanceeEmail,password:s.vidanceePassword}):null;
    }
    // VercelQueue.runOnce overwrites the client when fingerprint differs.
    // Keep its fingerprint in sync and provide our own credential factory.
    return super.runOnce(db,s);
  }
  submitFailureMessage(e){return failureMessage('video',e?.message);}
  async submit(db,job,client){
    const options=savedOptions(job),model=await this.getModel('vidancee',job.model,job.media_type);
    if(!model?.ready)throw new Error('Omni Flash unavailable.');
    const refs=await this.references(db,job);
    const op=await client.startVideo(model,options,refs);
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify(op),op.requestId,job.id]);
  }
  async pollJob(db,client,job){
    let op={};try{op=JSON.parse(job.provider_operation||'{}')}catch{}
    const state=await client.videoStatus(op);
    if(state.status==='pending')return this.markProcessing(db,job);
    if(state.status==='failed')return this.refund(job.id,'failed',failureMessage('video',state.error),null);
    await this.complete(db,job,await client.download(state.url));
  }
}
module.exports={VidanceeQueue};

'use strict';
const {VercelQueue,savedOptions}=require('./vercel_queue');
const {HuiquClient,payloadFor,fingerprint}=require('./provider/huiqu');
const {syncProviderModels}=require('./provider_models');
const {quoteGateway}=require('./vercel_models');
const {CNY_PER_USD}=require('./billing');
const {getPool}=require('./db');
const {backendFailureMessage}=require('./provider_errors');

class HuiquQueue extends VercelQueue{
  constructor(options={}){
    super({...options,provider:'huiqu',clientFactory:options.clientFactory||((o)=>new HuiquClient(o))});
    this.syncCatalog=options.syncCatalog||((models)=>syncProviderModels('huiqu',models));
  }
  apiKey(s){return s.huiquApiKey||'';}
  sourceEnabled(s){return Boolean(s.huiquEnabled);}
  maxInflight(s){return s.huiquMaxInflight||1;}
  timeoutFor(){return Infinity;}
  async runOnce(db=getPool(),settings=null){
    const current=settings||await this.getSettings();
    const key=this.apiKey(current);
    if(key!==this.fingerprint){this.fingerprint=key;this.client=key?this.clientFactory({apiKey:key}):null;this.refreshAfter=0;}
    if(this.client&&this.sourceEnabled(current)&&!this.refreshTask&&Date.now()>=(this.refreshAfter||0)){
      const client=this.client;
      this.refreshAfter=Date.now()+10*60*1000;
      this.refreshTask=Promise.resolve().then(async()=>{
        const rows=await client.models();
        if(this.fingerprint===key){await this.syncCatalog(rows);this.refreshAfter=Date.now()+60*60*1000;}
      }).catch(e=>this.log(null,'huiqu.catalog_failed',e.message,null,'warn')).finally(()=>{this.refreshTask=null;});
    }
    // The provider does not document idempotent submissions. A persisted
    // marker without a receipt is an ambiguous paid operation: never resubmit.
    await db.execute("UPDATE generations SET status='submitted',error_message='Submission receipt unconfirmed. Contact admin.',updated_at=UTC_TIMESTAMP() WHERE provider='huiqu' AND status='submitting' AND provider_operation IS NOT NULL AND refunded_at IS NULL AND updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MINUTE)");
    return super.runOnce(db,current);
  }
  async submit(db,job,client){
    const options=savedOptions(job);
    const saved=await this.getModel('huiqu',job.model,'video');
    if(!saved?.ready||saved.huiqu?.credential!==fingerprint(client.apiKey))throw new Error('This video model is unavailable.');
    const live=(await client.models()).find(row=>row.providerModelId===saved.providerModelId);
    if(!live?.options.adapterSupported)throw new Error('This video model is no longer available.');
    const model={...live.options,provider:'huiqu',mediaType:'video',providerModelId:live.providerModelId};
    const quote=quoteGateway(model,options);
    if(!Number.isFinite(Number(job.provider_cost))||quote.sourceUsd*CNY_PER_USD>Number(job.provider_cost)+1e-6)
      throw new Error('The video price changed. Refresh and try again.');
    const payload=payloadFor(model,options,await this.references(db,job));
    const op={credential:fingerprint(client.apiKey),submissionPending:true};
    const [savedOp]=await db.execute("UPDATE generations SET provider_operation=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",[JSON.stringify(op),job.id]);
    if(!savedOp.affectedRows)return;
    try{
      const receipt=await client.startVideo(model,payload);
      try{
        await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),error_message=NULL WHERE id=? AND status='submitting' AND refunded_at IS NULL",[JSON.stringify({credential:op.credential,requestId:receipt.requestId}),receipt.requestId,job.id]);
      }catch{throw Object.assign(new Error('Video receipt could not be saved.'),{ambiguous:true});}
    }catch(error){
      if(!error.ambiguous)throw error;
      await db.execute("UPDATE generations SET status='submitted',error_message='Submission receipt unconfirmed. Contact admin.',updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",[job.id]).catch(()=>{});
      this.log(job,'huiqu.submit_unconfirmed','Original paid submission may have been accepted. No retry. Contact provider to reconcile.',null,'warn');
    }
  }
  async pollJob(db,client,job){
    const op=JSON.parse(job.provider_operation||'{}');
    if(op.credential!==fingerprint(client.apiKey))throw new Error('Restore the original provider credential for this task.');
    if(!op.requestId)return;
    const result=await client.videoStatus(op.requestId);
    if(result.status==='failed')return this.refund(job.id,'failed',backendFailureMessage({code:result.errorCode},'The video service failed. CMMTools credits were refunded.'),null);
    if(result.status==='completed'){
      const video=await client.download(op.requestId,result.url);
      try{return await this.complete(db,job,video);}finally{await video.cleanup();}
    }
    return this.markProcessing(db,job);
  }
}
module.exports={HuiquQueue};

'use strict';

const {createHash}=require('node:crypto');
const {VercelQueue,savedOptions}=require('./vercel_queue.js');
const {PureamClient,payloadFor}=require('./provider/puream.js');
const {pureamMediaModels}=require('./puream_models.js');
const {quoteGateway}=require('./vercel_models.js');
const {CNY_PER_USD}=require('./billing.js');
const {syncProviderModels}=require('./provider_models.js');
const {backendFailureMessage}=require('./provider_errors.js');
const {getPool}=require('./db.js');

const fingerprint=key=>createHash('sha256').update(key).digest('hex');
class PureamQueue extends VercelQueue {
  constructor(options={}){
    super({...options,provider:'puream',clientFactory:options.clientFactory||((o)=>new PureamClient(o))});
    this.lastPollAt=0;
    this.refreshAfter=0;
    this.catalogKey='';
    this.syncCatalog=options.syncCatalog||((models)=>syncProviderModels('puream',models));
  }
  apiKey(s){return s.pureamApiKey||'';}
  sourceEnabled(s){return Boolean(s.pureamEnabled);}
  maxInflight(s){return s.pureamMaxInflight||1;}
  // Polling timeouts are not proof of a provider failure or refund. Keep the
  // original task and its reservation until Puream reports a terminal result.
  timeoutFor(){return Infinity;}
  async runOnce(db=getPool(),settings=null){
    const current=settings||await this.getSettings();
    const key=this.apiKey(current);
    // Initialize the same client used for claims so concurrent live catalog
    // checks share one in-flight read and a successful transport fallback.
    if(key!==this.fingerprint){this.fingerprint=key;this.client=key?this.clientFactory({apiKey:key}):null;}
    this.catalogKey=key;
    if(key&&this.sourceEnabled(current)&&!this.catalogRefresh&&(this.refreshKey!==key||Date.now()>=this.refreshAfter)){
      this.refreshKey=key;this.refreshAfter=Date.now()+10*60*1000;
      const client=this.client;
      this.catalogRefresh=Promise.resolve().then(async()=>{
        const models=pureamMediaModels(await client.models());
        if(this.catalogKey!==key)return;
        await this.syncCatalog(models);this.refreshAfter=Date.now()+60*60*1000;
      }).catch(error=>this.log(null,'puream.catalog_failed',error.message,null,'warn')).finally(()=>{this.catalogRefresh=null;});
    }
    // Resume the saved idempotent operation after a worker interruption.
    await db.execute("UPDATE generations SET status='submitted',updated_at=UTC_TIMESTAMP() WHERE provider='puream' AND status='submitting' AND provider_operation IS NOT NULL AND refunded_at IS NULL AND updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MINUTE)");
    return super.runOnce(db,current);
  }
  async pollVideos(db,client){if(Date.now()-this.lastPollAt<10000)return;this.lastPollAt=Date.now();return super.pollVideos(db,client);}
  async submit(db,job,client){
    const options=savedOptions(job);
    const model=await this.getModel('puream',job.model,'video');
    if(!model?.ready)throw new Error('This Puream model is unavailable.');
    let catalog;
    try{catalog=await client.models();}
    catch(error){
      this.log(job,'puream.preflight_failed','Live catalog check failed before video submission.',{code:error.code,transportReason:error.transportReason,responseReason:error.responseReason},'warn');
      throw Object.assign(new Error('Could not connect to the generation service to verify model availability and price. No video was submitted.'),{code:error.code,statusCode:error.statusCode});
    }
    const live=pureamMediaModels(catalog).find(row=>row.providerModelId===model.providerModelId);
    if(!live)throw new Error('This Puream model is no longer available.');
    const fresh={...live.options,providerModelId:live.providerModelId,mediaType:live.mediaType,provider:'puream'};
    const currentQuote=quoteGateway(fresh,options);
    const reserved=Number(job.provider_cost);
    if(!Number.isFinite(reserved)||currentQuote.sourceUsd*CNY_PER_USD>reserved+1e-6)throw new Error('Puream changed the price. Please refresh the model price and try again.');
    const refs=await this.references(db,job);
    const payload=payloadFor({...options,model:fresh},refs);
    const operation={key:'cmm-'+job.id,credential:fingerprint(client.apiKey),payload};
    // A crash after the POST but before the response can be recovered with
    // exactly the same payload and key. The credential itself is not stored.
    const [saved]=await db.execute("UPDATE generations SET provider_operation=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",[JSON.stringify(operation),job.id]);
    if(!saved.affectedRows)return;
    try{await this.accept(db,job,client,operation);}
    catch(error){
      if(!error.ambiguous)throw error;
      await db.execute("UPDATE generations SET status='submitted',updated_at=UTC_TIMESTAMP(),error_message=? WHERE id=? AND status='submitting' AND refunded_at IS NULL",['Waiting for Puream to confirm the original submission.',job.id]).catch(()=>{});
      this.log(job,'puream.submit_unconfirmed','Puream submission unconfirmed; will reconcile the same idempotency key.',null,'warn');
    }
  }
  async accept(db,job,client,operation){
    const accepted=await client.startVideo(operation.payload,operation.key);
    const next={requestId:accepted.requestId,key:operation.key,credential:operation.credential};
    try{
      await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=COALESCE(started_at,UTC_TIMESTAMP()),updated_at=UTC_TIMESTAMP(),error_message=NULL WHERE id=? AND status IN ('submitting','submitted','processing') AND refunded_at IS NULL",[JSON.stringify(next),accepted.requestId,job.id]);
    }catch{throw Object.assign(new Error('Puream submission was accepted but the receipt could not be saved.'),{ambiguous:true});}
    this.log(job,'puream.accepted','Puream accepted the video task.',{taskId:accepted.requestId,quotedCny:Number.isFinite(accepted.quotedCny)?accepted.quotedCny:null});
  }
  async pollJob(db,client,job){
    const op=JSON.parse(job.provider_operation||'{}');
    if(op.credential!==fingerprint(client.apiKey))throw new Error('Puream credential changed; restore the original account for this task.');
    if(!op.requestId){
      if(!op.payload||!this.sourceReady) return;
      // Repeat only the identical saved operation. Never create a second paid task.
      await this.accept(db,job,client,op);return;
    }
    const result=await client.videoStatus(op.requestId);
    if(result.status==='failed'&&result.billingStatus==='not_charged'){
      this.log(job,'puream.failed','Puream confirmed the original generation failed without a charge.',{code:result.errorCode});
      return this.refund(job.id,'failed',backendFailureMessage({code:result.errorCode},'The video service failed. CMMTools credits were refunded.'),null);
    }
    if(result.status==='completed'&&['charged','not_charged'].includes(result.billingStatus)){
      if(result.chargeCny!==null&&Number.isFinite(result.chargeCny)&&result.chargeCny>=0)
        await db.execute("UPDATE generations SET provider_cost=?,provider_cost_unit='cny' WHERE id=? AND refunded_at IS NULL",[result.chargeCny,job.id]);
      const output=await client.download(op.requestId);
      try {return await this.complete(db,job,output);}finally {await output.cleanup();}
    }
    await this.markProcessing(db,job);
  }
}
module.exports={PureamQueue};

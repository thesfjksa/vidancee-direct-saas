'use strict';
const {VercelQueue,savedOptions}=require('./vercel_queue');
const {HuiquClient,HuiquGroupPool,payloadFor,fingerprint}=require('./provider/huiqu');
const {signature,credentials}=require('./huiqu_credentials');
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
  apiKey(s){return signature(s);}
  sourceEnabled(s){return Boolean(s.huiquEnabled&&credentials(s,{activeOnly:true}).length);}
  maxInflight(s){return s.huiquMaxInflight||1;}
  timeoutFor(){return Infinity;}
  async runOnce(db=getPool(),settings=null){
    const current=settings||await this.getSettings();
    const key=this.apiKey(current);
    if(key!==this.fingerprint){this.fingerprint=key;this.client=key?new HuiquGroupPool(current,{clientFactory:this.clientFactory}):null;this.refreshAfter=0;}
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
    if(!saved?.ready)throw new Error('This video model is unavailable.');
    // The group selected when quoted must still be active. Never switch a
    // queued or in-flight paid request silently to another key.
    const credential=options.model?.huiqu?.credential||saved.huiqu?.credential;
    const selected=client.forCredential?client.forCredential(credential,{activeOnly:true}):client;
    if(!selected||credential!==fingerprint(selected.apiKey))throw new Error('This video model group is unavailable.');
    client=selected;
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
      if(!error.ambiguous){
        if(error.providerStatus===400)this.log(job,'huiqu.submit_rejected','Video request rejected by upstream',{failureType:error.failureType||'unspecified_rejection',model:saved.providerModelId,duration:options.duration,resolution:options.resolution,aspectRatio:options.aspectRatio,route:model.huiqu.route},'warn');
        throw error;
      }
      await db.execute("UPDATE generations SET status='submitted',error_message='Submission receipt unconfirmed. Contact admin.',updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",[job.id]).catch(()=>{});
      this.log(job,'huiqu.submit_unconfirmed','Original paid submission may have been accepted. No retry. Contact provider to reconcile.',null,'warn');
    }
  }
  submitFailureMessage(error){
    if(error.providerStatus===400){
      const reason={
        duration_rejected:'The video service rejected the selected duration.',
        resolution_rejected:'The video service rejected the selected resolution.',
        aspect_ratio_rejected:'The video service rejected the selected aspect ratio.',
        reference_or_media_rejected:'The video service rejected the reference or media settings.',
        group_or_permission_rejected:'The video service rejected access to this model. Contact admin.',
        model_unavailable:'The video model is currently unavailable.'
      }[error.failureType]||'The video service rejected this request. Contact admin.';
      return reason+' Credits were refunded.';
    }
    return super.submitFailureMessage(error);
  }
  async pollJob(db,client,job){
    const op=JSON.parse(job.provider_operation||'{}');
    client=client.forCredential?client.forCredential(op.credential):client;
    if(!client||op.credential!==fingerprint(client.apiKey))throw new Error('Restore the original provider credential for this task.');
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
function heldHuiquSubmission(job){
  if(!job||job.provider!=='huiqu'||job.media_type!=='video'||job.status!=='submitted'||job.refunded_at||job.provider_job_id)return false;
  try{
    const op=typeof job.provider_operation==='string'?JSON.parse(job.provider_operation):job.provider_operation;
    return op?.submissionPending===true&&!op.requestId&&/^[a-f0-9]{64}$/.test(op.credential||'');
  }catch{return false;}
}
// Admin confirmation is based on provider history; never submit a replacement.
async function refundHeldHuiqu(db,id,input,refund=require('./generations').refundGeneration){
  const bad=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
  if(input?.confirmedNoAcceptedTask!==true||input?.confirmedNoCharge!==true)
    throw bad('Confirm that provider task history contains no accepted task and no charge.',400);
  const conn=await db.getConnection(),name='cmm_job_'+id;
  let locked=false;
  try{
    const [[lock]]=await conn.query('SELECT GET_LOCK(?,0) AS acquired',[name]);
    locked=Number(lock?.acquired)===1;
    if(!locked)throw bad('Generation is busy. Refresh and try again.');
    const [[job]]=await conn.query('SELECT * FROM generations WHERE id=?',[id]);
    if(!heldHuiquSubmission(job))throw bad('Only an unrefunded held submission without a provider task ID can be reconciled.');
    if(!await refund(id,'submit_error','Admin confirmed no accepted provider task or charge. Credits were refunded.',0))
      throw bad('Generation no longer exists.');
    return {reconciled:true,creditsRefunded:Number(job.credits_cost)};
  }finally{
    if(locked)await conn.query('SELECT RELEASE_LOCK(?)',[name]).catch(()=>{});
    conn.release();
  }
}
module.exports={HuiquQueue,heldHuiquSubmission,refundHeldHuiqu};

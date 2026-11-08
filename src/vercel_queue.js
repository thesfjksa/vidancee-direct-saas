'use strict';

const {getPool}=require('./db.js');
const {getProviderSettings}=require('./settings.js');
const {getProviderModelByPublicId}=require('./provider_models.js');
const {VercelGatewayClient}=require('./provider/vercel.js');
const {providerAssetUrl}=require('./provider/assets.js');
const {refundGeneration}=require('./generations.js');
const {saveVideoOutput}=require('./video_outputs.js');
const {looksOutOfCredits}=require('./cartoon.js');
const {logActivity,errorDetails}=require('./activity_log.js');

function savedOptions(job) {
  let options;
  try {options=JSON.parse(job.generation_options||'{}');} catch {}
  if(!options?.model?.providerModelId)throw new Error('This queued generation has no saved model settings.');
  return {...options,id:job.id,prompt:job.prompt};
}

class VercelQueue {
  constructor({getSettings=getProviderSettings,getModel=getProviderModelByPublicId,refund=refundGeneration,
    clientFactory=opts=>new VercelGatewayClient(opts),provider='vercel',failover=null}={}) {
    // failover: {isOut(source), markOut(source), move(db,job)} moves image jobs
    // to ArgoLink when this source has run out of credits.
    this.provider=provider;this.failover=failover;this.loggedPollErrors=new Set();this.videoTimeoutMs=45*60*1000;this.getSettings=getSettings;this.getModel=getModel;this.refund=refund;this.clientFactory=clientFactory;
    this.stopped=true;this.running=false;this.tasks=new Set();this.client=null;this.fingerprint='';
    this.lastStartedAt=null;this.lastFinishedAt=null;this.lastSuccessfulAt=null;this.sourceReady=false;
  }
  start(){this.stopped=false;this.schedule(700);}
  stop(){this.stopped=true;clearTimeout(this.timer);}
  // Lets in-flight image requests finish before the process exits (for example
  // during a redeploy), so a nearly finished image is saved instead of lost.
  async drain(timeoutMs=25000){
    const deadline=Date.now()+timeoutMs;
    while(this.tasks.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));
    return this.tasks.size;
  }
  schedule(delay=5000){if(!this.stopped)this.timer=setTimeout(()=>this.tick(),delay);}
  async tick(){
    if(this.running)return;
    this.running=true;this.lastStartedAt=new Date().toISOString();
    try{await this.runOnce();this.lastSuccessfulAt=new Date().toISOString();}
    catch(error){console.error(this.provider+' queue tick failed:',error.message);
      logActivity({level:'error',category:'system',event:'queue.tick_failed',provider:this.provider,message:error.message,details:errorDetails(error)});}
    finally{this.running=false;this.lastFinishedAt=new Date().toISOString();this.schedule();}
  }
  health(){return {enabled:!this.stopped,running:this.running,lastStartedAt:this.lastStartedAt,
    lastFinishedAt:this.lastFinishedAt,lastSuccessfulAt:this.lastSuccessfulAt,sourceReady:this.sourceReady,activeTasks:this.tasks.size};}
  // Source settings; ArgoLinkQueue overrides these three.
  apiKey(s){return s.vercelApiKey||'';}
  sourceEnabled(s){return Boolean(s.vercelEnabled);}
  maxInflight(s){return s.vercelMaxInflight||2;}
  reservedSlots(){return 0;}
  async runOnce(db=getPool(),settings=null) {
    const current=settings||await this.getSettings();
    const fingerprint=this.apiKey(current);
    if(fingerprint!==this.fingerprint){this.fingerprint=fingerprint;this.client=fingerprint?this.clientFactory({apiKey:fingerprint}):null;}
    this.sourceReady=Boolean(this.client&&this.sourceEnabled(current)&&current.allowProviderCharges);
    const provider=this.provider;
    // Heartbeat: every tick marks this worker's in-flight requests as alive, so a
    // claim left behind by a restarted or killed worker is recognised quickly
    // instead of showing "Processing" for ten minutes.
    if(this.tasks.size)await db.query(`UPDATE generations SET updated_at=UTC_TIMESTAMP() WHERE provider='${provider}'
      AND status IN ('submitting','processing') AND refunded_at IS NULL AND id IN (?)`,[[...this.tasks]]);
    // Recovery never repeats a paid start request. Resumable operations are
    // persisted before the first poll; ambiguous starts are refunded instead.
    const [stale]=await db.query(`SELECT id FROM generations WHERE provider='${provider}'
      AND refunded_at IS NULL AND ((status='submitting' AND updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MINUTE))
      OR (media_type='image' AND status='processing' AND updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MINUTE))) LIMIT 20`);
    for(const job of stale)if(!this.tasks.has(job.id))await this.refund(job.id,'submit_error','Generation was interrupted. Credits were refunded.',null);
    if(this.client)await this.pollVideos(db,this.client);
    if(this.sourceReady)await this.claim(db,this.maxInflight(current),this.client);
  }
  // Queued jobs this source may start: active customer with access, and the
  // model still visible in Admin.
  queuedSql() {
    const provider=this.provider;
    return `SELECT g.* FROM generations g
        JOIN users u ON u.id=g.user_id AND u.status='active'
        JOIN provider_models m ON m.public_model_id=g.model AND m.provider='${provider}' AND m.media_type=g.media_type AND m.enabled=1 AND m.available=1
        LEFT JOIN user_provider_access a ON a.user_id=g.user_id AND a.provider='${provider}'
        WHERE g.provider='${provider}' AND g.status='queued' AND COALESCE(a.enabled,1)=1
        ORDER BY g.queue_priority DESC,g.created_at ASC LIMIT 20`;
  }
  async claim(db,maxInflight,client) {
    const conn=await db.getConnection();let locked=false;const claimed=[];const provider=this.provider;
    try {
      const [[lock]]=await conn.query(`SELECT GET_LOCK('cmm_${provider}_queue',0) AS acquired`);
      locked=Number(lock?.acquired)===1;if(!locked)return;
      const [[active]]=await conn.query(`SELECT COUNT(*) AS total FROM generations WHERE provider='${provider}' AND status IN ('submitting','submitted','processing')`);
      let slots=Math.max(0,maxInflight-Number(active?.total||0)-await this.reservedSlots(conn));if(!slots)return;
      const [queued]=await conn.query(this.queuedSql());
      for(const job of queued) {
        if(slots<=0)break;
        const [result]=await conn.execute(`UPDATE generations SET status=?,submitted_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),error_message=NULL WHERE id=? AND provider='${provider}' AND status='queued'`,
          [job.media_type==='image'?'processing':'submitting',job.id]);
        if(result.affectedRows){claimed.push(job);slots--;}
      }
    } finally {if(locked)await conn.query(`SELECT RELEASE_LOCK('cmm_${provider}_queue')`);conn.release();}
    for(const job of claimed) {
      this.tasks.add(job.id);
      this.log(job,'job.started','Sent to '+this.provider+' ('+job.model+')');
      // Long requests run outside the polling loop. Catch every task failure so
      // an unavailable model cannot terminate the worker or strand the wallet.
      Promise.resolve().then(()=>this.submit(db,job,client))
        .catch(async error=>{this.log(job,'job.submit_failed',error.message,errorDetails(error),'error');
          try{await this.refund(job.id,'failed',this.submitFailureMessage(error,job),null);}
          catch{console.error(this.provider+' generation refund will be retried by recovery:',job.id);}})
        .finally(()=>this.tasks.delete(job.id));
    }
  }
  // What the customer reads when a job cannot be sent to the source.
  submitFailureMessage(error) {
    return error.message||'Generation failed. Credits were refunded.';
  }
  async references(db,job) {
    if(job.media_type==='image'){
      const [images]=await db.execute('SELECT position_index,mime_type FROM generation_images WHERE generation_id=? ORDER BY position_index',[job.id]);
      return images.map(i=>({url:providerAssetUrl(job.id,i.position_index),mimeType:i.mime_type}));
    }
    const [media]=await db.execute('SELECT position_index,media_kind,media_role,mime_type FROM generation_media WHERE generation_id=? ORDER BY position_index',[job.id]);
    return media.map(m=>({url:providerAssetUrl(job.id,m.position_index).replace('/provider-assets/','/provider-media/'),
      mimeType:m.mime_type,role:m.media_role}));
  }
  async submit(db,job,client) {
    const options=savedOptions(job),model=await this.getModel(this.provider,job.model,job.media_type);
    if(!model?.ready)throw new Error('This model is currently unavailable. Credits were refunded.');
    const references=await this.references(db,job);
    if(job.media_type==='image') {
      const handOver=async()=>Boolean(this.failover&&await this.failover.move(db,job));
      if(this.failover?.isOut(this.provider)&&await handOver())return;
      let output;
      try{output=await client.generateImage(options.model,options,references);}
      catch(error){
        if(this.failover&&looksOutOfCredits(error)){this.failover.markOut(this.provider);if(await handOver())return;}
        throw error;
      }
      await this.complete(db,job,output);return;
    }
    const result=await client.startVideo(options.model,options,references);
    const jobId=result.providerMetadata?.gateway?.asyncJob?.jobId||null;
    await db.execute("UPDATE generations SET status='submitted',provider_operation=?,provider_job_id=?,started_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status='submitting' AND refunded_at IS NULL",
      [JSON.stringify(result.operation),jobId?String(jobId).slice(0,191):null,job.id]);
  }
  // How long a submitted video may take before it is refunded.
  timeoutFor() {
    return this.videoTimeoutMs;
  }
  async pollVideos(db,client) {
    const [jobs]=await db.query(`SELECT * FROM generations WHERE provider='${this.provider}' AND media_type='video'
      AND status IN ('submitted','processing') AND refunded_at IS NULL ORDER BY updated_at ASC LIMIT 12`);
    for(const job of jobs) {
      if(this.tasks.has(job.id))continue;
      const stamp=job.submitted_at||job.created_at;
      const age=Date.now()-(stamp instanceof Date?stamp.getTime():Date.parse(String(stamp).replace(' ','T')+'Z'));
      if(age>this.timeoutFor(job)){await this.refund(job.id,'failed','Video generation timed out. Credits were refunded.',null);continue;}
      this.tasks.add(job.id);
      Promise.resolve().then(()=>this.exclusive(db,job,fresh=>this.pollJob(db,client,fresh))).catch(async error=>{
        // Logged once per distinct message, not on every 5-second poll.
        const key=job.id+':'+error.message;
        if(!this.loggedPollErrors.has(key)){this.loggedPollErrors.add(key);if(this.loggedPollErrors.size>500)this.loggedPollErrors.clear();
          this.log(job,'job.poll_failed',error.message,errorDetails(error),'warn');}
        // Poll/download failures keep the saved operation for another read.
        // No new generation is submitted while waiting for the original job.
        await db.execute("UPDATE generations SET updated_at=UTC_TIMESTAMP(),error_message=? WHERE id=? AND status IN ('submitted','processing') AND refunded_at IS NULL",
          ['Waiting for the video service. Your generation will resume automatically.',job.id]).catch(()=>{});
      }).finally(()=>this.tasks.delete(job.id));
    }
  }
  // Hostinger can run more than one worker process. Polling, retries and the
  // HD-enhancement step must happen once per job, so each poll holds a
  // per-job MySQL lock and works on a fresh copy of the job row.
  async exclusive(db,job,fn) {
    if(typeof db.getConnection!=='function')return fn(job);
    const conn=await db.getConnection(),name='cmm_job_'+job.id;let locked=false;
    try {
      const [[row]]=await conn.query('SELECT GET_LOCK(?,0) AS acquired',[name]);
      locked=Number(row?.acquired)===1;if(!locked)return;
      const [[fresh]]=await conn.query('SELECT * FROM generations WHERE id=?',[job.id]);
      if(!fresh||fresh.refunded_at||!['submitted','processing'].includes(fresh.status))return;
      return await fn(fresh);
    } finally {
      if(locked)await conn.query('SELECT RELEASE_LOCK(?)',[name]).catch(()=>{});
      conn.release();
    }
  }
  async pollJob(db,client,job) {
    const options=savedOptions(job);
    if(!job.provider_operation)throw new Error('The video operation could not be resumed.');
    const result=await client.videoStatus(options.model.providerModelId,JSON.parse(job.provider_operation));
    if(result.status==='completed') {
      const output=await client.videoOutput(result.videos?.[0]);await this.complete(db,job,output);
    } else if(result.status==='error'||result.status==='cancelled') {
      await this.refund(job.id,'failed','The video model could not complete this request. Credits were refunded.',null);
    } else if(result.status==='pending') await this.markProcessing(db,job);
    else throw Object.assign(new Error('The video status was temporarily unavailable.'),{retryable:true});
  }
  async markProcessing(db,job) {
    await db.execute("UPDATE generations SET status='processing',updated_at=UTC_TIMESTAMP() WHERE id=? AND status IN ('submitted','processing') AND refunded_at IS NULL",[job.id]);
  }
  async complete(db,job,output) {
    // Generated images go to cloud storage when enabled (the BLOB keeps a tag).
    const imageData=job.media_type==='image'?await require('./object_storage.js').offloadBlob('images/'+job.id,output.data,output.mimeType):null;
    const conn=await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[current]]=await conn.execute('SELECT status,refunded_at FROM generations WHERE id=? FOR UPDATE',[job.id]);
      if(!current||current.refunded_at||!['submitting','submitted','processing'].includes(current.status)){await conn.rollback();return;}
      if(job.media_type==='image')await conn.execute('INSERT INTO generation_image_outputs (generation_id,mime_type,image_data) VALUES (?,?,?)',[job.id,output.mimeType,imageData]);
      const videoStorage=job.media_type==='image'?null:await saveVideoOutput(conn,job.id,output);
      await conn.execute("UPDATE generations SET status='completed',output_url=?,completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP(),error_message=NULL WHERE id=?",
        [job.media_type==='image'?'db:image':videoStorage,job.id]);
      await conn.commit();
      this.log(job,'job.completed','Completed',{bytes:output.data?.length,mimeType:output.mimeType});
    } catch(error){await conn.rollback();throw error;}finally{conn.release();}
  }
  log(job,event,message,details=null,level='info') {
    logActivity({level,category:'provider',event,userId:job?.user_id,generationId:job?.id,provider:this.provider,message,details});
  }
}

module.exports={VercelQueue,savedOptions};


'use strict';

const http = require('node:http');
const { dbConfigured, initDb, getPool } = require('./src/db.js');
const { recordBoot } = require('./src/runtime_diagnostics.js');
const { GenerationWorker } = require('./src/worker_admin_settings.js');
const { ensureGatewayCatalog } = require('./src/provider_models.js');
const { setActivityService, logActivity, pruneActivity } = require('./src/activity_log.js');
setActivityService('worker');
const { migrateLegacyProviderEnvSettings } = require('./src/settings.js');
const {startDriveMigrationLoop}=require('./src/google_drive_migration.js');

let worker=null;
let stopDriveMigration=null;
let stopping=false;
let healthServer=null;
const port=Number(process.env.PORT||3000);
const host=process.env.HOST||'0.0.0.0';

function logRuntime(prefix){
  const mem=process.memoryUsage();
  console.log(prefix,{
    pid:process.pid,
    uptimeSeconds:Math.round(process.uptime()),
    rssMb:Math.round(mem.rss/1024/1024),
    heapUsedMb:Math.round(mem.heapUsed/1024/1024),
  });
}

process.on('unhandledRejection',reason=>{
  console.error('[worker] unhandled rejection',reason);
  logRuntime('[worker] runtime');
});

process.on('uncaughtExceptionMonitor',(error,origin)=>{
  console.error('[worker] uncaught exception',origin,error);
  logRuntime('[worker] runtime');
});

function shutdown(signal){
  if(stopping)return;
  stopping=true;
  console.warn('[worker] shutdown',signal);
  logActivity({category:'system',event:'worker.stopping',message:'Worker stopping ('+signal+', pid '+process.pid+', up '+Math.round(process.uptime())+' s)'});
  try{worker?.stop?.()}catch{}
  try{stopDriveMigration?.()}catch{}
  try{healthServer?.close?.()}catch{}
  // Give in-flight image requests a short window to finish and save. Anything
  // still running is recovered (refunded) by the next worker via its heartbeat.
  const smartTasks=[...(worker?.smartImageTasks||[])];
  const smartDone=Promise.race([Promise.allSettled(smartTasks),new Promise(resolve=>setTimeout(resolve,SHUTDOWN_DRAIN_MS).unref())]);
  Promise.all([Promise.resolve(worker?.vercelQueue?.drain?.(SHUTDOWN_DRAIN_MS)).catch(()=>0),smartDone,
    Promise.resolve(worker?.argoLinkQueue?.drain?.(SHUTDOWN_DRAIN_MS)).catch(()=>0),
    Promise.resolve(worker?.higgsfieldQueue?.drain?.(SHUTDOWN_DRAIN_MS)).catch(()=>0),
    Promise.resolve(worker?.upscaleQueue?.drain?.(SHUTDOWN_DRAIN_MS)).catch(()=>0),
    Promise.resolve(worker?.sluiceQueue?.drain?.(SHUTDOWN_DRAIN_MS)).catch(()=>0)]).then(([left,,argoLeft,higgsfieldLeft,upscaleLeft,sluiceLeft])=>{
    left=(left||0)+(argoLeft||0)+(higgsfieldLeft||0)+(upscaleLeft||0)+(sluiceLeft||0)+(worker?.smartImageTasks?.size||0);
    if(left)console.warn('[worker] exiting with',left,'image request(s) still running');
    setTimeout(()=>process.exit(0),150).unref();
  });
}
const SHUTDOWN_DRAIN_MS=Math.max(0,Number(process.env.WORKER_SHUTDOWN_DRAIN_MS||25000));
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

// Hostinger starts this app on the first request to its address and stops a
// process that has not opened its port within a few seconds. The health
// server therefore listens before the slower startup below (database, catalog),
// so a fresh worker is not stopped while it holds a job.
healthServer=http.createServer((req,res)=>{
  if(req.url==='/health' || req.url==='/live' || req.url==='/'){
    const body=JSON.stringify(!worker?{ok:true,service:'mehroz-ai-worker',pid:process.pid,uptimeSeconds:Math.round(process.uptime()),revision:6,starting:true}:{
      ok:true,
      service:'mehroz-ai-worker',
      pid:process.pid,
      uptimeSeconds:Math.round(process.uptime()),
      revision:6,
      gatewayPolling:worker.vercelQueue.health(),
      api888Polling:worker.api888Queue.health(),
      argoLinkPolling:worker.argoLinkQueue.health(),
      higgsfieldPolling:worker.higgsfieldQueue.health(),
      sluicePolling:worker.sluiceQueue.health(),
      upscalePolling:worker.upscaleQueue.health(),
      workerEnabled:worker.enabled(),
      polling:{running:worker.running,lastStartedAt:worker.lastTickStartedAt,lastFinishedAt:worker.lastTickFinishedAt},
      imagePolling:{enabled:worker.smartImageLaneActive,running:worker.smartImageRunning,
        lastStartedAt:worker.lastSmartTickStartedAt,lastFinishedAt:worker.lastSmartTickFinishedAt,
        lastSuccessfulAt:worker.lastSmartTickSucceededAt,
        sourceReady:Boolean(worker.smartImageAllowCharges&&worker.smartAipiEnabled&&worker.smartAipi),
        activeTasks:worker.smartImageTasks.size},
    });
    res.writeHead(200,{
      'content-type':'application/json',
      'content-length':Buffer.byteLength(body),
      'cache-control':'no-store',
    });
    return res.end(body);
  }
  res.writeHead(404,{'content-type':'application/json'});
  res.end('{"ok":false,"error":"Not found"}');
});
healthServer.listen(port,host,()=>{
  console.log('[worker] health server listening on '+host+':'+port);
});

(async()=>{
  if(!dbConfigured()) throw new Error('Worker cannot start because MySQL is not configured.');
  await initDb();
  await recordBoot(getPool(),'worker').catch(error=>console.error('[worker] boot record failed:',error.message));
  logActivity({category:'system',event:'worker.started',message:'Worker started (pid '+process.pid+')'});
  // Activity older than 30 days is removed hourly.
  pruneActivity(getPool());setInterval(()=>pruneActivity(getPool()),60*60*1000).unref();
  await migrateLegacyProviderEnvSettings();
  await require('./src/api888_access.js').disableApi888ForUsersOnce(getPool());
  await ensureGatewayCatalog().catch(error=>console.error('Gateway catalog initialization failed:',error.message));
  worker=new GenerationWorker();
  worker.start();
  // One background, resumable migration job at a time. Never deletes chunks
  // until Google Drive has verified the uploaded file and its MD5 checksum.
  stopDriveMigration=startDriveMigrationLoop({db:getPool()});

  logRuntime('[worker] started');
  if(process.send)process.send({type:'ready',pid:process.pid});
})().catch(error=>{
  console.error('[worker] startup failed',error);
  process.exitCode=1;
  setTimeout(()=>process.exit(1),250).unref();
});



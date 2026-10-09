'use strict';

const http = require('node:http');
const { dbConfigured, initDb } = require('./src/db.js');
const { GenerationWorker } = require('./src/worker_admin_settings.js');
const { migrateLegacyProviderEnvSettings } = require('./src/settings.js');

let worker=null;
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
  try{worker?.stop?.()}catch{}
  try{healthServer?.close?.()}catch{}
  setTimeout(()=>process.exit(0),150).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

(async()=>{
  if(!dbConfigured()) throw new Error('Worker cannot start because MySQL is not configured.');
  await initDb();
  await migrateLegacyProviderEnvSettings();
  worker=new GenerationWorker();
  worker.start();

  healthServer=http.createServer((req,res)=>{
    if(req.url==='/health' || req.url==='/live' || req.url==='/'){
      const body=JSON.stringify({
        ok:true,
        service:'mehroz-ai-worker',
        pid:process.pid,
        uptimeSeconds:Math.round(process.uptime()),
        revision:4,
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

  logRuntime('[worker] started');
  if(process.send)process.send({type:'ready',pid:process.pid});
})().catch(error=>{
  console.error('[worker] startup failed',error);
  process.exitCode=1;
  setTimeout(()=>process.exit(1),250).unref();
});


'use strict';

const { dbConfigured, initDb } = require('./src/db.js');
const { GenerationWorker } = require('./src/worker_admin_settings.js');
const { migrateLegacyProviderEnvSettings } = require('./src/settings.js');

let worker=null;
let stopping=false;

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
  logRuntime('[worker] started');
  if(process.send)process.send({type:'ready',pid:process.pid});
})().catch(error=>{
  console.error('[worker] startup failed',error);
  process.exitCode=1;
  setTimeout(()=>process.exit(1),250).unref();
});

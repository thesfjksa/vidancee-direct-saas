'use strict';
const {BASE_URL,publicId}=require('./huiqu_models');
const {huiquPerformance:localPerformance}=require('./puream_performance');
const {readBounded}=require('./provider/vercel');
const known=require('./provider/huiqu_catalog.json');
const REFRESH_MS=600000;
function createHuiquPerformance({fetchImpl=fetch,now=Date.now}={}){
  let snapshot={updatedAt:null,stale:true,models:{}},next=0,pending;
  async function refresh(){
    try{
      const response=await fetchImpl(BASE_URL+'/api/perf-metrics/summary?hours=24',{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw Error('Performance unavailable');
      const body=JSON.parse((await readBounded(response,8*1024*1024)).toString('utf8'));
      if(body?.success!==true||!Array.isArray(body.data?.models))throw Error('Invalid performance response');
      const models={};
      for(const row of body.data.models){
        if(typeof row?.model_name!=='string'||!Object.hasOwn(known,row.model_name))continue;
        const successRate=Number.isFinite(row.success_rate)&&row.success_rate>=0&&row.success_rate<=100?row.success_rate:null;
        const averageLatencyMs=Number.isFinite(row.avg_latency_ms)&&row.avg_latency_ms>0?row.avg_latency_ms:null;
        if(successRate===null&&averageLatencyMs===null)continue;
        models[publicId(row.model_name)]={successRate,averageLatencyMs,source:'provider'};
      }
      snapshot={updatedAt:new Date(now()).toISOString(),stale:false,models};
    }catch{snapshot={...snapshot,stale:true};}
    return snapshot;
  }
  return ()=>{
    if(pending)return pending;
    if(now()<next)return Promise.resolve(snapshot);
    next=now()+REFRESH_MS;
    pending=refresh().finally(()=>{pending=null;});
    return pending;
  };
}
const upstream=createHuiquPerformance();
async function huiquCombinedPerformance(db){
  const [provider,local]=await Promise.all([upstream(),localPerformance(db)]);
  const models={...provider.models};
  for(const [id,metric] of Object.entries(local.models)){
    models[id]=models[id]?{...models[id],local:metric}:{...metric,source:'local'};
  }
  return {...provider,models};
}
module.exports={createHuiquPerformance,huiquCombinedPerformance};

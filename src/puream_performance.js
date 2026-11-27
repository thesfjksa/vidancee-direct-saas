'use strict';
// Real CMMTools jobs, rather than claiming the upstream catalog is a status dashboard.
async function generationPerformance(db,provider){
  const [rows]=await db.query(`SELECT model,COUNT(*) AS samples,SUM(status='completed') AS successes,
    AVG(CASE WHEN status='completed' AND submitted_at IS NOT NULL AND completed_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND,submitted_at,completed_at)/1000 END) AS averageLatencyMs
    FROM generations WHERE provider=? AND submitted_at>=UTC_TIMESTAMP()-INTERVAL 1 DAY
      AND provider_job_id IS NOT NULL AND status IN ('completed','failed','submit_error') GROUP BY model`,[provider]);
  return {updatedAt:new Date().toISOString(),stale:false,models:Object.fromEntries(rows.map(row=>[row.model,{
    successRate:Number(row.successes)/Number(row.samples)*100,averageLatencyMs:row.averageLatencyMs==null?null:Number(row.averageLatencyMs),samples:Number(row.samples),
  }]))};
}
const pureamPerformance=db=>generationPerformance(db,'puream');
const huiquPerformance=db=>generationPerformance(db,'huiqu');
module.exports={pureamPerformance,huiquPerformance};

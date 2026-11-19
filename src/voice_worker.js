'use strict';
async function submit(client,db,job){
 const params=JSON.parse(job.provider_meta||'{}'),operation=params.operation||'speech';let result;
 if(operation==='dialogue')result=await client.dialogue(params.dialogue);
 else if(operation==='voice-changer'||operation==='dubbing'){
  const [chunks]=await db.query('SELECT input_data FROM voice_input_chunks WHERE generation_id=? ORDER BY position_index',[job.id]);
  const bytes=chunks.reduce((n,c)=>n+c.input_data.length,0);
  if(!bytes||bytes>100*1024*1024)throw Object.assign(Error('Voice source file is unavailable.'),{definitive:true});
  const file={...params.file,data:Buffer.concat(chunks.map(c=>c.input_data),bytes)};
  result=operation==='dubbing'?await client.dubbing({...params,file}):await client.voiceChanger({...params,file});
 }else result=await client.textToSpeech({...params,text:job.prompt,exportTranscript:false});
 const id=String(result?.id||result?.task_id||'');
 if(!id)throw Error('Voice provider did not return a task ID. Review before retrying.');
 return id;
}
async function poll(client,row){const params=JSON.parse(row.provider_meta||'{}');return client.getToolHistory(row.provider_job_id,params.operation||'speech');}
module.exports={submit,poll};

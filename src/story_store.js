'use strict';
const crypto=require('node:crypto');
const fail=(code,message)=>Object.assign(new Error(message),{statusCode:code});
const SCHEMA=[
`CREATE TABLE IF NOT EXISTS stories (id CHAR(36) PRIMARY KEY,user_id BIGINT UNSIGNED NOT NULL,request_key VARCHAR(80) NOT NULL,prompt TEXT NOT NULL,options_json MEDIUMTEXT NOT NULL,state_json MEDIUMTEXT NOT NULL,status VARCHAR(30) NOT NULL DEFAULT 'queued',error_message VARCHAR(500) NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY story_request(user_id,request_key),KEY story_queue(status,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
`CREATE TABLE IF NOT EXISTS story_steps (story_id CHAR(36) NOT NULL,step_key VARCHAR(80) NOT NULL,generation_id CHAR(36) NOT NULL,PRIMARY KEY(story_id,step_key),UNIQUE KEY story_generation(generation_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
`CREATE TABLE IF NOT EXISTS story_output_chunks (story_id CHAR(36) NOT NULL,position_index INT UNSIGNED NOT NULL,video_data MEDIUMBLOB NOT NULL,PRIMARY KEY(story_id,position_index)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];
async function beginStep(conn,userId,c){
 const [[story]]=await conn.execute('SELECT * FROM stories WHERE id=? AND user_id=? FOR UPDATE',[c.storyId,userId]);
 if(!story||story.status!=='running')throw fail(409,'Story is not running.');
 const [[step]]=await conn.execute('SELECT generation_id FROM story_steps WHERE story_id=? AND step_key=?',[c.storyId,c.stepKey]);
 if(!step)return null;
 const [[generation]]=await conn.execute('SELECT * FROM generations WHERE id=? AND user_id=?',[step.generation_id,userId]);
 if(!generation)throw fail(409,'A story output was deleted. Start a new story.');
 return generation;
}
async function get(db,userId,id){const [[r]]=await db.execute('SELECT * FROM stories WHERE id=? AND user_id=?',[id,userId]);if(!r)throw fail(404,'Story not found.');return r;}
async function create(db,userId,body,quote){
 const prompt=String(body.prompt||'').trim(),key=String(body.requestKey||'');
 const tier=require('./story_tiers').storyTier(body.tier),aspectRatio=String(body.aspectRatio||'16:9');
 if(!quote||quote.id!==tier.id||quote.duration!==tier.duration||!Number.isFinite(quote.credits)||quote.credits<=0)throw fail(503,'Story pricing is unavailable.');
 if(Object.hasOwn(body,'maxCredits'))throw fail(400,'Choose a story duration tier; a credit limit is not required.');
 if(!prompt||prompt.length>5000||!/^[\w-]{8,80}$/.test(key)||!['16:9','9:16'].includes(aspectRatio))throw fail(400,'Provide a prompt, valid request key, duration tier and video format.');
 const options={tier:tier.id,estimatedCredits:quote.credits,priceBreakdown:quote.breakdown,videoModel:quote.videoModel,imageModel:quote.imageModel,aspectRatio,language:'en',duration:tier.duration,resolution:'768p'};
 const conn=await db.getConnection();try{
 await conn.beginTransaction();
 const [[user]]=await conn.execute('SELECT id,status,credits FROM users WHERE id=? FOR UPDATE',[userId]);
 if(user?.status!=='active')throw fail(403,'Account unavailable.');
 const [[old]]=await conn.execute('SELECT * FROM stories WHERE user_id=? AND request_key=?',[userId,key]);
 if(old){const prior=JSON.parse(old.options_json);if(old.prompt!==prompt||prior.duration!==options.duration||prior.aspectRatio!==options.aspectRatio)throw fail(409,'This request key belongs to a different story.');await conn.commit();return old;}
 if(!Number.isFinite(Number(user.credits))||Number(user.credits)<quote.credits)throw fail(402,'Not enough credits for the selected story tier estimate.');
 const [[count]]=await conn.execute("SELECT COUNT(*) AS total FROM stories WHERE user_id=? AND status IN ('queued','running')",[userId]);
 if(count.total>=1)throw fail(429,'One story can run at a time.');
 const id=crypto.randomUUID();await conn.execute('INSERT INTO stories(id,user_id,request_key,prompt,options_json,state_json) VALUES(?,?,?,?,?,?)',[id,userId,key,prompt,JSON.stringify(options),'{}']);await conn.commit();return get(db,userId,id);
 }catch(e){await conn.rollback();throw e;}finally{conn.release();}
}

async function completeStep(conn,userId,c,generationId){
 await conn.execute('INSERT INTO story_steps(story_id,step_key,generation_id) VALUES(?,?,?)',[c.storyId,c.stepKey,generationId]);
}
module.exports={SCHEMA,beginStep,completeStep,get,create,fail};

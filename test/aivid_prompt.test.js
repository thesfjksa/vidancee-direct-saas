'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateJob,validateSubmission,normalizePrompt,promptValue,fillPrompt}=require('../src/provider/aivid.js');
const settings={duration:5,resolution:'480p',aspectRatio:'16:9'};
test('Windows and browser line endings agree without changing meaningful prompt text',()=>{
  const text='Scene 1:\r\n  A river\r\n\r\n@image1\tاردو 🌅\rLast line';
  const job=validateJob({...settings,prompt:text});
  assert.equal(job.prompt,'Scene 1:\n  A river\n\n@image1\tاردو 🌅\nLast line');
  const body={...settings,model:'seedance-2.0-mini',prompt:text,isPublic:true,references:[]};
  assert.doesNotThrow(()=>validateSubmission(body,job));
  assert.doesNotThrow(()=>validateSubmission({...body,prompt:job.prompt},job));
  for(const changed of [job.prompt.replace('  A',' A'),job.prompt.replace('\n\n','\n'),job.prompt.replace('@image1','@image2'),job.prompt+' changed'])
    assert.throws(()=>validateSubmission({...body,prompt:changed},job),{aividCode:'submission_prompt'});
  assert.equal(normalizePrompt('a\u200db\u00a0c\td'),'a\u200db\u00a0c\td');
});
function editor({resetOnce=false,rewrite=false,rich=false}={}){
  let value='',fills=0,commits=0;
  return {fill:async text=>{value=normalizePrompt(text);fills++;},press:async key=>{
    assert.equal(key,'Tab');commits++;if(rewrite||(resetOnce&&fills===1))value='';
  },evaluate:async fn=>fn({tagName:rich?'DIV':'TEXTAREA',value,innerText:value}),
  state:()=>({value,fills,commits})};
}
const fast={timeoutMs:60,stableMs:15,intervalMs:5};
test('textarea and rich editors retain multiline prompts after focus commits',async()=>{
  for(const rich of [false,true]){
    const control=editor({rich});await fillPrompt(control,'A river\r\n\nSoft light',fast);
    assert.equal(await promptValue(control),'A river\n\nSoft light');
    assert.equal(control.state().fills,1);assert.equal(control.state().commits,1);
  }
});
test('one editor reset is retried before any submission; persistent changes fail closed',async()=>{
  const transient=editor({resetOnce:true});await fillPrompt(transient,'A river',fast);
  assert.equal(transient.state().fills,2);assert.equal(transient.state().value,'A river');
  const persistent=editor({rewrite:true});
  await assert.rejects(fillPrompt(persistent,'A river',fast),e=>e.aividCode==='form_prompt');
  assert.equal(persistent.state().fills,2);
});

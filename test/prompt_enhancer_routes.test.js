'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { once } = require('node:events');

const studio = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const admin = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
const adminNav = fs.readFileSync(require.resolve('../public/provider-admin.js'), 'utf8');
const settings = fs.readFileSync(require.resolve('../src/settings.js'), 'utf8');

test('prompt enhancer is absent from customer and Admin controls, models, and settings', () => {
  for (const [file, body] of [
    ['studio',studio],['admin',admin],['Admin navigation',adminNav],['provider settings',settings],
  ]) {
    assert.doesNotMatch(body, /prompt[-_ ]?enhanc|Prompt enhancer|GeminiPromptEnhancer|enhancerEnabled|enhancerApiKey|enhancedPromptCache/i, file);
  }
  assert.match(studio,/id="prompt"/);
  assert.match(studio,/id="imagePrompt"/);
  assert.match(admin,/data-provider-source="vibi"/);
  assert.match(admin,/data-provider-source="fal"/);
  assert.match(adminNav,/aivid: null/);
  assert.match(settings,/allow_provider_charges/);
  assert.equal(Object.hasOwn(require('../src/settings.js').DEFAULTS || {}, 'prompt_enhancer_enabled'),false);
});

test('original image/video prompts reach generation unchanged without an enhancement network request', () => {
  const start=studio.indexOf('function prepareGenerationPrompt(kind){');
  const end=studio.indexOf('async function createImageGeneration(){',start);
  assert.ok(start>=0 && end>start);
  const calls=[];
  const fields={imagePrompt:{value:'  Keep @Image1 exactly as written.\n'},prompt:{value:'  A cat moves past @Video1.\n'}};
  const ctx=vm.createContext({ $: id=>{calls.push(id);return fields[id];} });
  vm.runInContext(studio.slice(start,end),ctx);
  assert.equal(ctx.prepareGenerationPrompt('image'),fields.imagePrompt.value);
  assert.equal(ctx.prepareGenerationPrompt('video'),fields.prompt.value);
  assert.deepEqual(calls,['imagePrompt','prompt']);
  fields.imagePrompt.value='  ';
  assert.throws(()=>ctx.prepareGenerationPrompt('image'),/Enter a prompt before generating/);
  assert.doesNotMatch(studio,/\/api\/prompts\/enhance/);
});

test('retired enhancement APIs return 410 without credentials or provider calls; public config contains no enhancer', async t => {
  process.env.PORT='0';
  process.env.HOST='127.0.0.1';
  process.env.WORKER_ENABLED='false';
  const db=require('../src/db.js');
  const oldConfigured=db.dbConfigured;
  db.dbConfigured=()=>false;
  const server=require('../server.js');
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    db.dbConfigured=oldConfigured;
  });
  if(!server.listening)await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const publicConfig=await (await fetch(origin+'/api/config')).json();
  assert.equal(Object.hasOwn(publicConfig,'promptEnhancer'),false);
  for(const [method,path] of [
    ['POST','/api/prompts/enhance'],
    ['GET','/api/prompts/enhance/00000000-0000-4000-8000-000000000001'],
    ['GET','/api/prompts/enhance/requests/00000000-0000-4000-8000-000000000001'],
  ]) {
    const response=await fetch(origin+path,{method,headers:{'content-type':'application/json'},
      ...(method==='POST'?{body:JSON.stringify({prompt:'A sunrise',mediaType:'image'})}:{})});
    assert.equal(response.status,410,path);
    const body=await response.json();
    assert.equal(body.ok,false);
    assert.match(body.error,/no longer available/i);
  }
});

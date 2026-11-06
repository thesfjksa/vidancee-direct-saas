'use strict';
const assert = require('node:assert/strict');
// Match the observed AIVID controls without using an account or paid request.
const html = `<!doctype html><html><body><header>0 credits</header><main>
<textarea placeholder="Describe your video idea..."></textarea>
<button id="model" onclick="document.querySelector('#models').hidden=false">Seedance 2.5</button>
<div id="models" hidden><button id="mini" onclick="model.textContent='Seedance 2.0 (Mini)';models.hidden=true;duration.max=15;update()">Seedance 2.0 (Mini) Most cost-effective, quicker results.</button><button id="full" onclick="model.textContent='Seedance 2.0';models.hidden=true;duration.max=15;update()">Seedance 2.0 High quality</button><button id="v25" onclick="model.textContent='Seedance 2.5';models.hidden=true;duration.max=30;update()">Seedance 2.5 Premium</button></div>
<button>16:9</button><button id="resolution" onclick="resolutions.hidden=false">720p</button>
<div id="resolutions" hidden><button onclick="resolution.textContent='480p';resolutions.hidden=true">480p</button></div>
<input id="duration" type="range" min="4" max="30" value="15" oninput="update()"><span id="seconds">15s</span>
<label>Bypass <input id="bypass" type="checkbox" checked></label>
<input id="refImages" type="file" accept=" .webp, image/png , image/jpeg " multiple onchange="document.querySelector('#refSelected').textContent=Array.from(this.files).map(f=>f.name).join(',')"><span id="refSelected"></span>
<div id="privacy"><span>Public</span><label style="display:inline-flex;width:36px;height:20px;cursor:pointer;position:relative">
<input id="privateToggle" type="checkbox" checked style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0" onchange="window.isPublic=!this.checked;window.privacyChanges++;update()"><div style="width:36px;height:20px;background:gray"></div>
</label><span>Private</span></div><span id="price">3 Credits / Video</span>
<button onclick="window.generateClicks++">Generate</button></main><script>
window.generateClicks=0;window.inputEvents=0;window.isPublic=false;window.privacyChanges=0;
function update(){window.inputEvents++;seconds.textContent=duration.value+'s';price.textContent=(Math.ceil(Number(duration.value)/5)+(privateToggle.checked?2:0))+' Credits / Video';}
</script></body></html>`;
async function checkForm(page, Client, waitForSession) {
  let missingModel = false, editorMode = 'textarea', signIn = false, privacyMode = 'private', modelSuffix = false, wrongModelAfterSelection = false, wrongResolutionAfterPrompt = false, missingImageInput = false, ambiguousImageInput = false, badDurationLabel = false, sliderMin = 4, sliderStep = 1, shortSlider = false, delayedMenu=false, duplicateModel=false, promptResetMode='none';
  await page.route('https://aivid.dev/**', route => {
    let body = html;
    if (privacyMode === 'public') body = body.replace('id="privateToggle" type="checkbox" checked', 'id="privateToggle" type="checkbox"').replace('window.isPublic=false', 'window.isPublic=true');
    if (privacyMode === 'disabled') body = body.replace('id="privateToggle"', 'disabled id="privateToggle"');
    if (privacyMode === 'missing') body = body.replace('<span>Private</span>', '<span>Unknown</span>');
    if (privacyMode === 'ambiguous') body = body.replace('</main>', '<div><span>Public</span><label><input type="checkbox"></label><span>Private</span></div></main>');
    if (privacyMode === 'inert') body = body.replace('onchange="window.isPublic=!this.checked;window.privacyChanges++;update()"', 'onclick="event.preventDefault()"');
    if (privacyMode === 'reset_after_prompt') body = body.replace('<textarea placeholder=', '<textarea oninput="privateToggle.checked=true;window.isPublic=false;update()" placeholder=');
    if (missingModel) body = body.replace('id="mini"', 'hidden id="mini"');
    if (badDurationLabel) body=body.replace("seconds.textContent=duration.value+'s'", "seconds.textContent='15s'");
    if (sliderMin!==4) body=body.replace('type="range" min="4"','type="range" min="'+sliderMin+'"');
    if (sliderStep!==1) body=body.replace('type="range" min="4" max="30"','type="range" min="4" max="30" step="'+sliderStep+'"');
    if (shortSlider) body=body.replace('duration.max=30;update()','duration.max=15;update()').replace('id="duration" type="range" min="4" max="30"','id="duration" type="range" min="4" max="15"');
    if(delayedMenu)body=body.replace("document.querySelector('#models').hidden=false","setTimeout(()=>document.querySelector('#models').hidden=false,100)");
    if(duplicateModel)body=body.replace('id="models" hidden>','id="models" hidden><button>Seedance 2.0 High quality duplicate</button>');
    if (missingImageInput) body = body.replace('id="refImages" type="file"', 'id="refImages" type="text"');
    if (ambiguousImageInput) body=body.replace('<span id="refSelected"></span>',
      '<span id="refSelected"></span><input type="file" accept="image/*">');
    if (modelSuffix) body = body
      .replace("model.textContent='Seedance 2.0 (Mini)'","model.textContent='Seedance 2.0 (Mini) Fast premium model'")
      .replace("model.textContent='Seedance 2.0'","model.textContent='Seedance 2.0 High quality'")
      .replace("model.textContent='Seedance 2.5'","model.textContent='Seedance 2.5 Premium model'");
    if (wrongModelAfterSelection) body = body.replace("model.textContent='Seedance 2.0 (Mini)'","model.textContent='Seedance 2.5'");
    if (wrongResolutionAfterPrompt) body = body.replace('<textarea placeholder=', '<textarea oninput="resolution.textContent=\'720p\'" placeholder=');
    if(promptResetMode!=='none')body=body.replace('<textarea placeholder=',
      '<textarea oninput="window.promptInputs=(window.promptInputs||0)+1;'+
      (promptResetMode==='once'?'if(window.promptInputs===1)':'')+
      'setTimeout(()=>{this.value=\'\'},50)" placeholder=');
    if (editorMode === 'rich') body = body.replace('<textarea placeholder="Describe your video idea..."></textarea>',
      '<textarea hidden placeholder="Describe your video idea..."></textarea><div role="textbox" contenteditable="true" style="white-space:pre-wrap" data-placeholder="Describe your video idea..."></div>');
    if (editorMode === 'renamed') body = body.replace('Describe your video idea...', 'What would you like to create?');
    if (editorMode === 'missing') body = body.replace('<textarea placeholder="Describe your video idea..."></textarea>', '');
    if (editorMode === 'ambiguous') body = body.replace('</main>', '<textarea placeholder="A second editor"></textarea></main>');
    if (signIn) body = body.replace('<header>', '<header><button>Sign In</button>');
    // An unrelated comment box must not be mistaken for the generation editor.
    body = body.replace('</body>', '<textarea placeholder="Describe your video idea..."></textarea></body>');
    return route.fulfill({ contentType: 'text/html', body });
  });
  const stages = [];
  const client = new Client({ connect: async () => ({ page, close: async () => {} }), onProgress: stage => stages.push(stage) });
  for (const mode of ['textarea', 'rich', 'renamed']) {
    editorMode = mode;
    for (const duration of [4, 10, 15]) {
      const result = await client.preflight({ prompt: 'A quiet river', duration, aspectRatio: '16:9', resolution: '480p' });
      assert.equal(result.submitted, false); assert.equal(result.ready, true); assert.equal(result.balance, 0);
      assert.equal(result.price, Math.ceil(duration / 5));
      assert.equal(result.duration, duration); assert.equal(result.model, 'Seedance 2.0 (Mini)');
      assert.equal(await page.locator('#seconds').innerText(), duration + 's');
      assert.equal(await page.locator('#privateToggle').isChecked(), false);
      assert.equal(await page.evaluate(() => window.isPublic), true);
      assert.equal(await page.evaluate(() => window.privacyChanges), 1);
      assert.equal(await page.locator('#bypass').isChecked(), true);
      assert.equal(await page.evaluate(() => window.generateClicks), 0);
      if (mode === 'rich') assert.equal(await page.locator('main [contenteditable]').innerText(), 'A quiet river');
    }
  }
  // All three models must select the right current-model button, set Public
  // and read post-switch price without ever clicking Generate.
  editorMode = 'textarea';
  for(const mode of ['textarea','rich']){
    editorMode=mode;
    console.log('AIVID fixture multiline prompt editor: '+mode);
    const result=await client.preflight({prompt:'Scene 1:\r\n  A river\r\n\r\n@image1\tاردو 🌅',duration:5,aspectRatio:'16:9',resolution:'480p'});
    assert.equal(result.submitted,false);
    const text=await page.locator('main '+(mode==='textarea'?'textarea':'[contenteditable]')).evaluate(el=>el.tagName==='TEXTAREA'?el.value:el.innerText);
    assert.equal(text,'Scene 1:\n  A river\n\n@image1\tاردو 🌅');
    assert.equal(await page.evaluate(()=>window.generateClicks),0);
  }
  editorMode='textarea';promptResetMode='once';
  await client.preflight({prompt:'A river after one form reset',duration:5,aspectRatio:'16:9',resolution:'480p'});
  assert.equal(await page.evaluate(()=>window.promptInputs),2);
  promptResetMode='always';
  await assert.rejects(client.preflight({prompt:'A river that the form loses',duration:5,aspectRatio:'16:9',resolution:'480p'}),e=>e.aividCode==='form_prompt');
  assert.equal(await page.evaluate(()=>window.generateClicks),0);
  assert.equal(await page.evaluate(()=>window.promptInputs),2);
  promptResetMode='none';
  delayedMenu=true;
  for(const model of ['aivid_seedance_2_0_mini','aivid_seedance_2_0']){
    const result=await client.preflight({model,prompt:'A quiet river',duration:5,aspectRatio:'16:9',resolution:'480p'});
    assert.equal(result.modelId,model);
    assert.equal(await page.evaluate(()=>window.generateClicks),0);
  }
  delayedMenu=false;
  const alreadySelected=await client.preflight({model:'aivid_seedance_2_5',prompt:'A quiet river',duration:5,aspectRatio:'16:9',resolution:'720p'});
  assert.equal(alreadySelected.modelId,'aivid_seedance_2_5');
  assert.equal(await page.locator('#models').isVisible(),false);
  duplicateModel=true;
  await assert.rejects(client.preflight({model:'aivid_seedance_2_0',prompt:'A quiet river',duration:5,aspectRatio:'16:9',resolution:'720p'}),e=>e.aividCode==='model_selection');
  assert.equal(await page.evaluate(()=>window.generateClicks),0);
  duplicateModel=false;
  for (const [model,duration] of [['aivid_seedance_2_0',15],['aivid_seedance_2_5',30]]) {
    const result=await client.preflight({model,prompt:'A quiet river',duration,aspectRatio:'16:9',resolution:'480p'});
    assert.equal(result.modelId,model);
    assert.equal(result.duration,duration);
    assert.equal(await page.locator('#privateToggle').isChecked(),false);
    assert.equal(await page.evaluate(()=>window.generateClicks),0);
  }
  // Current-model buttons may contain descriptions after their model name;
  // the selected control must be validated, not an exactly named menu item.
  modelSuffix = true;
  for (const model of ['aivid_seedance_2_0_mini','aivid_seedance_2_0','aivid_seedance_2_5']) {
    const result = await client.preflight({ model, prompt:'A quiet river',duration:4,aspectRatio:'16:9',resolution:'480p' });
    assert.equal(result.modelId,model);
    assert.equal(await page.evaluate(()=>window.generateClicks),0);
  }
  modelSuffix = false;
  wrongModelAfterSelection = true;
  await assert.rejects(client.preflight({ prompt:'A quiet river',duration:4,aspectRatio:'16:9',resolution:'480p' }),error=>{
    assert.equal(error.aividCode,'form_model');
    assert.doesNotMatch(error.message,/Playwright|locator|https:|A quiet river/);
    return true;
  });
  assert.equal(await page.evaluate(()=>window.generateClicks),0);
  wrongModelAfterSelection = false;
  wrongResolutionAfterPrompt = true;
  await assert.rejects(client.preflight({ prompt:'A quiet river',duration:4,aspectRatio:'16:9',resolution:'480p' }),error=>{
    assert.equal(error.aividCode,'form_resolution'); return true;
  });
  assert.equal(await page.evaluate(()=>window.generateClicks),0);
  wrongResolutionAfterPrompt = false;
  // Upload preflight must attach files even when accept attribute order varies.
  // It is read-only, checks browser FileList, and never clicks Generate.
  editorMode='textarea';privacyMode='private';
  const image={kind:'image',mimeType:'image/png',data:Buffer.from('89504e470d0a1a0a','hex')};
  const withImage=await client.preflight({prompt:'A quiet river',duration:4,aspectRatio:'16:9',resolution:'480p'},[image]);
  assert.equal(withImage.referenceCounts.image,1);
  assert.equal(await page.locator('#refImages').evaluate(el=>el.files.length),1);
  assert.equal(await page.locator('#refSelected').innerText(),'reference-image-1.png');
  assert.equal(await page.evaluate(()=>window.generateClicks),0);
  missingImageInput=true;
  await assert.rejects(client.preflight({prompt:'A quiet river',duration:4,aspectRatio:'16:9',resolution:'480p'},[image]),error=>{
    assert.equal(error.aividCode,'reference_upload');return true;
  });
  missingImageInput=false;ambiguousImageInput=true;
  await assert.rejects(client.preflight({prompt:'A quiet river',duration:4,aspectRatio:'16:9',resolution:'480p'},[image]),error=>{
    assert.equal(error.aividCode,'reference_upload');return true;
  });
  ambiguousImageInput=false;
  assert.equal(await page.evaluate(()=>window.generateClicks),0);
  // All requested lengths must change the actual slider AND its 15s-style
  // displayed label; a mismatch is rejected before any paid Generate click.
  for(const duration of [4,5,8,10,12,14,15]){
    const result=await client.preflight({model:'aivid_seedance_2_0_mini',prompt:'A quiet river',duration,aspectRatio:'16:9',resolution:'480p'});
    assert.equal(result.duration,duration);
    assert.equal(await page.locator('#seconds').innerText(),duration+'s');
    assert.equal(await page.locator('#duration').inputValue(),String(duration));
    assert.equal(await page.evaluate(()=>window.generateClicks),0);
  }
  for(const duration of [4,5,15,16,20,25,30]){
    const result=await client.preflight({model:'aivid_seedance_2_5',prompt:'A quiet river',duration,aspectRatio:'16:9',resolution:'480p'});
    assert.equal(result.duration,duration);
    assert.equal(await page.locator('#seconds').innerText(),duration+'s');
    assert.equal(await page.evaluate(()=>window.generateClicks),0);
  }
  badDurationLabel=true;
  await assert.rejects(client.preflight({prompt:'A quiet river',duration:6,aspectRatio:'16:9',resolution:'480p'}),err=>{
    assert.equal(err.aividCode,'duration');return true;
  });
  assert.equal(await page.evaluate(()=>window.generateClicks),0);
  badDurationLabel=false;
  sliderStep=2;
  await assert.rejects(client.preflight({prompt:'A quiet river',duration:5,aspectRatio:'16:9',resolution:'480p'}),err=>{
    assert.equal(err.aividCode,'duration');return true;
  });
  sliderStep=1;
  shortSlider=true;
  await assert.rejects(client.preflight({model:'aivid_seedance_2_5',prompt:'A quiet river',duration:30,aspectRatio:'16:9',resolution:'480p'}),err=>{
    assert.equal(err.aividCode,'duration');return true;
  });
  shortSlider=false;
  editorMode = 'textarea'; privacyMode = 'public';
  await client.preflight({ prompt: 'A quiet river', duration: 4, aspectRatio: '16:9', resolution: '480p' });
  assert.equal(await page.locator('#privateToggle').isChecked(), false);
  assert.equal(await page.evaluate(() => window.isPublic), true);
  assert.equal(await page.evaluate(() => window.privacyChanges), 0);
  assert.equal(await page.locator('#bypass').isChecked(), true);
  assert.equal(await page.evaluate(() => window.generateClicks), 0);
  page.setDefaultTimeout(250);
  for (const mode of ['disabled', 'missing', 'ambiguous', 'inert']) {
    privacyMode = mode;
    await assert.rejects(client.preflight({ prompt: 'A quiet river', duration: 4, aspectRatio: '16:9', resolution: '480p' }), error => {
      assert.equal(error.aividCode, 'privacy'); return true;
    });
    assert.equal(await page.evaluate(() => window.generateClicks), 0);
    assert.equal(await page.locator('#bypass').isChecked(), true);
  }
  privacyMode = 'reset_after_prompt';
  await assert.rejects(client.preflight({ prompt: 'A quiet river', duration: 4, aspectRatio: '16:9', resolution: '480p' }), error => {
    assert.equal(error.aividCode, 'form_privacy'); return true;
  });
  assert.equal(await page.evaluate(() => window.generateClicks), 0);
  privacyMode = 'private';
  assert.ok(stages.includes('duration') && stages.includes('credit_reading'));
  missingModel = true; page.setDefaultTimeout(250);
  await assert.rejects(client.preflight({ prompt: 'A quiet river', duration: 4, aspectRatio: '16:9', resolution: '480p' }), error => {
    assert.equal(error.aividCode, 'model_selection'); assert.doesNotMatch(error.message, /locator|Call log|https:/); return true;
  });
  assert.equal(await page.evaluate(() => window.generateClicks), 0);
  page.setDefaultTimeout(1000); missingModel = false;
  if (waitForSession) {
    for (const [mode, loggedOut, code] of [['missing', false, 'session_form_missing'], ['ambiguous', false, 'session_form_ambiguous'], ['textarea', true, 'session_sign_in']]) {
      editorMode = mode; signIn = loggedOut; await page.goto('https://aivid.dev/');
      await assert.rejects(waitForSession(page, { timeoutMs: 100 }), error => {
        assert.equal(error.aividCode, code); return true;
      });
      assert.equal(await page.evaluate(() => window.generateClicks), 0);
    }
  }
}
module.exports = { checkForm };

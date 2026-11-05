'use strict';
const assert = require('node:assert/strict');
// Match the observed AIVID controls without using an account or paid request.
const html = `<!doctype html><html><body><header>0 credits</header><main>
<textarea placeholder="Describe your video idea..."></textarea>
<button id="model" onclick="document.querySelector('#models').hidden=false">Seedance 2.5</button>
<div id="models" hidden><button id="mini" onclick="model.textContent='Seedance 2.0 (Mini)';models.hidden=true;duration.max=15;update()">Seedance 2.0 (Mini) Most cost-effective, quicker results.</button></div>
<button>16:9</button><button id="resolution" onclick="resolutions.hidden=false">720p</button>
<div id="resolutions" hidden><button onclick="resolution.textContent='480p';resolutions.hidden=true">480p</button></div>
<input id="duration" type="range" min="4" max="30" value="15" oninput="update()"><span id="seconds">15s</span>
<label>Public <input id="publicToggle" type="checkbox" checked> Private</label>
<label>Bypass <input id="bypass" type="checkbox"></label><span id="price">3 Credits / Video</span>
<button onclick="window.generateClicks++">Generate</button></main><script>
window.generateClicks=0;window.inputEvents=0;
function update(){window.inputEvents++;seconds.textContent=duration.value+'s';price.textContent=Math.ceil(Number(duration.value)/5)+' Credits / Video';}
</script></body></html>`;
async function checkForm(page, Client, waitForSession) {
  let missingModel = false, editorMode = 'textarea', signIn = false;
  await page.route('https://aivid.dev/**', route => {
    let body = html;
    if (missingModel) body = body.replace('id="mini"', 'hidden id="mini"');
    if (editorMode === 'rich') body = body.replace('<textarea placeholder="Describe your video idea..."></textarea>',
      '<textarea hidden placeholder="Describe your video idea..."></textarea><div role="textbox" contenteditable="true" data-placeholder="Describe your video idea..."></div>');
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
      assert.equal(await page.locator('#publicToggle').isChecked(), false);
      assert.equal(await page.locator('#bypass').isChecked(), false);
      assert.equal(await page.evaluate(() => window.generateClicks), 0);
      if (mode === 'rich') assert.equal(await page.locator('main [contenteditable]').innerText(), 'A quiet river');
    }
  }
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

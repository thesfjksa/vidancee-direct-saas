const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const path = require('node:path');
const { probeCloneSample } = require('../src/voice_probe');

async function run() {
  // Twelve seconds of a synthetic tone encoded as AAC in an M4A container.
  const recording = path.join(__dirname,'../test/fixtures/voice-clone-recording.m4a');
  const browser = await chromium.launch({headless:true,channel:'chromium'});
  try {
    const page = await browser.newPage();
    const url='http://127.0.0.1/clone-test';
    await page.route(url,route=>route.fulfill({contentType:'text/html',body:'<form><input id="cloneVoiceFile" type="file"><input id="cloneVoiceName" value="Test">' +
      '<input id="cloneLanguage" value="English"><input id="cloneGender" value="Male"><input id="clonePreview">' +
      '<button id="cloneVoiceBtn" type="button"></button><div id="cloneVoiceMsg"></div></form>'}));
    await page.goto(url);
    await page.addScriptTag({path:'public/voice-studio.js'});
    await page.locator('#cloneVoiceFile').setInputFiles(recording);
    const result = await page.evaluate(async () => {
      window.$ = id => document.getElementById(id);
      const sent = [];
      const formats = [];
      let sample;
      window.uploadReferencesDirect = async ([entry]) => {
        formats.push([entry.item.file.type,entry.item.file.name]);
        sample=entry.item.file;
        return [{upload:{key:'uploads/7/test',filename:entry.item.filename,mimeType:sample.type}}];
      };
      window.api = async (path,options) => {
        if (options?.method!=='POST') throw new TypeError('Failed to fetch');
        sent.push(JSON.parse(options.body));
        if (sent.length===1) throw new TypeError('Failed to fetch');
        return {clone:{id:123}};
      };
      window.config = {voice:{enabled:true}};
      window.loadCredits = async () => {};
      window.loadDashboard = async () => {};
      await createVoiceClone();
      const firstMessage=$('cloneVoiceMsg').textContent;
      await createVoiceClone();
      return {sent,formats,firstMessage,lastMessage:$('cloneVoiceMsg').textContent,
        sample:Array.from(new Uint8Array(await sample.arrayBuffer()))};
    });
    assert.match(result.firstMessage,/connection was interrupted/);
    assert.match(result.lastMessage,/Clone queued/);
    assert.equal(result.sent.length,2);
    assert.equal(result.sent[0].requestKey,result.sent[1].requestKey);
    assert.deepEqual(result.formats,[['audio/wav','voice-sample.wav'],['audio/wav','voice-sample.wav']]);
    assert.ok(result.sent.every(request=>request.audioUploads.length===1));
    const info=await probeCloneSample({data:Buffer.from(result.sample),mimeType:'audio/wav'},{binaries:[]});
    assert.ok(Math.abs(info.duration-12)<0.2);
    console.log('Chromium decoded a real M4A, produced valid WAV, retried the same request, and preserved success after a failed refresh.');
  } finally {
    await browser.close();
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});

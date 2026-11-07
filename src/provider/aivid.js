'use strict';

const { connectSession, LOGIN_VIEWPORT } = require('./browserless.js');
const crypto=require('node:crypto');
const {UploadTracker,exactIds,referenceName,deferred,bounded}=require('./aivid_uploads.js');
const ORIGIN = 'https://aivid.dev';
const API = 'https://api.aivid.dev';
const MINI = 'Seedance 2.0 (Mini)';
const { aividModel, DEFAULT_ID } = require('../aivid_models.js');
const ID = /^[a-zA-Z0-9_-]{16,80}$/;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
// File accept attribute ordering, whitespace and extension aliases are not
// part of a provider API contract. Use semantic type matching rather than one
// literal CSS attribute value. Reject ambiguous multi-kind inputs until their
// actual upload schema is tested, rather than silently replacing files.
const FILE_ACCEPT = Object.freeze({
  image: ['image/*','image/jpeg','image/png','image/webp','.jpg','.jpeg','.png','.webp'],
  video: ['video/*','video/mp4','video/quicktime','.mp4','.mov'],
  audio: ['audio/*','audio/mpeg','audio/wav','audio/x-wav','.mp3','.wav'],
});
function fileInputKind(accept) {
  const tokens=String(accept||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
  const matches=Object.keys(FILE_ACCEPT).filter(kind=>tokens.some(token=>FILE_ACCEPT[kind].includes(token)));
  return matches.length===1?matches[0]:null;
}
async function referenceFileInput(main,kind) {
  const inputs=main.locator('input[type="file"]');
  const matches=[];
  for(let i=0,n=await inputs.count();i<n;i++){
    const input=inputs.nth(i);
    if(fileInputKind(await input.getAttribute('accept'))===kind && await input.isEnabled())matches.push(input);
  }
  if(matches.length!==1)throw new Error('AIVID reference upload input is missing or ambiguous.');
  return matches[0];
}
function referenceAlertCode(message) {
  if (/shorter than the minimum|maximum allowed is/i.test(message)) return 'reference_duration';
  if (/the dimensions of|the shape of|the resolution of/i.test(message)) return 'reference_dimensions';
  if (/could not read|format .* is not supported/i.test(message)) return 'reference_format';
  if (/smaller than|size cannot exceed/i.test(message)) return 'reference_size';
  return 'reference_preview';
}
async function attachReferences(page,main,kind,refs) {
  // AIVID appends previews in FileReader completion order. Select one at a
  // time so each numbered preview matches the order requested by the customer.
  for(const [index,ref] of refs.entries()){
    const input=await step('reference_input',()=>referenceFileInput(main,kind));
    const name=referenceName(kind,ref.mimeType,index);
    const rejected=deferred();
    const handleDialog=async dialog=>{
      if(dialog.type()==='alert'&&dialog.message().includes(name)){
        rejected.reject(sessionFailure(referenceAlertCode(dialog.message())));
      }
      // Match Playwright's default dismissal. Never approve a dialog.
      await dialog.dismiss().catch(()=>{});
    };
    page.on('dialog',handleDialog);
    try {
      const preview=async()=>{
        await step('reference_selection',async()=>{
          await input.evaluate(element=>{
            element.__cmmSelected=new Promise(resolve=>element.addEventListener('change',()=>{
              const selected=Array.from(element.files||[]);
              resolve(Promise.all(selected.map(async file=>({name:file.name,type:file.type,size:file.size,
                sha256:Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(v=>v.toString(16).padStart(2,'0')).join('')}))));
            },{once:true,capture:true}));
          });
          await input.setInputFiles({name,mimeType:ref.mimeType,buffer:ref.data},{timeout:15000});
          const selected=await bounded(input.evaluate(async element=>{
            try{return await element.__cmmSelected}finally{delete element.__cmmSelected}
          }),15000).catch(()=>{throw sessionFailure('reference_selection')});
          const [file]=selected;
          if(selected.length!==1||file.name!==name||file.type!==ref.mimeType||file.size!==ref.data.length||
            file.sha256!==crypto.createHash('sha256').update(ref.data).digest('hex'))
            throw new Error('AIVID did not retain the selected reference file.');
        });
        await step('reference_preview',()=>main.getByText('@'+kind+(index+1),{exact:true}).waitFor({state:'visible',timeout:30000}));
      };
      await Promise.race([preview(),rejected.promise]);
    } finally {
      page.off('dialog',handleDialog);
    }
  }
}

const MIME = { image: ['image/jpeg', 'image/png', 'image/webp'], video: ['video/mp4', 'video/quicktime'], audio: ['audio/mpeg', 'audio/wav'] };

// Only fixed diagnostic codes/messages cross the RDP bridge. Never forward
// Playwright call logs, page text, account data or connection URLs.
const DIAGNOSTICS = Object.freeze({
  collection_history: 'The worker could not read AIVID generation history.',
  collection_media_url: 'AIVID history did not provide a verified video link for this job.',
  collection_media_pending: 'AIVID finished the video. CMMTools is waiting for the full video file.',
  collection_download: 'The worker could not download and validate the AIVID MP4.',
  collection_relay: 'CMMTools did not receive the complete video from the RDP agent.',
  collection_storage: 'CMMTools received the video but could not save it.',
  download_security: 'Chrome blocked the video download with a security warning. Review it manually; automatic collection is paused.',
  browser_connection: 'Could not connect to the local Chrome profile. Close the Login Chrome windows, then restart Agent.',
  page_navigation: 'AIVID did not load in time. Check its Chrome tab and the RDP internet connection.',
  session_check: 'AIVID sign-in or its generation form is not ready. Inspect the Chrome tab before retrying.',
  session_sign_in: 'AIVID still shows Sign In. Finish sign-in in the Login Chrome window, close it, then restart Agent.',
  session_form_missing: 'No visible prompt editor was found in the AIVID generation area. Check that the Generate page has finished loading.',
  session_form_ambiguous: 'More than one visible prompt editor was found. Close extra AIVID dialogs before retrying.',
  session_page_left: 'The AIVID tab left the generation site. Inspect Chrome and finish any sign-in steps before retrying.',
  model_selection: 'Could not select the requested AIVID model. Check that its model menu opens on the RDP.',
  aspect_ratio: 'Could not select the requested AIVID aspect ratio.',
  resolution: 'Could not select the requested AIVID resolution.',
  duration: 'Could not set or verify the AIVID duration slider.',
  privacy: 'Could not set AIVID public visibility. No video was submitted.',
  reference_upload: 'AIVID could not verify the reference files or their upload IDs.',
  reference_input: 'The AIVID form did not have one compatible reference file input.',
  reference_selection: 'AIVID could not verify the file selected in its reference input.',
  reference_preview: 'AIVID did not create a preview for a reference file.',
  reference_duration: 'AIVID rejected a reference because its duration is outside the allowed range.',
  reference_dimensions: 'AIVID rejected a reference because of its dimensions or aspect ratio.',
  reference_format: 'AIVID could not read the reference format. Try exporting the file again.',
  reference_size: 'AIVID rejected a reference because the file is too large.',
  submission_price_changed: 'AIVID changed the source price while preparing the request.',
  submission_reservation: 'CMM Tools could not confirm the submission reservation.',
  submission_payload: 'AIVID sent a request that could not be verified.',
  submission_model: 'AIVID sent a different model in its video request.',
  submission_prompt: 'AIVID sent a different prompt in its video request.',
  submission_duration: 'AIVID sent a different duration in its video request.',
  submission_resolution: 'AIVID sent a different resolution in its video request.',
  submission_aspect_ratio: 'AIVID sent a different aspect ratio in its video request.',
  submission_privacy: 'AIVID did not confirm public visibility in its video request.',
  submission_request: 'The worker blocked an unexpected AIVID request before submission.',
  request_guard_setup: 'Chrome could not start safe AIVID request monitoring. Close DevTools, restart the Agent, and inspect its log.',
  submission_price_unreadable: 'The worker could not confirm the displayed video price before submission.',
  submission_click: 'The AIVID Generate button did not complete the submission.',
  source_rejected: 'AIVID rejected the video request.',
  prompt: 'Could not fill the AIVID prompt field.',
  form_verification: 'AIVID form settings did not match after preparation. No video was submitted.',
  form_model: 'AIVID changed or did not confirm the selected video model after preparation. No video was submitted.',
  form_aspect_ratio: 'AIVID changed the selected aspect ratio after preparation. No video was submitted.',
  form_resolution: 'AIVID changed the selected resolution after preparation. No video was submitted.',
  form_duration: 'AIVID changed the selected video duration after preparation. No video was submitted.',
  form_privacy: 'AIVID reverted to Private visibility after preparing the prompt. No video was submitted.',
  form_prompt: 'AIVID changed or did not retain the prepared prompt. No video was submitted.',
  credit_reading: 'Could not identify the AIVID account balance and video price. A zero balance is allowed for this check.',
  reference_database: 'CMMTools could not load the saved reference file records. Check MySQL health in Admin.',
  reference_storage: 'CMMTools could not read saved references from cloud storage. Check Admin Storage and the stored files.',
  queue_setup: 'CMMTools could not prepare this generation\'s saved options. Review the job and worker configuration.',
  rdp_dispatch: 'CMMTools could not dispatch the generation to the RDP Agent. Check the agent heartbeat, worker and command service.',
  reservation_precheck: 'CMMTools could not validate or reserve the source price before submission. No automatic resubmission is allowed.',
  browser_check: 'The AIVID operation failed. Inspect Chrome and the Agent window; no automatic resubmission is allowed.',
});
function diagnosticCode(error) {
  return Object.hasOwn(DIAGNOSTICS, error?.aividCode) ? error.aividCode : 'browser_check';
}
function diagnosticMessage(code) {
  return DIAGNOSTICS[Object.hasOwn(DIAGNOSTICS, code) ? code : 'browser_check'];
}
async function step(code, action, onProgress) {
  if (onProgress) onProgress(code);
  try { return await action(); }
  catch (error) {
    // Preserve a more specific nested stage, without copying its raw message.
    const known = Object.hasOwn(DIAGNOSTICS, error?.aividCode) ? error.aividCode : code;
    throw Object.assign(new Error(diagnosticMessage(known)), { aividCode: known });
  }
}

// Browser text controls normalize Windows CRLF and lone CR to LF. Preserve
// every other character, including spaces, tabs, mentions and Unicode.
function normalizePrompt(value) { return String(value ?? '').replace(/\r\n?/g,'\n'); }
function validateJob(value, references = []) {
  if (!value || typeof value !== 'object') throw new Error('An AIVID job is required.');
  const spec=aividModel(value.model || DEFAULT_ID);
  if(!spec)throw new Error('Unknown AIVID Premium model.');
  const job = { modelId:spec.id, modelLabel:spec.name, providerModelId:spec.providerId,
    prompt: normalizePrompt(value.prompt).trim(), duration: Number(value.duration),
    aspectRatio: String(value.aspectRatio || value.aspect_ratio || '16:9'), resolution: String(value.resolution || '480p') };
  if (!job.prompt || job.prompt.length > 50000) throw new Error('Prompt must contain 1–50,000 characters.');
  if (!Number.isInteger(job.duration) || job.duration < 4 || job.duration > spec.maxSeconds) throw new Error(spec.id===DEFAULT_ID?'Mini supports 4–15 whole seconds.':'The selected model does not support this duration.');
  if (!['16:9', '9:16', '1:1'].includes(job.aspectRatio)) throw new Error('Unsupported Mini aspect ratio.');
  if (!spec.resolutions.includes(job.resolution)) throw new Error('Unsupported model resolution.');
  if (!Array.isArray(references) || references.length > spec.refs.image+spec.refs.video+spec.refs.audio) throw new Error('Too many references for this model.');
  const counts = { image: 0, video: 0, audio: 0 }; let totalBytes = 0;
  for (const ref of references) {
    if (!MIME[ref.kind]?.includes(ref.mimeType) || !Buffer.isBuffer(ref.data) || !ref.data.length)
      throw new Error('A reference has an unsupported kind, format or empty file.');
    counts[ref.kind]++; totalBytes += ref.data.length;
    if (ref.data.length > (ref.kind === 'image' ? 10 : 30) * 1024 * 1024)
      throw new Error('A reference exceeds the adapter file size limit.');
  }
  if (counts.image > spec.refs.image || counts.video > spec.refs.video || counts.audio > spec.refs.audio || totalBytes > 64 * 1024 * 1024)
    throw new Error('The reference count or combined file size exceeds the current adapter limit.');
  return { ...job, counts };
}

// Observe the actual web form submission. No account tokens are extracted,
// stored in receipts or sent through CMMTools to the provider API directly.
function isGenerationResponse(response) {
  try { const u = new URL(response.url()); return u.origin === API && u.pathname === '/v2/generations' && response.request().method() === 'POST'; }
  catch { return false; }
}
function providerId(body) {
  return [body?.id, body?.jobId, body?.generationId, body?.data?.id, body?.data?.jobId,
    body?.data?.generationId, body?.generation?.id].find(id => typeof id === 'string' && ID.test(id)) || null;
}

function submissionResult(status, body) {
  const id = providerId(body);
  if (status >= 200 && status < 300 && id) return { state: 'accepted', providerJobId: id };
  // A returned ID, timeout, conflict or throttle can describe an existing or
  // still-running operation. Keep those for history reconciliation as well.
  if (!id && [400, 401, 402, 403, 404, 405, 413, 415, 422].includes(status))
    return { state: 'rejected', errorCode: 'source_rejected', httpStatus: status };
  return { state: 'submission_uncertain' };
}

const PRICE_TEXT = /^\s*(\d+(?:\.\d+)?)\s+Credits?\s*\/\s*Video\s*$/i;
async function confirmSubmissionPrice(page, expected) {
  // Once Generate is clicked AIVID adds a pending card and updates the
  // account header optimistically. Recheck the form price on its own.
  const latest = await step('submission_price_unreadable', async () => {
    const label = page.locator('main').first().getByText(PRICE_TEXT).filter({ visible: true });
    if (await label.count() !== 1) throw new Error('AIVID video price label is missing or ambiguous.');
    const match = (await label.innerText()).match(PRICE_TEXT);
    if (!match) throw new Error('AIVID video price label is invalid.');
    return Number(match[1]);
  });
  if (latest !== expected) throw sessionFailure('submission_price_changed');
}
function creditState(text) {
  const priceMatch = String(text).match(/\b(\d+(?:\.\d+)?)\s+Credits?\s*\/\s*Video\b/i);
  const balances = [...String(text).replace(/\b\d+(?:\.\d+)?\s+Credits?\s*\/\s*Video\b/gi, '')
    .matchAll(/\b(\d+(?:\.\d+)?)\s+credits\b/gi)];
  if (!priceMatch || balances.length !== 1) throw new Error('AIVID price or account balance cannot be identified safely.');
  return { price: Number(priceMatch[1]), balance: Number(balances[0][1]) };
}

// Fail closed on an unknown outgoing schema. UI selection alone does not
// prove the requested public visibility or that every upload reached the paid request.
function validateSubmission(body, job, uploaded=[]) {
  if (!body || typeof body !== 'object') throw sessionFailure('submission_payload');
  if (body.model !== job.providerModelId) throw sessionFailure('submission_model');
  if (typeof body.prompt !== 'string' || normalizePrompt(body.prompt) !== job.prompt)
    throw sessionFailure('submission_prompt');
  if (Number(body.duration) !== job.duration) throw sessionFailure('submission_duration');
  if (body.resolution !== job.resolution) throw sessionFailure('submission_resolution');
  if ((body.aspectRatio ?? body.aspect_ratio) !== job.aspectRatio) throw sessionFailure('submission_aspect_ratio');
  const publicChecks = [];
  for (const key of ['isPublic', 'public']) if (Object.hasOwn(body, key)) publicChecks.push(body[key] === true);
  for (const key of ['isPrivate', 'private']) if (Object.hasOwn(body, key)) publicChecks.push(body[key] === false);
  if (Object.hasOwn(body, 'visibility')) publicChecks.push(body.visibility === 'public');
  if (!publicChecks.length || publicChecks.some(ok => !ok)) throw sessionFailure('submission_privacy');
  exactIds(body,job,uploaded);
}

function promptEditors(page) {
  // The signed-in editor can be contenteditable. Placeholder-only lookup can
  // find a hidden fallback textarea or miss the actual rich-text editor.
  return page.locator('main').first().locator('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]').filter({ visible: true });
}
function sessionFailure(code) { return Object.assign(new Error(diagnosticMessage(code)), { aividCode: code }); }
async function waitForSession(page, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs; let stableSince = null, signedOut = false, count = 0;
  do {
    if (new URL(page.url()).origin !== ORIGIN) throw sessionFailure('session_page_left');
    signedOut = await page.getByRole('button', { name: 'Sign In', exact: true }).filter({ visible: true }).count() > 0;
    count = await promptEditors(page).count();
    const ready = !signedOut && count === 1;
    if (ready) { stableSince ??= Date.now(); if (Date.now() - stableSince >= 1000) return; }
    else stableSince = null;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw sessionFailure(signedOut ? 'session_sign_in' : count > 1 ? 'session_form_ambiguous' : 'session_form_missing');
}

async function promptValue(editor) {
  return normalizePrompt(await editor.evaluate(element => element.tagName === 'TEXTAREA' ? element.value : element.innerText));
}

async function fillPrompt(editor,text,{timeoutMs=2000,stableMs=400,intervalMs=100}={}) {
  const expected=normalizePrompt(text);
  // A visible React form can still replace/reset the editor after fill().
  // Commit focus, check retention, and retry this harmless write at most once.
  // Neither attempt clicks Generate or relaxes the paid-request guard.
  for(let attempt=0;attempt<2;attempt++){
    if(attempt===1 && await editor.evaluate(element=>element.isContentEditable===true)){
      // Native rich-text fill can turn a blank line into div/br markup whose
      // rendered innerText contains an extra newline. Refill literal text,
      // without interpreting HTML, and notify the editor's input handler.
      await editor.evaluate((element,value)=>{
        element.focus();element.textContent=value;
        const Input=element.ownerDocument.defaultView.InputEvent;
        element.dispatchEvent(new Input('input',{bubbles:true,inputType:'insertText',data:value}));
      },expected);
    }else await editor.fill(expected);
    await editor.press('Tab');
    const deadline=Date.now()+timeoutMs;let stableSince=null;
    do {
      if(await promptValue(editor)===expected){
        stableSince??=Date.now();
        if(Date.now()-stableSince>=stableMs)return;
      } else stableSince=null;
      await new Promise(resolve=>setTimeout(resolve,intervalMs));
    } while(Date.now()<deadline);
  }
  throw sessionFailure('form_prompt');
}

async function openLoginPage(page) {
  // Prepare the real sign-in dialog before streaming. Leave Google's button,
  // credentials and any verification to the owner in the private live window.
  await page.setViewportSize(LOGIN_VIEWPORT);
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByPlaceholder(/^Describe your video idea/).waitFor({ state: 'visible', timeout: 5000 });
  const signIn = page.getByRole('button', { name: 'Sign In', exact: true });
  if (!await signIn.isVisible()) return false;
  const google = page.getByRole('button', { name: 'Continue with Google', exact: true });
  // Server-rendered buttons can be visible before the app attaches handlers.
  // Retry only this harmless entry click once, never Google's sign-in action.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await signIn.click({ timeout: 5000 });
      await google.waitFor({ state: 'visible', timeout: 5000 });
      return true;
    } catch {
      if (!await signIn.isVisible()) return false;
    }
  }
  throw Object.assign(new Error('AIVID did not open its sign-in form. Its page controls are not ready; reconnect to retry.'),
    { statusCode: 502, aividSafe: true });
}

// AIVID may include a description inside the current-value button (for
// example "480p Recommended"). Verify the primary value at the start of
// the CURRENT control, not the menu option or an unrelated button.
function normalizedControlText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function selectedValueMatches(controlText, exactLabel) {
  const text = normalizedControlText(controlText);
  return text === exactLabel || text.startsWith(exactLabel + ' ');
}
const SELECTED_MODEL = Object.freeze({
  aivid_seedance_2_0_fast: /^Seedance 2\.0 \(Fast\)(?=\s|$)/,
  aivid_seedance_2_0_mini: /^Seedance 2\.0 \(Mini\)(?=\s|$)/,
  // Any parenthesized suffix denotes a different model (Mini, Fast, etc.).
  aivid_seedance_2_0: /^Seedance 2\.0(?!\s*\()(?=\s|$)/,
  aivid_seedance_2_5: /^Seedance 2\.5(?=\s|$)/,
});
function selectedModelMatches(controlText, modelId) {
  return Boolean(SELECTED_MODEL[modelId]?.test(normalizedControlText(controlText)));
}
async function choose(page, pattern, exactLabel) {
  const main = page.locator('main').first();
  const current = main.getByRole('button', { name: pattern }).first();
  if (!selectedValueMatches(await current.innerText(), exactLabel)) {
    await current.click();
    await main.getByRole('button', { name: exactLabel, exact: true }).click();
  }
  return current;
}

// Observed AIVID form: Public / <label><input class="sr-only" ...></label> / Private.
// Its checked state is !isPublic. Click the visible label, never the hidden
// input or an unrelated checkbox (for example the reference bypass toggle).
async function setPublicVisibility(main) {
  const group = main.locator('div:has(> span:text-is("Public")):has(> span:text-is("Private"))');
  if (await group.count() !== 1 || !await group.isVisible()) throw new Error('Unknown AIVID privacy control.');
  const checkbox = group.locator('label input[type="checkbox"]');
  if (await checkbox.count() !== 1 || !await checkbox.isEnabled()) throw new Error('Unknown AIVID privacy switch.');
  if (await checkbox.isChecked()) {
    const label = group.locator('label:has(input[type="checkbox"])');
    if (await label.count() !== 1) throw new Error('Ambiguous AIVID privacy switch.');
    await label.click();
  }
  if (await checkbox.isChecked()) throw new Error('AIVID did not select public visibility.');
  return checkbox;
}

// Browser-side duration state can differ from input.value if the site has
// a controlled React slider. Read nearby visible duration labels and ARIA
// values as independent evidence without copying arbitrary page or prompt text.
async function readDurationState(slider) {
  return slider.evaluate(el=>{
    const seconds=text=>{
      const match=String(text||'').trim().match(/^(\d{1,3})\s*(?:s|sec|secs|second|seconds)?$/i);
      return match?Number(match[1]):null;
    };
    const neighbors=[el.previousElementSibling,el.nextElementSibling];
    // Most AIVID layouts place "15s" next to the range input in the same row.
    if(el.parentElement){
      for(const node of el.parentElement.children)if(node!==el)neighbors.push(node);
    }
    const labels=[];
    for(const node of neighbors){
      const text=node?.textContent?.trim();
      const parsed=seconds(text);
      if(parsed!==null&&node?.getClientRects?.().length)labels.push(parsed);
    }
    const now=el.getAttribute('aria-valuenow');
    const ariaText=el.getAttribute('aria-valuetext');
    return {
      value:Number(el.value),
      min:Number(el.min),
      max:Number(el.max),
      step:el.step==='any'?'any':Number(el.step||'1'),
      ariaNow:now===null?null:Number(now),
      ariaText:seconds(ariaText),
      labels:[...new Set(labels)],
    };
  });
}
function durationVerified(state,desired) {
  return Number.isInteger(desired) && state.value===desired &&
    (state.ariaNow===null||state.ariaNow===desired) &&
    (state.ariaText===null||state.ariaText===desired) &&
    state.labels.every(label=>label===desired);
}
async function setAividDuration(slider,seconds){
  if(await slider.count()!==1)throw new Error('Ambiguous AIVID duration control.');
  const state=await readDurationState(slider);
  const {min,max,step}=state;
  if(!Number.isInteger(min)||!Number.isInteger(max)||!Number.isInteger(step)||
    step<1||step>30||min>max||seconds<min||seconds>max||
    (seconds-min)%step!==0)
    throw new Error('Requested length is not available on the current AIVID slider.');
  // Real keyboard events are required so the frontend's controlled state and
  // its quote update, not just the native input value.
  await slider.press('Home');
  if(Number(await slider.inputValue())!==min)throw new Error('AIVID slider did not reset to its minimum.');
  for(let v=min;v<seconds;v+=step){
    await slider.press('ArrowRight');
    if(Number(await slider.inputValue())!==v+step)throw new Error('AIVID slider rejected a duration step.');
  }
  if(!durationVerified(await readDurationState(slider),seconds))
    throw new Error('AIVID duration display differs from its slider.');
  return seconds;
}
async function prepare(page, value, references = [], { onProgress } = {}) {
  const job = validateJob(value, references);
  await step('page_navigation', () => page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }), onProgress);
  await step('session_check', () => waitForSession(page), onProgress);
  const main = page.locator('main').first();
  // Capture the current-model trigger: the model menu can contain an option
  // whose accessible name matches the same label. Only this trigger proves
  // which model is currently selected after the menu closes.
  const modelTrigger = main.getByRole('button', { name: /Seedance|MiniMax/ }).first();
  await step('model_selection', async () => {
    if(selectedModelMatches(await modelTrigger.innerText(),job.modelId))return;
    await modelTrigger.click();
    const candidate=main.getByRole('button',{name:SELECTED_MODEL[job.modelId]}).filter({visible:true});
    // React menus render asynchronously; count() alone does not wait.
    await candidate.first().waitFor({state:'visible',timeout:10000});
    if(await candidate.count()!==1)throw new Error('AIVID model option was not unique.');
    await candidate.click();
  }, onProgress);
  const ratioControl = await step('aspect_ratio', () => choose(page, /^\d+:\d+(?:\s|$)/, job.aspectRatio), onProgress);
  const resolutionControl = await step('resolution', () => choose(page, /^\d+p(?:\s|$)/, job.resolution), onProgress);
  const slider = main.locator('input[type="range"]');
  await step('duration', () => setAividDuration(slider,job.duration), onProgress);
  // Owner-selected Public mode must be set before reading its price.
  // Both the visible form and the outgoing payload independently verify it.
  const privacy = await step('privacy', () => setPublicVisibility(main), onProgress);
  await step('reference_upload', async () => {
    if(references.length){
      const mode=main.getByRole('button',{name:'References',exact:true});
      if(await mode.count()===1){await mode.click();await main.locator('input[type="file"][multiple]').first().waitFor({state:'attached',timeout:10000});}
    }
    for (const kind of Object.keys(FILE_ACCEPT)) {
      const refs = references.filter(ref => ref.kind === kind);
      if (!refs.length) continue;
      await attachReferences(page,main,kind,refs);
    }
  }, onProgress);
  const prompt = promptEditors(page);
  await step('prompt', () => fillPrompt(prompt,job.prompt), onProgress);
  await step('form_verification', async () => {
    // Each failing field has a fixed, non-sensitive code. No prompt, page text,
    // selectors, customer data or authentication details leave the RDP host.
    if (await privacy.isChecked()) throw sessionFailure('form_privacy');
    if (!durationVerified(await readDurationState(slider),job.duration)) throw sessionFailure('form_duration');
    if (await promptValue(prompt) !== job.prompt) throw sessionFailure('form_prompt');
    // Do not mistake a matching *menu option* for the selected model.
    if (!selectedModelMatches(await modelTrigger.innerText(), job.modelId))
      throw sessionFailure('form_model');
    if (!selectedValueMatches(await ratioControl.innerText(), job.aspectRatio))
      throw sessionFailure('form_aspect_ratio');
    if (!selectedValueMatches(await resolutionControl.innerText(), job.resolution))
      throw sessionFailure('form_resolution');
  }, onProgress);
  return job;
}

async function installRequestGuard(page, job, {references=[],beforeGenerate=async()=>{},probe=false,onBlockedRequest}={}) {
  let cdp;
  try { cdp = await page.context().newCDPSession(page); }
  catch { throw sessionFailure('request_guard_setup'); }
  let guardError = null, allowed = false, armed = false, claimed=false, reportedBlockedRequest=false;
  const failure=deferred(),observed=deferred();
  // Once an exact paid POST was released after reservation, unrelated late
  // browser failures must not win the race against its provider response.
  // The accepted response (or an explicit timeout) decides the paid job.
  const fail=error=>{
    if (!guardError) guardError=error;
    if (!allowed) failure.reject(error);
  };
  const uploads=new UploadTracker(references,fail);
  const onResponse=response=>{void uploads.response(response)};
  page.on?.('response',onResponse);
  // Register the event handler BEFORE enabling interception. Fetch.enable can
  // immediately emit requestPaused for requests already in flight. If that
  // first event arrives before the listener exists, Chrome leaves the request
  // paused forever; opening DevTools can appear to "unstick" the tab.
  const handler = async event => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)) {
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {}); return;
    }
    try {
      const url = new URL(event.request.url);
      // AIVID's own invisible reCAPTCHA may make its normal verification
      // request. This does not invoke a solver or manufacture a token.
      if (event.request.method === 'POST' && url.protocol === 'https:' &&
          ['www.google.com', 'www.recaptcha.net'].includes(url.hostname) && url.pathname.startsWith('/recaptcha/')) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }); return;
      }
      if(await uploads.before(event.request)){
        await cdp.send('Fetch.continueRequest',{requestId:event.requestId});return;
      }
      // The generation page refreshes card likes while the submission guard is active.
      if (event.request.method === 'POST' && url.origin === API &&
          url.pathname === '/v2/interactions/likes/bulk' && !url.search && !url.username && !url.password) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }); return;
      }
      if(event.request.method==='POST'&&url.origin===API&&url.pathname==='/v2/sensitive-keywords/check'&&!url.search){
        const check=JSON.parse(event.request.postData||'{}');
        if(normalizePrompt(check.prompt)!==job.prompt)throw sessionFailure('submission_prompt');
        await cdp.send('Fetch.continueRequest',{requestId:event.requestId});return;
      }
      if (event.request.method !== 'POST' || url.origin !== API || url.pathname !== '/v2/generations' || url.search) {
        if (onBlockedRequest && !reportedBlockedRequest) {
          reportedBlockedRequest = true;
          const method = /^[A-Z]{1,16}$/.test(event.request.method) ? event.request.method : 'UNKNOWN';
          // Keep diagnostic output local and omit URL credentials, query values,
          // headers, bodies and path segments that look like opaque identifiers.
          const path = url.pathname.split('/').slice(0,9).map(part =>
            /^[a-z][a-z0-9._-]{0,31}$/i.test(part) && !/^[0-9a-f]{16,}$/i.test(part) ? part : part ? '[redacted]' : ''
          ).join('/');
          try { onBlockedRequest({method, hostname:url.hostname, path}); } catch {}
        }
        // Background POSTs that are not on the allowlist still fail closed,
        // but must not terminate the guarded paid submission. Otherwise a
        // harmless concurrent browser mutation wins the failure race and the
        // finally block navigates away before AIVID answers /v2/generations.
        // If the provider changes its generation endpoint, it remains blocked
        // and no unverified charge can escape the guard.
        await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }).catch(() => {});
        return;
      }
      if (allowed||claimed) throw new Error('A second AIVID submission was blocked.');
      const body = JSON.parse(event.request.postData || '{}');
      const uploaded=await uploads.completed();
      validateSubmission(body, job, uploaded);
      if(claimed)throw new Error('A second AIVID submission was blocked.');
      if(probe){
        claimed=true;
        await beforeGenerate();
        await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Aborted'});
        observed.resolve({uploaded});return;
      }
      if (!armed) throw new Error('AIVID submission was blocked before its durable reservation.');
      claimed=true;
      await beforeGenerate();
      allowed = true;
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
    } catch (error) {
      fail(error?.aividCode ? error : sessionFailure('submission_payload'));
      await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }).catch(() => {});
    }
  };
  cdp.on('Fetch.requestPaused', handler);
  // Intercept every mutation, not just today's generation path. If the site
  // moves generation to a new path or host it must not escape this guard.
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  } catch {
    cdp.off?.('Fetch.requestPaused', handler);
    page.off?.('response',onResponse);
    await cdp.detach().catch(()=>{});
    throw sessionFailure('request_guard_setup');
  }
  return { arm() { if(probe)throw new Error('Reference checks cannot authorize generation.');armed = true; },
    failure:failure.promise,observed:observed.promise,get error() { return guardError; }, get allowed() { return allowed; }, get claimed() { return claimed; },
    close: async () => { cdp.off?.('Fetch.requestPaused',handler);page.off?.('response',onResponse);await cdp.send('Fetch.disable').catch(() => {}); await cdp.detach().catch(() => {}); } };
}

// Public video pages can say "Video not found." until a newly accepted job
// becomes publishable. This is not evidence of failure or a lost login.
async function collectionState(page,{timeoutMs=15000}={}){
  const status=page.locator('dt').filter({hasText:/^Status$/}).locator('xpath=following-sibling::dd[1]');
  const deadline=Date.now()+timeoutMs;
  do{
    if(new URL(page.url()).origin!==ORIGIN)throw new Error('AIVID collection left the expected site.');
    if(await status.count()===1 && await status.isVisible()){
      const text=(await status.innerText()).trim().toLowerCase();
      if(['failed','cancelled','canceled'].includes(text))return 'failed';
      if(['pending','queued','processing','generating','running','in progress'].includes(text))return 'pending';
      if(text==='completed')return 'completed';
      throw new Error('AIVID video status is not recognized.');
    }
    if(await page.getByText('Video not found.',{exact:true}).filter({visible:true}).count())return 'pending';
    await new Promise(resolve=>setTimeout(resolve,200));
  }while(Date.now()<deadline);
  throw new Error('AIVID video detail is not ready. The existing job will be retried.');
}

class AividBrowserlessClient {
  constructor({ connectUrl, maxSourceCredits = 0, connect = connectSession, download = null, collectFromHistory = null, onProgress = null, onBlockedRequest = null } = {}) {
    this.connectUrl = connectUrl; this.maxSourceCredits = maxSourceCredits; this.connect = connect; this.download = download; this.collectFromHistory = collectFromHistory; this.onProgress = onProgress;
    this.onBlockedRequest = onBlockedRequest;
  }
  async withPage(fn) {
    const session = await step('browser_connection', () => this.connect(this.connectUrl), this.onProgress);
    try { return await fn(session.page); }
    finally { await session.close(); } // Retains the persistent session; never DELETE its stop URL.
  }
  async preflight(value, references = []) {
    return this.withPage(async page => {
      const job = await prepare(page, value, references, { onProgress: this.onProgress });
      const credits = await step('credit_reading', async () => creditState(await page.locator('body').innerText()), this.onProgress);
      return { ready: true, model: job.modelLabel, modelId: job.modelId, duration: job.duration, resolution: job.resolution,
        aspectRatio: job.aspectRatio, referenceCounts: job.counts, ...credits, submitted: false };
    });
  }
  async startVideo(value, references = [], { beforeClick } = {}) {
    if (typeof beforeClick !== 'function') throw new Error('A durable submission reservation is required.');
    if (!Number.isFinite(this.maxSourceCredits) || this.maxSourceCredits <= 0) throw new Error('Set an explicit AIVID source credit limit before submission.');
    return this.withPage(async page => {
      const job = await prepare(page, value, references, { onProgress: this.onProgress });
      const credits = await step('credit_reading', async () => creditState(await page.locator('body').innerText()), this.onProgress);
      if (credits.price <= 0 || credits.price > this.maxSourceCredits || credits.balance < credits.price)
        throw new Error('AIVID price exceeds the limit or the account has insufficient credits.');
      const guard = await step('request_guard_setup', () => installRequestGuard(page, job,{references,onBlockedRequest:this.onBlockedRequest,beforeGenerate:async()=>{
        await confirmSubmissionPrice(page, credits.price);
        // Uploads and final file IDs have been verified. Persist the receipt
        // immediately before releasing the one paused paid request.
        await step('submission_reservation',()=>beforeClick({price:credits.price}));
      }}), this.onProgress);
      try {
        const responsePromise = page.waitForResponse(isGenerationResponse, { timeout: 120000 }).catch(() => null);
        guard.arm();
        let clickFailed=false;
        try { await page.locator('main').first().getByRole('button', { name: 'Generate', exact: true }).click(); }
        catch { clickFailed=true; }
        // Playwright can reject the click while an already-dispatched, paid
        // network request is still waiting for its response. Never navigate
        // away merely because the click promise rejected after interception.
        if(clickFailed&&!guard.allowed&&!guard.claimed)
          return {state:'rejected',errorCode:guard.error?diagnosticCode(guard.error):'submission_click'};
        if(this.onProgress)this.onProgress('waiting_for_generation_response');
        const response = await Promise.race([responsePromise,guard.failure.catch(()=>null)]);
        if (guard.error && !guard.allowed) return { state: 'rejected', errorCode: diagnosticCode(guard.error) };
        if (!response) return { state: 'submission_uncertain' };
        let body; try { body = await response.json(); } catch {}
        return { ...submissionResult(response.status(), body), price: credits.price };
      } finally {
        // Stop the page before removing interception: a late web-app retry
        // must not escape the guard after our response timeout.
        try{await page.goto('about:blank#cmmtools-worker',{timeout:10000})}catch{await page.close().catch(()=>{})}
        await guard.close();
      }
    });
  }
  async checkReferences(value,references=[]){
    if(!references.length)throw new Error('Reference checks require test media.');
    return this.withPage(async page=>{
      const job=await prepare(page,value,references,{onProgress:this.onProgress});
      const before=creditState(await page.locator('body').innerText());
      if(before.balance<before.price)throw new Error('AIVID needs sufficient balance to open its upload flow; no video will be submitted.');
      const guard=await installRequestGuard(page,job,{references,probe:true,onBlockedRequest:this.onBlockedRequest,beforeGenerate:()=>confirmSubmissionPrice(page,before.price)});
      try{
        const check=Promise.race([guard.observed,guard.failure]);check.catch(()=>{});
        await page.locator('main').first().getByRole('button',{name:'Generate',exact:true}).click();
        const result=await bounded(check,120000);
        if(guard.allowed||result.uploaded.length!==references.length)throw new Error('Reference check did not block generation.');
        await page.goto(ORIGIN+'/',{waitUntil:'domcontentloaded',timeout:30000});
        await waitForSession(page);
        const after=creditState(await page.locator('body').innerText());
        if(after.balance!==before.balance)throw new Error('AIVID balance changed during the reference check; inspect account history.');
        return {ready:true,verified:true,submitted:false,generationBlocked:true,modelId:job.modelId,
          duration:job.duration,resolution:job.resolution,aspectRatio:job.aspectRatio,uploadedCounts:job.counts,
          price:before.price,balanceBefore:before.balance,balanceAfter:after.balance};
      }finally{try{await page.goto('about:blank#cmmtools-worker',{timeout:10000})}catch{await page.close()}await guard.close();}
    });
  }
  async collectVideo(id) {
    if (!ID.test(String(id))) throw new Error('Invalid AIVID job ID.');
    return this.withPage(async page => {
      if(this.collectFromHistory)return this.collectFromHistory(page,id);
      await page.goto(ORIGIN + '/videos/' + encodeURIComponent(id), { waitUntil: 'domcontentloaded', timeout: 30000 });
      const state=await collectionState(page);
      if(state==='completed'&&this.download)return {state:'completed',output:await this.download(page)};
      if(state!=='completed')return {state};
      const cdp = await page.context().newCDPSession(page);
      let timer, listener;
      try {
        const enabled = await cdp.send('Browserless.setDownloadEnabled', { enabled: true });
        if (!enabled?.ok) throw new Error('Browserless download streaming is unavailable.');
        const downloaded = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('AIVID video download timed out.')), 60000);
          listener = file => {
            if (file.error || file.mimeType !== 'video/mp4' || !Number.isSafeInteger(file.size) || file.size <= 0 ||
                file.size > MAX_OUTPUT_BYTES || typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_OUTPUT_BYTES / 3) * 4)
              return reject(new Error('AIVID did not return a supported MP4 within the download limit.'));
            const data = Buffer.from(file.data, 'base64');
            if (data.length !== file.size || data.length < 12 || data.toString('ascii', 4, 8) !== 'ftyp')
              return reject(new Error('AIVID returned an invalid MP4.'));
            resolve({ state: 'completed', output: { data, mimeType: 'video/mp4' } });
          };
          cdp.on('Browserless.fileDownloaded', listener);
        });
        // Handle rejection immediately, including when the click itself fails.
        downloaded.catch(() => {});
        await page.getByRole('button', { name: 'Download Video', exact: true }).click();
        return await downloaded;
      } finally {
        clearTimeout(timer); if (listener) cdp.off('Browserless.fileDownloaded', listener);
        await cdp.send('Browserless.setDownloadEnabled', { enabled: false }).catch(() => {});
        await cdp.detach().catch(() => {});
      }
    });
  }
}

module.exports = { AividBrowserlessClient, validateJob, validateSubmission, creditState, providerId, submissionResult,
  isGenerationResponse, waitForSession, promptEditors, promptValue, normalizePrompt, fillPrompt, openLoginPage, prepare, installRequestGuard, DIAGNOSTICS, diagnosticCode, diagnosticMessage, selectedValueMatches, selectedModelMatches, collectionState, fileInputKind, readDurationState, durationVerified, setAividDuration, MINI, ID };

'use strict';

(() => {
  if (location.origin !== 'https://aivid.dev' || location.pathname !== '/') return;
  if (globalThis.cmmAividFill) return;

  const models = {
    aivid_seedance_2_0_mini: /^Seedance 2\.0 \(Mini\)(?=\s|$)/,
    aivid_seedance_2_0_fast: /^Seedance 2\.0 \(Fast\)(?=\s|$)/,
    aivid_seedance_2_0: /^Seedance 2\.0(?!\s*\()(?=\s|$)/,
    aivid_seedance_2_5: /^Seedance 2\.5(?=\s|$)/,
  };
  const fileTypes = {
    image: /^(?:image\/|\.(?:jpe?g|png|webp)$)/,
    video: /^(?:video\/|\.(?:mp4|mov)$)/,
    audio: /^(?:audio\/|\.(?:mp3|wav)$)/,
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = element => (element?.innerText || '').replace(/\s+/g, ' ').trim();
  const shown = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
  const all = (root, selector) => [...root.querySelectorAll(selector)];
  const exact = label => element => text(element) === label;
  const leading = label => element => exact(label)(element) || text(element).startsWith(label + ' ');
  const buttons = root => all(root, 'button,[role="button"]').filter(shown);
  const editorFor = root => only(all(root, 'textarea,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]').filter(shown), 'prompt editor');
  const sliderFor = root => only(all(root, 'input[type="range"]').filter(shown), 'duration slider');
  const privacyFor = root => only(all(root, 'div').filter(element => {
    const spans = [...element.children].filter(child => child.tagName === 'SPAN').map(text);
    return shown(element) && spans.includes('Public') && spans.includes('Private');
  }).flatMap(group => all(group, 'label input[type="checkbox"]:enabled')), 'Public / Private switch');

  function only(elements, label) {
    if (elements.length !== 1) throw new Error('AIVID’s ' + label + ' is missing or ambiguous.');
    return elements[0];
  }

  async function until(check, label, timeout = 5000) {
    const end = Date.now() + timeout;
    do {
      const result = check();
      if (result) return result;
      await wait(80);
    } while (Date.now() < end);
    throw new Error('AIVID did not show ' + label + '.');
  }

  async function choose(root, control, selected, option, label) {
    if (!selected(control)) {
      control.click();
      const options = await until(() => {
        const matches = buttons(root).filter(button => button !== control && option(button));
        return matches.length && matches;
      }, label + ' option');
      only(options, label + ' option').click();
      await until(() => selected(control), 'the selected ' + label);
    }
    return control;
  }

  function setValue(input, value) {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function previewLabels(root) {
    return all(root, '*').filter(node => !node.childElementCount && shown(node) && /^@(image|video|audio)\d+$/.test(text(node))).map(text);
  }

  function durationMatches(slider, duration) {
    const labels = [...slider.parentElement.children].filter(node => node !== slider && shown(node)).map(text)
      .filter(label => /^\d+\s*s$/.test(label)).map(label => Number.parseInt(label, 10));
    return Number(slider.value) === duration && labels.every(value => value === duration) &&
      (!slider.hasAttribute('aria-valuenow') || Number(slider.getAttribute('aria-valuenow')) === duration);
  }

  let session;
  let currentFile;
  async function start(settings) {
    const root = document.querySelector('main');
    if (!root || buttons(document).some(button => /^(sign|log) in$/i.test(text(button)))) {
      throw new Error('Sign in and open the AIVID video generator.');
    }
    const prompt = editorFor(root);
    if ((prompt.value ?? prompt.innerText).trim() || previewLabels(root).length) {
      throw new Error('Open a fresh AIVID form first to avoid mixing two requests.');
    }
    const modelMatch = models[settings.model];
    if (!modelMatch) throw new Error('This AIVID model is unsupported.');
    const matchesModel = element => modelMatch.test(text(element));
    const model = await choose(root, buttons(root).find(button => /^(Seedance|MiniMax)\b/.test(text(button))),
      matchesModel, matchesModel, 'model');
    const ratio = await choose(root, buttons(root).find(button => /^\d+:\d+(?:\s|$)/.test(text(button))),
      leading(settings.aspectRatio), exact(settings.aspectRatio), 'aspect ratio');
    const resolution = await choose(root, buttons(root).find(button => /^\d+p(?:\s|$)/.test(text(button))),
      leading(settings.resolution), exact(settings.resolution), 'resolution');
    const slider = sliderFor(root);
    if (settings.duration < Number(slider.min) || settings.duration > Number(slider.max)) {
      throw new Error('The requested duration is unavailable in AIVID.');
    }
    if (!durationMatches(slider, settings.duration)) setValue(slider, settings.duration);
    await until(() => durationMatches(sliderFor(root), settings.duration), 'the selected duration');
    const privacy = privacyFor(root);
    if (privacy.checked) privacy.closest('label').click();
    await until(() => !privacyFor(root).checked, 'Public visibility');
    session = { root, settings, controls: { model, ratio, resolution }, matchesModel, counts: { image: 0, video: 0, audio: 0 } };
    currentFile = null;
  }

  async function attach() {
    const { root, counts } = session;
    const { kind, mimeType, chunks } = currentFile;
    const inputMatches = () => all(root, 'input[type="file"]:enabled').filter(input => {
      const accept = input.accept.toLowerCase().split(',').map(value => value.trim());
      const kinds = Object.keys(fileTypes).filter(key => accept.some(value => fileTypes[key].test(value)));
      return kinds.length === 1 && kinds[0] === kind;
    });
    if (!Object.values(counts).some(Boolean)) {
      const refs = buttons(root).filter(exact('References'));
      if (refs.length) only(refs, 'References button').click();
    }
    const inputs = await until(() => inputMatches().length && inputMatches(), kind + ' reference input');
    const input = only(inputs, kind + ' reference input');
    const index = counts[kind] + 1;
    const extensions = { 'image/jpeg': 'jpg', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3' };
    const file = new File(chunks, 'reference-' + kind + '-' + index + '.' + (extensions[mimeType] || mimeType.split('/')[1]), { type: mimeType });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => previewLabels(root).includes('@' + kind + index), 'the preview for ' + kind + ' ' + index, 30000);
    counts[kind] = index;
    currentFile = null;
  }

  async function finish() {
    const { root, settings, controls, matchesModel, counts } = session;
    const prompt = editorFor(root);
    const expected = settings.prompt.replace(/\r\n?/g, '\n');
    prompt.focus();
    if (prompt.tagName === 'TEXTAREA') setValue(prompt, expected);
    else {
      prompt.innerText = expected;
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: expected }));
    }
    prompt.blur();
    await wait(500);
    const editor = editorFor(root);
    if ((editor.value ?? editor.innerText) !== expected || !matchesModel(controls.model) ||
        !leading(settings.aspectRatio)(controls.ratio) || !leading(settings.resolution)(controls.resolution) ||
        !Object.values(controls).every(control => control.isConnected && shown(control)) ||
        !durationMatches(sliderFor(root), settings.duration) || privacyFor(root).checked) {
      throw new Error('AIVID did not retain every requested setting.');
    }
    const expectedLabels = Object.entries(counts).flatMap(([kind, count]) => Array.from({ length: count }, (_, index) => '@' + kind + (index + 1)));
    const labels = [...new Set(previewLabels(root))].sort();
    if (labels.join(',') !== expectedLabels.sort().join(',')) throw new Error('AIVID did not retain all reference previews.');
    session = null;
    const prices = all(root, '*').filter(node => !node.childElementCount && shown(node))
      .map(node => /^(\d+(?:\.\d+)?)\s+Credits?\s*\/\s*Video$/i.exec(text(node))).filter(Boolean);
    if (prices.length !== 1 || Number(prices[0][1]) !== settings.sourceCredits) {
      return 'Form filled. The visible price could not be verified against the saved quote (' + settings.sourceCredits +
        ' AIVID credits). Resolve the price before clicking Generate.';
    }
    return 'Form filled. Review the prompt, references and Public price, then click Generate on AIVID.';
  }

  globalThis.cmmAividFill = async (action, payload) => {
    try {
      if (action === 'start') await start(payload);
      else if (!session) throw new Error('Open a fresh AIVID form and fill the request again.');
      else if (action === 'file') currentFile = { ...payload, chunks: [] };
      else if (action === 'chunk') currentFile.chunks.push(Uint8Array.from(atob(payload), char => char.charCodeAt(0)));
      else if (action === 'attach') await attach();
      else if (action === 'finish') return { ok: true, value: await finish() };
      return { ok: true };
    } catch (error) {
      session = null;
      currentFile = null;
      return { ok: false, error: error.message };
    }
  };
})();

'use strict';

const button = document.getElementById('fill');
const status = document.getElementById('status');
const endpoint = 'https://cmmtools.site/admin/aivid/manual/packet';
const CHUNK_BYTES = 256 * 1024;

function base64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the downloaded reference.'));
    reader.readAsDataURL(blob);
  });
}

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Reading the copied request…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://aivid.dev' || new URL(tab.url).pathname !== '/') {
      throw new Error('Open the AIVID generator at aivid.dev and sign in.');
    }
    const clipboard = await navigator.clipboard.readText();
    const token = /^CMMTOOLS_AIVID_V1 ([\w.-]{80,140})$/.exec(clipboard.trim())?.[1];
    if (!token) throw new Error('Use Copy request in CMMTools Admin first.');
    const get = async (suffix = '') => {
      const response = await fetch(endpoint + suffix, {
        headers: { Authorization: 'Bearer ' + token }, credentials: 'omit', redirect: 'error',
        cache: 'no-store', signal: AbortSignal.timeout(60000),
      });
      if (response.status === 403) throw new Error('This request expired or changed. Copy it again in Admin.');
      if (!response.ok) throw new Error('CMMTools could not read this request or reference. Try again.');
      return response;
    };
    const request = await (await get()).json();
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fill.js'] });
    const target = { tabId: tab.id, documentIds: [injection.documentId] };
    const run = async (action, payload = null) => {
      const [result] = await chrome.scripting.executeScript({
        target, func: (name, value) => globalThis.cmmAividFill(name, value), args: [action, payload],
      });
      if (!result?.result?.ok) throw new Error(result?.result?.error || 'The AIVID form could not be filled. Refresh it and try again.');
      return result.result.value;
    };
    const { references, ...settings } = request;
    await run('start', settings);
    for (const [index, ref] of references.entries()) {
      status.textContent = 'Attaching reference ' + (index + 1) + ' of ' + references.length + '…';
      const blob = await (await get('/' + ref.position)).blob();
      if (blob.type !== ref.mimeType || !blob.size || blob.size > 30 * 1024 * 1024) {
        throw new Error('CMMTools returned an invalid reference file.');
      }
      // Send small JSON-safe chunks to the isolated script. Reference bytes
      // can exceed a single Chrome message after serialization.
      await run('file', ref);
      for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
        await run('chunk', await base64(blob.slice(offset, offset + CHUNK_BYTES)));
      }
      await run('attach');
    }
    status.textContent = await run('finish');
  } catch (error) {
    status.textContent = error.message + ' If fields or files were filled, review or refresh the form before retrying.';
  } finally {
    button.disabled = false;
  }
});

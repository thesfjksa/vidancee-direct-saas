"use strict";
const heading = document.getElementById("heading");
const detail = document.getElementById("detail");
const retry = document.getElementById("retry");
let navigating = false;

function continueToStudio() {
  if (navigating) return;
  navigating = true;
  retry.hidden = true;
  document.body.classList.remove("error");
  detail.textContent = "Checking your connection before opening Studio…";
  chrome.runtime.sendMessage({type:"CMMTOOLS_START_NAVIGATION"}, response => {
    const error = chrome.runtime.lastError?.message || (!response?.ok && response?.error);
    if (error || !response?.ok) {
      navigating = false;
      document.body.classList.add("error");
      heading.textContent = "Studio needs another try";
      detail.textContent = error || "Unable to open the editor.";
      retry.hidden = false;
    }
  });
}
retry.addEventListener("click", continueToStudio);
// Let a few animation frames paint before navigating to the remote website.
setTimeout(continueToStudio, 850);

const openSettings = document.createElement('button');
openSettings.className = 'retry'; openSettings.textContent = 'Connection settings';
openSettings.addEventListener('click', () => chrome.runtime.sendMessage({type:'CMMTOOLS_OPEN_SETTINGS'}));
document.querySelector('.launch-card').appendChild(openSettings);
const connectionPoll = setInterval(() => {
  chrome.runtime.sendMessage({type:'CMMTOOLS_PROXY_STATUS'}, response => {
    if (!navigating || !response?.ok) return;
    const state = response.result;
    if (state?.phase === 'testing') detail.textContent = 'Testing ' + state.label + '…';
  });
}, 1000);
window.addEventListener('pagehide', () => clearInterval(connectionPoll));

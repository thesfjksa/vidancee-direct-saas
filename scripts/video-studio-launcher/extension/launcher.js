"use strict";
const heading = document.getElementById("heading");
const detail = document.getElementById("detail");
const retry = document.getElementById("retry");
let working = false;

function launch() {
  if (working) return;
  working = true;
  document.body.classList.remove("error");
  retry.hidden = true;
  heading.textContent = "Opening your workspace";
  detail.textContent = "Preparing your studio window…";
  chrome.runtime.sendMessage({type: "CMMTOOLS_OPEN_STUDIO"}, response => {
    working = false;
    const error = chrome.runtime.lastError?.message || (!response?.ok && response?.error);
    if (error || !response?.ok) {
      heading.textContent = "Could not launch Studio";
      detail.textContent = error || "Please try again.";
      document.body.classList.add("error");
      retry.hidden = false;
      return;
    }
    detail.textContent = response.result?.reused ? "Studio window is ready." : "Studio window opened.";
    // On most browsers the popup closes itself when the new window gains focus.
    setTimeout(() => window.close(), 850);
  });
}
retry.addEventListener("click", launch);
// This page is displayed immediately on clicking the toolbar icon; launch automatically.
launch();

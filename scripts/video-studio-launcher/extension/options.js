"use strict";
const DEFAULTS = { hideBilling: true, hideReferral: true, hideBranding: true, hideFooter: true, lockCreditButton: true, customCSS: "" };
const idEl = document.getElementById("extensionId");
const statusEl = document.getElementById("status");
idEl.textContent = chrome.runtime.id;
chrome.storage.sync.get(DEFAULTS, saved => {
  for (const [key, value] of Object.entries({ ...DEFAULTS, ...saved })) {
    const el = document.getElementById(key);
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = String(value || "");
  }
});
document.getElementById("save").addEventListener("click", () => {
  const updated = {};
  for (const key of Object.keys(DEFAULTS)) {
    const el = document.getElementById(key);
    updated[key] = el.type === "checkbox" ? el.checked : el.value;
  }
  chrome.storage.sync.set(updated, () => {
    statusEl.textContent = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Saved. Changes apply automatically to open studio pages.";
  });
});
document.getElementById("copyId").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(chrome.runtime.id); statusEl.textContent = "Extension ID copied."; }
  catch (_) { statusEl.textContent = "Select and copy the extension ID above."; }
});
document.getElementById("launch").addEventListener("click", () => {
  chrome.runtime.sendMessage({type: "CMMTOOLS_OPEN_STUDIO"}, response => {
    statusEl.textContent = chrome.runtime.lastError?.message || (response?.ok ? "Video Studio opened." : response?.error || "Unable to open window.");
  });
});

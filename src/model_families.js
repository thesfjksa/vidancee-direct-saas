'use strict';

// Sources name the same model differently, e.g. the AI Gateway's
// "Nano Banana Pro (Gemini 3 Pro Image)" is ArgoLink's "Nano Banana Pro".
// The family key matches them for de-duplication and credit failover.
function modelFamily(label) {
  const text = String(label || '').toLowerCase().replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const nano = text.match(/nano banana(?: (pro|2\.1|2 lite|2))?\b/);
  if (nano) return 'nano banana' + (nano[1] ? ' ' + nano[1] : '');
  return text.replace(/[^a-z0-9.]+/g, ' ').trim();
}

module.exports = { modelFamily };

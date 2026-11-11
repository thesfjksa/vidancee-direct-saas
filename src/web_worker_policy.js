'use strict';

// The customer-facing Hostinger app must not launch a second generation worker
// unless the operator explicitly enables the legacy embedded-worker mode.
// Standalone worker.js has its own setting and is unaffected by this default.
function webWorkerEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.WORKER_ENABLED ?? '').trim());
}

module.exports = { webWorkerEnabled };

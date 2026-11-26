'use strict';

// Public Dope brand for the existing WXKSAI integration.
// All upstream credentials, model IDs, database/provider keys, and queued jobs
// keep their original values. No migration or paid task resubmission is needed.
const LEGACY_PREFIX = 'wxksai_';
const PUBLIC_PREFIX = 'dope_';

function customerModelId(id) {
  const value = String(id || '');
  return value.startsWith(LEGACY_PREFIX) ? PUBLIC_PREFIX + value.slice(LEGACY_PREFIX.length) : value;
}
function storedModelId(id) {
  const value = String(id || '');
  return value.startsWith(PUBLIC_PREFIX) ? LEGACY_PREFIX + value.slice(PUBLIC_PREFIX.length) : value;
}
function customerModelLabel(label) {
  return typeof label === 'string' ? label.replace(/wxksai/gi, 'Dope') : label;
}
function customerProviderAccess(access = {}) {
  const { wxksai, puream, ...other } = access;
  return { ...other, dope: wxksai === true, ...(Object.hasOwn(access,'puream')?{new:puream===true}:{}) };
}
module.exports = { customerModelId, storedModelId, customerModelLabel, customerProviderAccess };

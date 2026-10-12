const crypto = require('node:crypto');

function assetSecret() { return String(process.env.PROVIDER_ASSET_SECRET || process.env.ADMIN_TOKEN || ''); }
const { appUrl } = require('../app_url.js');

function assetSignature(generationId, position) {
  const secret = assetSecret();
  if (!secret) throw new Error('PROVIDER_ASSET_SECRET or ADMIN_TOKEN is required for signed provider asset URLs.');
  return crypto.createHmac('sha256', secret).update(String(generationId) + ':' + Number(position)).digest('hex');
}

function providerAssetUrl(generationId, position) {
  const base = appUrl();
  if (!base) throw new Error('APP_URL is required for provider reference-image routing.');
  const sig = assetSignature(generationId, position);
  return base + '/provider-assets/' + encodeURIComponent(generationId) + '/' + Number(position) + '?sig=' + sig;
}

function verifyAssetSignature(generationId, position, supplied) {
  if (!supplied) return false;
  const expected = assetSignature(generationId, position);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(supplied));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A finished video handed to a provider (the upscaler). Signed with a position
// no reference image can have, so the link cannot open anything else.
const OUTPUT_POSITION = 65535;
function providerOutputUrl(generationId) {
  const base = appUrl();
  if (!base) throw new Error('APP_URL is required for provider media routing.');
  return base + '/provider-outputs/' + encodeURIComponent(generationId) + '?sig=' + assetSignature(generationId, OUTPUT_POSITION);
}
function verifyOutputSignature(generationId, supplied) { return verifyAssetSignature(generationId, OUTPUT_POSITION, supplied); }

module.exports = { providerAssetUrl, verifyAssetSignature, providerOutputUrl, verifyOutputSignature };

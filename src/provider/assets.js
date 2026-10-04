const crypto = require('node:crypto');

function assetSecret() { return String(process.env.PROVIDER_ASSET_SECRET || process.env.ADMIN_TOKEN || ''); }
function appUrl() { return String(process.env.APP_URL || '').replace(/\/$/, ''); }

function assetSignature(generationId, position) {
  const secret = assetSecret();
  if (!secret) throw new Error('PROVIDER_ASSET_SECRET or ADMIN_TOKEN is required for provider image URLs.');
  return crypto.createHmac('sha256', secret).update(String(generationId) + ':' + Number(position)).digest('hex');
}

function providerAssetUrl(generationId, position) {
  const base = appUrl();
  if (!base) throw new Error('APP_URL is required for CreatePulse image-to-video routing.');
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

module.exports = { providerAssetUrl, verifyAssetSignature };

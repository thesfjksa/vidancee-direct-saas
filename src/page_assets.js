'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const PUBLIC = path.join(__dirname, '..', 'public');
const readAsset = name => fs.readFileSync(path.join(PUBLIC, name), 'utf8');
const ADMIN_JS = new Set(['dope-performance.js','provider-admin.js','aivid-admin.js','longai-admin.js']);
const STUDIO_JS = new Set(['dope-performance.js','voice-studio.js','voice-picker.js','video-tools.js','payment-qr.js']);
const scriptTag = /<script src="\/([a-z0-9-]+\.js)(?:\?[^"]*)?"><\/script>/gi;

// Admin HTML is sent no-store. Deliver the matching local scripts with it so
// a proxy/browser's cached older script can never silently reject a new tab or
// provider. Keep the existing stylesheet inlining and script execution order.
function renderAdminPage(html = readAsset('admin.html'), read = readAsset) {
  return html.replace(/<link rel="stylesheet" href="\/(brand|admin|site-visuals)\.css(?:\?[^"]*)?">/g, (tag, name) => {
    return '<style>' + read(name + '.css').replace(/<\/style/gi, '<\\/style') + '</style>';
  }).replace(scriptTag, (tag, file) => {
    if (!ADMIN_JS.has(file)) return tag;
    return '<script data-inline-asset="' + file + '">' + read(file).replace(/<\/script/gi, '<\\/script') + '</script>';
  });
}
// Studio JavaScript is larger and shared across visits. Use the actual asset
// bytes in its cache key rather than relying on manually incremented versions.
function renderStudioPage(html = readAsset('index.html'), read = readAsset) {
  return html.replace(scriptTag, (tag, file) => {
    if (!STUDIO_JS.has(file)) return tag;
    const hash = createHash('sha256').update(read(file)).digest('hex').slice(0,16);
    return '<script src="/' + file + '?v=' + hash + '"></script>';
  });
}
module.exports = { renderAdminPage, renderStudioPage };

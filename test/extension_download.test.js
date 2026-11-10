'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const assetName = 'CMMTools_Video_Studio_Launcher_v1.5.zip';
const assetPath = path.join(root, 'public', 'downloads', assetName);

test('Video Studio extension ZIP is committed with essential Chrome/Edge files', () => {
  const bytes = fs.readFileSync(assetPath);
  assert.ok(bytes.length > 5000 && bytes.length < 5 * 1024 * 1024, 'ZIP has expected bounded size');
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'ZIP local header');
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, 'ZIP end of central directory exists');
  assert.ok(bytes.readUInt16LE(end + 10) >= 16, 'ZIP includes bundled extension files');
  for (const name of ['extension/manifest.json', 'extension/background.js',
      'extension/studio.js', 'extension/studio.css', 'extension/loading.html',
      'extension/launcher.html', 'extension/brand/icon-128.png', 'README.md']) {
    assert.ok(bytes.includes(Buffer.from(name)), 'ZIP includes ' + name);
  }
});

test('top navigation offers extension download immediately after Library', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const library = html.indexOf('data-section="library"');
  const download = html.indexOf('class="extension-download"');
  const actions = html.indexOf('class="nav-actions"');
  assert.ok(library >= 0 && download > library && download < actions, 'download appears after Library before account controls');
  assert.match(html, /href="\/downloads\/CMMTools_Video_Studio_Launcher_v1\.5\.zip"/);
  assert.match(html, /download="CMMTools_Video_Studio_Launcher_v1\.5\.zip"/);
  assert.match(html, /aria-label="Download CMMTools Video Studio extension"/);
  // Keep the download control visually aligned with Library, not an oversized promo pill.
  assert.match(html, /class="extension-download"[^>]+>[\\s\\S]*?<span>Extension<\\/span><\\/a>/);
  assert.doesNotMatch(html, /<span>Download Extension<\\/span>/);
  const css = fs.readFileSync(path.join(root, 'public', 'studio.css'), 'utf8');
  assert.match(css, /\.main-nav\s*>\s*a\.extension-download/);
  assert.match(css, /a\\.extension-download\\s*\\{[\\s\\S]*?height:\\s*42px/);
  assert.match(css, /a\\.extension-download\\s*\\{[\\s\\S]*?background:\\s*transparent/);
  assert.doesNotMatch(css, /a\\.extension-download\\s*\\{[^}]*#eefafa/);
});

test('download endpoint supports GET and HEAD with ZIP attachment headers', () => {
  const code = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(code, /routePath==='\/downloads\/CMMTools_Video_Studio_Launcher_v1\.5\.zip'/);
  assert.match(code, /'content-type':'application\/zip'/);
  assert.match(code, /'content-disposition':'attachment; filename="CMMTools_Video_Studio_Launcher_v1\.5\.zip"'/);
  assert.match(code, /req\.method==='HEAD'\?undefined:file/);
});

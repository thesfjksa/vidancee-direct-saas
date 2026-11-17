'use strict';

const LEGACY_ZIP = '/downloads/CMMTools_Video_Studio_Launcher_v1.5.zip';
function storeUrl(env = process.env) {
  const id = String(env.CHROME_WEB_STORE_EXTENSION_ID || '').trim();
  return /^[a-p]{32}$/.test(id) ? 'https://chromewebstore.google.com/detail/' + id : '';
}
function page(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · CMMTools</title><style>
  :root{color-scheme:dark;font:16px/1.65 system-ui,sans-serif;background:#0b1420;color:#edf5ff}*{box-sizing:border-box}body{margin:0;padding:48px 22px}main{max-width:720px;margin:auto}a{color:#9bdfff}h1{font-size:clamp(28px,5vw,42px);line-height:1.2}h2{font-size:21px;margin-top:32px}.button{display:inline-block;background:#99eee4;color:#08252b;padding:12px 22px;border-radius:10px;font-weight:700;text-decoration:none}.notice{padding:18px;border:1px solid #3f5b73;border-radius:12px;background:#142537}li{margin:10px 0}nav{margin-top:36px;display:flex;gap:24px;flex-wrap:wrap}</style></head><body><main><a href="/app">CMMTools</a>${content}<nav><a href="/extension">Install extension</a><a href="/extension/privacy">Extension privacy</a><a href="/app">Back to Studio</a></nav></main></body></html>`;
}
function installPage(env) {
  const url = storeUrl(env);
  return page('Install extension', `<h1>Your studio, a click away.</h1>
  <p>The CMMTools Video Studio Launcher opens your AIVID workspace in a separate window with CMMTools display preferences. Sign in with your own AIVID account on the provider website.</p>
  ${url ? `<p><a class="button" href="${url}" rel="noopener noreferrer">Add to Chrome</a></p><ol><li>Open the Chrome Web Store listing and click <strong>Add to Chrome</strong>.</li><li>Review the permissions and confirm <strong>Add extension</strong>.</li><li>Pin CMMTools from your browser’s Extensions menu, then click its icon to open Studio.</li></ol><p>Chrome handles extension updates automatically. Microsoft Edge users can use this listing too; Edge may ask you to allow extensions from other stores.</p>` : '<p class="notice" role="status"><strong>Chrome Web Store installation is not available yet.</strong><br>The listing must be published before Add to Chrome becomes available. The manual download below remains available in the meantime.</p>'}
  <p>Browser confirmation is required. Web Store installation removes the ZIP extraction, Developer mode and Load unpacked steps.</p>
  <details><summary>Manual installation / existing unpacked users</summary><p><a href="${LEGACY_ZIP}" download="CMMTools_Video_Studio_Launcher_v1.5.zip">Download the manual ZIP</a></p><p>Extract to a permanent folder, open your browser’s Extensions page, enable Developer mode and Load unpacked, then select the extension folder containing manifest.json.</p><p>When moving to the store version, remove the unpacked copy after installing to avoid duplicate icons. The store copy has a different extension ID; reapply display preferences if needed.</p></details>
  <p>This launcher customizes the provider page locally. It does not include a VPN, proxy connection or automatic route selection.</p>`);
}
function privacyPage() {
  return page('Extension privacy', `<h1>Video Studio Launcher privacy</h1><p>Effective 17 November 2026. This policy covers the CMMTools Video Studio Launcher extension.</p>
  <h2>What the extension does</h2><p>The launcher opens https://aivid.dev in a separate browser window and runs bundled display customization on AIVID pages. It reads page text, navigation labels, links and layout locally to apply your selected display preferences. It can change titles, icons, navigation and footer visibility, and the header credit-purchase button’s interaction.</p>
  <h2>Stored settings</h2><p>Display preferences and optional custom CSS are saved using Chrome’s storage.sync API and may sync through your browser account according to your browser settings. A window identifier is kept in storage.session so the launcher can focus the existing Studio window; it is cleared when that window closes or the browser session ends.</p>
  <h2>Collection and sharing</h2><p>The extension has no analytics or telemetry and does not send page contents, passwords, cookies, prompts or generated media to CMMTools. It does not sell personal data. The extension code does not read account credentials or authentication cookies.</p>
  <p>You sign in and use generation services directly on AIVID. The provider receives the information you submit there under its own policies. Your normal use of the CMMTools website is separate from the extension.</p>
  <h2>Permissions and control</h2><p>The storage permission saves preferences. Site access is limited to AIVID pages for display changes. The CMMTools website can send a request to open the Studio window. The extension does not provide a VPN or proxy service. Change preferences in Extension options, disable site access, or uninstall through your browser’s Extensions page. Uninstalling removes the installed extension; browser sync data is managed through your browser account.</p>
  <h2>Questions</h2><p>Contact CMMTools support through your CMMTools account for privacy questions or extension support.</p>`);
}
function handleExtensionDistribution(req, res, routePath, env = process.env) {
  if (!['/extension', '/extension/privacy'].includes(routePath)) return false;
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, {allow: 'GET, HEAD', 'cache-control': 'no-store'});
    res.end();
    return true;
  }
  const body = Buffer.from(routePath === '/extension' ? installPage(env) : privacyPage());
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'content-length': body.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer'});
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
module.exports = {storeUrl, handleExtensionDistribution};

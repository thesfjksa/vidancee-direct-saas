# CMMTools Windows Premium Studio — manually opened Edge AIVID tab, no Playwright

## What this replaces

The previous **Windows Premium Studio** launched a second Microsoft Edge profile through Playwright and exposed remote mouse, keyboard, reference uploads and downloads. That private automated browser frequently hit AIVID/Cloudflare CAPTCHA and Google login challenges. This version **retires that viewer route** and replaces it with a **view-only screenshot relay** from the owner's ordinary Microsoft Edge AIVID tab, selected by the owner using a separate installed Edge extension.

**The new viewer and extension do not use Playwright, Puppeteer, CDP, a scripted AIVID page, content scripts, DOM modification, Selenium or automated clicks/typing.** They only capture Edge's current active AIVID tab via \`chrome.tabs.captureVisibleTab\` after a user gesture and explicit Start Sharing. No other tab or Windows desktop is shared. Screenshots are displayed in CMMTools every ~2.5–3s. A screenshot stream is **not** interactive remote control or full-frame-rate video.

This design **does not remove Playwright from the separate existing paid-generation AIVID-Agent.exe**, which has its own RDP job queue, receipts and collection. That agent is **not required for manual view-only sharing**. If automated jobs trigger challenges, pause new queued AIVID submissions in Admin before using the manual browser; do not interrupt uncertain paid submissions or remove their receipts.

## Owner setup — all GUI, no Linux, no CLI, no environment changes

1. Deploy the merged GitHub \`main\` to the existing Hostinger CMMTools web application. No new VPS, background relay server, Windows agent binary, command line, or environment variables.
2. Visit **CMMTools Admin → Provider → Connections → AIVID → Windows Premium Studio**. Turn on **Enable view-only AIVID tab sharing**, add an existing active CMMTools login email or user ID (start with your own), acknowledge that manual AIVID Generate clicks are billed directly to AIVID, and save settings.
3. Click **Download Edge extension ZIP**. Extract ZIP; on existing Windows RDP, open ordinary Microsoft Edge → \`edge://extensions\` → enable **Developer mode** → **Load unpacked** → choose the extracted folder containing \`manifest.json\`. Do not install the older AIVID Handoff extension for tab sharing.
4. Still in Admin, click **Generate one-time pairing code**. The code is valid **five minutes**. Use **Copy code**.
5. In **your normal Edge window**, manually visit \`https://aivid.dev/\`, sign in and resolve any verification as you normally do. Do **not** use AIVID-Login.exe or the browser launched by AIVID-Agent.exe for this screen-share workflow.
6. With the **AIVID tab selected**, click the **CMMTools Manual AIVID Tab Share** extension icon. A separate small controller window opens. Paste the code, click **Pair this extension** and **Start sharing**. Keep the AIVID tab selected in the original window and leave the controller window open.
7. In CMMTools, open **Windows Premium Studio**, \`https://cmmtools.site/aivid-live-studio\`, signed in as an explicitly approved customer. The page shows **view-only screenshots** and updated connection status. All AIVID actions (CAPTCHA, clicks, Generate, files) are performed **manually in normal Edge**.
8. Stop sharing using the extension **Stop & revoke** button, Admin **Stop all sharing**, or turn off Windows Studio in Admin. Every Admin settings save revokes previously paired extension access; pair again after any access change.

## Security

- **Admin authorization**: existing \`x-admin-token\` gate for the Admin endpoint and ZIP. Exact trusted-user allowlist and AIVID Sources opt-out on every viewer frame/status request, loaded from existing Admin-backed \`app_settings\`.
- **One-time pairing**: 128-bit CSPRNG code, server stores only SHA-256, valid five minutes, eight attempts, single-use. Generated only via Admin; code is not logged. Pairing yields a fresh 256-bit bearer token in **extension controller memory only** (not persistent browser storage), bound to that extension's \`chrome-extension://\` origin. Token hash only is retained server-side. Two-hour absolute expiry; administrative revoke takes effect immediately.
- **Transport**: HTTPS POST screenshots to \`/api/aivid-tab-share/frame\`, each compressed JPEG max **350 KiB**, 1.4s min interval. No screenshots or tokens persisted in MySQL/files: latest JPEG is stored in the Node web process memory only and expires from view after **12 seconds** without a new frame. Browser requests are \`cache-control: no-store\`.
- **Tab isolation**: Manifest V3 \`activeTab\` permission only (temporary access granted when you click the extension), CMMTools HTTPS host permission only, no \`content_scripts\`, \`scripting\`, \`debugger\`, \`desktopCapture\`, \`webRequest\` or \`<all_urls>\`. Owner click grants temporary \`activeTab\`. The controller verifies selected tab ID, active tab, and HTTPS AIVID hostname **both before and after capture**. Switching tabs, navigating to Google OAuth, or leaving AIVID pauses capture rather than sharing non-AIVID content. Very rapid tab changes between checks are a known screenshot-API limitation; do not share sensitive third-party tabs in the same browser window.
- **Single Node instance**: pairing and screenshot state are in the web process only. Hostinger's multiple server replicas, process restarts or load balancer without sticky sessions will break this version. No claim of multi-instance support or reliable low-latency video.
- **Protected screenshots**: the viewer serves JPEG bytes only to a signed-in, explicitly allowed CMMTools user with enabled AIVID access. Frame data is not written to public storage. Treat the screenshots as private account data.
- **No remote control or file-transfer gateway** in this build: the old remote click/typing/upload/download APIs return HTTP **410 Gone**; the extension has no power to click AIVID or access local Windows files. Manual Edge downloads/uploads still work in the browser's own ordinary workflow.
- **Direct provider billing**: the owner may manually click AIVID Generate, which charges their AIVID provider account, without CMMTools wallet reservations/receipts. Viewers cannot trigger Generate.
- **CAPTCHA risk**: this removes the specific Playwright-launched browser from the new *viewer*. It does **not** guarantee AIVID will not issue CAPTCHA, and must not be presented as a bypass. Respect AIVID login/security policies and ask AIVID support about approved integrations.

## Verification and rollout status

- \`src/aivid_tab_share.js\` owns the short-lived in-memory paired session and viewer/admin route handlers.
- \`scripts/aivid-tab-share-extension/\` contains the unpacked Edge MV3 extension (manifest, background, controller UI and screenshot sender).
- \`public/aivid-windows-studio.html\` replaces remote input controls with view-only HTTPS JPEG polling.
- \`public/admin.html\`, \`public/aivid-admin.js\`, \`server.js\` wire the pair/install/revoke controls in the existing AIVID Admin panel.
- \`test/aivid_tab_share.test.js\` validates the pairing lifecycle, token and extension-origin binding, old API shutdown, screenshot TTL, strict viewer auth, and manifest/control-code nonautomation.
- **Still needs an actual Windows RDP Microsoft Edge test with AIVID** to validate extension permission behavior, Capture API under RDP/minimized windows, and Hostinger deployment. No real AIVID CAPTCHA, generation, or video transfer is automated or verified.

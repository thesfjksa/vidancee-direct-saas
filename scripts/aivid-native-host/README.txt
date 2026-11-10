UPDATE — Interactive Studio image/input quality fix (10 November 2026)
If you see a connected screen that looks tiny or blurry, or buttons say "Sent" but nothing moves:
- Re-download this ZIP after redeploying the latest CMMTools main, close the old helper and use this updated Start-CMMTools-Remote.cmd.
- The helper now captures up to 1600-pixel-wide JPEGs at quality up to 76, refreshing about once per second (previously 1280 / quality 44 / every 1.5 seconds).
- The web viewer offers Fit, Actual size, Theater and Fullscreen, plus direct keyboard control: click the webpage preview then type on your keyboard (no Playwright).
- A command now shows Queued followed by Executed in Windows Edge, or a specific Windows blocked message. It is not enough for CMMTools merely to say Queued.
- If input is blocked, keep the AIVID Edge window IN THE FOREGROUND (not the black PowerShell window, Windows desktop, another application or a file-picker).
- To type a long prompt, click the desired AIVID field in the viewer, use the Compose text input below the preview and select Send text. Each chunk waits for Windows execution confirmation.
- If clicks work but the font remains small, use Fullscreen/Theater, set your Windows RDP display resolution higher and Edge zoom to 100% or 125%. Do not raise zoom until you can see the Generate controls clearly.
- Remote file selection and MP4 transfer still require local host assistance.
- Native helper still needs Windows verification; if Windows UI Automation cannot safely identify the webpage rectangle, sharing pauses instead of exposing the Edge URL bar.

CMMTools Windows Interactive Host (NO Playwright)

Purpose:
Give one approved CMMTools customer restricted, interactive use of your manually opened normal Microsoft Edge AIVID page. The customer sees the webpage area, not the Edge URL bar or Windows desktop. Clicks, typing, and scrolling use Windows-native input APIs (NOT Playwright/CDP/page JavaScript).

IMPORTANT SECURITY:
- This is an experimental pilot, not hardened multi-tenant RDP.
- Use a dedicated STANDARD (non-administrator) Windows account with no other personal data, secrets, apps, or windows. Never run on your admin desktop.
- Sign in to AIVID yourself first. Manually complete any CAPTCHA. Do not share your AIVID cookies, passwords, or RDP credentials.
- The helper locks to the visible foreground Microsoft Edge AIVID window and attempts to capture ONLY its document viewport by UI Automation / Chrome renderer bounds. It stops screenshots if document bounds cannot be verified. Overlays on top of the browser could still appear in captures; keep the dedicated session clean.
- Remote user may click Generate; AIVID charges its provider account DIRECTLY, NOT CMMTools wallet. The host does NOT impose CMMTools generation limits.
- No native Windows file-picker / download transfer yet. Use for text/video generation controls; file selection and media downloads remain local to the host Windows session.
- Hostinger must have ONE sticky Node web instance. Session state is held in process memory; a web restart or load balancer replica disconnects it.

NO-CLI INSTALLATION:
1. Extract this ZIP to a private folder on your Windows RDP.
2. In Microsoft Edge, sign into https://aivid.dev manually in the dedicated standard Windows user.
3. Prefer installing AIVID as an Edge app using Edge menu > Apps > Install this site as an app. This gives it a dedicated window without an address bar and keeps your manually authenticated Edge profile. You can also keep normal Edge open, because the helper attempts to capture the webpage renderer only.
4. CMMTools Admin > Provider > Connections > AIVID > Windows Premium Studio: enable the trusted CMMTools viewer email/user ID, acknowledge direct billing, Save.
5. Admin > Interactive Windows Host > Generate one-time code. It expires after 5 minutes.
6. Double-click Start-CMMTools-Remote.cmd (do NOT Run as Administrator) and enter the one-time pairing code when prompted. The .cmd uses Windows PowerShell 5.1 and runs the included .ps1 as a locally invoked user script; inspect it before running.
7. Return focus to the dedicated AIVID Edge app/window. Keep that window at the foreground and unlocked, with no overlapping windows. The helper pauses when it is not the active AIVID Edge window.
8. The approved CMMTools user opens https://cmmtools.site/aivid-interactive-studio. Their clicks/type/scroll are relayed as native Windows input only to the verified webpage rectangle.
9. Stop by Admin > Stop Windows Host, or close the PowerShell helper. It expires automatically after 90 minutes.

The above does not guarantee CAPTCHA-free access. It does NOT use the existing AIVID-Agent.exe for customer control, so you can keep the automated paid jobs separate. Existing in-flight paid submissions must not be interrupted.

Troubleshooting:
- 'No AIVID Edge window found': make sure the AIVID page's WINDOW TITLE contains AIVID, open in Edge and stay signed in.
- 'Webpage viewport not exposed': Windows UI Automation could not locate the Edge document; the helper refuses to stream browser chrome/address bar, instead of falling back to sharing the full screen. Try an updated Edge version and a maximized application window.
- 'Window not in foreground': click your AIVID browser; do not minimize RDP, sign out, or lock Windows.
- If PowerShell or Windows policy prohibits scripts, do not override your organization's controls. Use an authorized remote-desktop solution instead.
- If browser dialog opens, local operator must handle it; remote input only controls the AIVID webpage viewport.

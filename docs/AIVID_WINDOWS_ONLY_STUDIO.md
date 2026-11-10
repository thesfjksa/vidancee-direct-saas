# Windows-only Interactive AIVID Premium Studio — no Linux VPS, no CLI

**State:** Feature implemented but **disabled by default**. Automated GitHub checks do not prove Google accepts the new Edge profile, live Hostinger/Windows latency, large transfers, or real paid outputs. Do not claim this is a full remote Windows desktop: it is an **isolated Microsoft Edge page surface** relayed to CMMTools by the already-paired Windows agent over existing outbound HTTPS.

This replaces Guacamole as the **preferred interactive** route when enabled. No new server, Apache Guacamole, Tailscale, inbound RDP port, Browserless instance, or Linux command line is required. The previous optional Guacamole viewer remains disabled and available only for separate installations. The existing AIVID paid queue, quoted prices, receipts, auto-collection, saved Edge profile and customer credits are unchanged.

## Architecture

1. A signed-in CMMTools user opens \`https://cmmtools.site/aivid-live-studio\`.
2. The web app checks a **separate explicit Windows-view user ID/email allowlist**, the existing customer **AIVID Sources** opt-out, and the admin's \`AIVID_WINDOWS_VIEW_DIRECT_BILLING_ACK\` flag. Nothing operates with the flag off.
3. The customer clicks **Open private Edge**. The app creates a short-lived \`live\` command in the existing \`aivid_rdp_commands\` table.
4. The **existing paired Windows AIVID-Agent.exe** polls that command over authenticated outbound HTTPS, starts Microsoft Edge with the profile \`.aivid-live-profile-u<customerId>\` (never \`.aivid-rdp-edge-profile\`), and captures a JPEG of the isolated browser **page**. The screenshot is returned as short-lived request data, **not** public storage.
5. Customer click, scroll, type, safe keypress and snapshot operations use the same single-use MySQL RPC. Each command is removed on completion. Refresh is typically every six seconds when visible. This is interactive browser automation, **not full-frame-rate RDP streaming**, and is slower on congested hosts.
6. Reference uploads travel through CMMTools HTTPS to bounded 1 MiB chunks in the existing \`aivid_rdp_chunks\` table, transferred to the *actual Edge page's intercepted file chooser*. Upload staging prevents the agent from claiming half-finished files. Individual files up to 30 MiB.
7. When the AIVID Edge page initiates an actual completed MP4 download, the Windows agent receives its Playwright download handle. **Save finished video** sends the MP4 back over the already-authenticated agent relay in 1 MiB chunks with size/hash/header validation. The CMMTools request sends the bytes to the **same logged-in user**, using a local browser download. MP4 transfers up to 100 MiB; other download formats are not yet supported.
8. One active isolated browser **per agent**, one approved customer at a time, with a **15-minute absolute session expiry**. Any other user is rejected while the first browser is active. A new browser **profile** is used for each customer and persists for that customer's later login, but lives under the **same Windows OS account as the agent**. It is NOT an OS sandbox or separate Windows logon; do not mistake it for a general-purpose RDP customer account.

## No-CLI setup (Hostinger + Windows)

- Hostinger web application's **Environment Variables** UI: add the following *on the CMMTools web app only* (not the worker):
  - \`AIVID_WINDOWS_VIEW_ENABLED=true\`
  - \`AIVID_WINDOWS_VIEW_ALLOWED_IDS=<CMMTools_user_ID>\` (start with **your own** account only)
  - \`AIVID_WINDOWS_VIEW_DIRECT_BILLING_ACK=true\` **only after** acknowledging that manual provider Generate clicks bill the directly signed-in AIVID account without using CMMTools wallet controls
- Leave \`AIVID_RDP_VIEW_ENABLED=false\`; that is the older, separate Guacamole integration. \`AIVID_WINDOWS_VIEW_ALLOWED_EMAILS\` is an optional alternative allowlist to IDs, but use specific trusted users only.
- Redeploy **both** Hostinger web and worker applications from the latest GitHub \`main\`; check deployed revision and logs. Web app needs MySQL reads/writes to the existing \`aivid_rdp_commands\` and \`aivid_rdp_chunks\` tables.
- Keep your **already-paired Microsoft Edge-only AIVID-Agent.exe** running on Windows. The existing verified \`AIVID-Agent.exe\` managed updater recognizes the **unchanged six-file release manifest**, retrieves a new signed/hash-verified release while idle, and restarts the managed worker between jobs. No new CLI or replacement EXE is required if the compatible v3.0.3 bootstrap is installed. Never stop it while a paid submission/collection is uncertain.
- Open CMMTools Video Studio → select a **Premium** model → **Open secure Premium desktop** (link is the preexisting label; the page itself clearly states it is a **browser-only** view), or visit \`https://cmmtools.site/aivid-live-studio\`.
- Click **Open private Edge** and manually sign into AIVID within that dedicated, empty Edge profile. Google's sign-in policy may block browsers launched with automation controls, and CAPTCHA may still require manual interaction; this flow does not bypass either.
- Click the AIVID website's actual upload/select input, then use **Upload reference to AIVID** to select a local file. The page accepts PNG, JPG, WebP, MP4, MOV, WebM, MP3, WAV and M4A, one file per chooser, up to 30 MiB.
- To download, initiate the provider's **Download** button in the Edge preview, then click **Save finished video** in CMMTools when ready. Only finished MP4 files up to 100 MiB are supported. Do not repeatedly click Generate if a paid submission status is uncertain.

## Security/billing constraints

- **Not a full desktop:** Unlike RDP/Guacamole, the browser-only relay never publishes the Windows desktop, Windows file browser, address bar, terminal, clipboard, OS hotkeys, user's regular Edge profile or the automated agent's saved profile. The Edge context prevents top-level navigation away from AIVID/Google origins and blocks HTTP/private-IP resources. Only a narrow allowlist of keyboard keys and **text insertion** are accepted.
- **Same Windows OS account:** Separate Edge user-data directories are not an isolation boundary against arbitrary browser exploits or hostile websites. Enable only trusted users, ideally the owner account, not public customers. An independent Windows OS account/VM is needed for genuinely untrusted customer sessions; the single existing Windows agent cannot safely become unrestricted public RDP.
- **Direct upstream billing:** Interactive AIVID Generate is outside CMMTools' submission queue, spending limits, refunds, history, customer wallet and receipts. There is **no profit/credit protection** for an interactive customer click. Do not enable for general paying customers until billing/authorization is redesigned and independently verified.
- **Availability:** The agent handles browser RPC one at a time alongside queued paid jobs; it does not interrupt an in-flight job, but could delay the next pending operation. Status \`needs_verification\` on the *automated* Edge profile does not prevent using a separate isolated browser. This second profile will require its own login.
- **Data:** Short-lived MySQL chunks are deleted with the RPC. Real-world Hostinger MySQL quota limits and request timeouts may restrict file sizes below the coded maximum. Actual uploads/downloads, Google OAuth, CAPTCHA and source video generation remain unverified until an owner-controlled non-paid acceptance test.
- **Recovery:** If the feature fails or causes latency, turn \`AIVID_WINDOWS_VIEW_ENABLED=false\` in Hostinger and redeploy the web app. Existing paid AIVID queue and agent pairing are not changed. For production issues inspect the current handoff and agent logs; never resubmit uncertain paid clips.

## Developer notes and tests

- \`src/aivid_windows_live.js\`: CMMTools page/API, same-origin writes, allowed customer Sources, normalized browser controls, bounded raw uploads and response MP4 downloads.
- \`src/aivid_rdp.js\`, \`src/aivid_rdp_http.js\`: separate \`live\` RPC result validation, chunk input/output paths and staged command support without making any existing paid-job submission/receipt changes.
- \`scripts/aivid-rdp/native.cjs\`: isolated native Edge profile and restricted interactive page surface; no direct OS input.
- \`scripts/aivid-rdp/agent.cjs\`: live commands from existing paired agent, hash-verified uploads and MP4 relay; normal commands unchanged.
- \`public/aivid-windows-studio.html\`: native interactive CMMTools UI (click/scroll, text, special keys, file selector and MP4 save).
- Runtime compatibility: **six managed files unchanged** in \`src/aivid_runtime.js\` and \`scripts/aivid-rdp/worker.cjs\`, so the existing Windows launcher does not need replacement.
- \`test/aivid_windows_live.test.js\`: default-deny, source/billing settings, blocked shortcuts, private-address/navigation restrictions, separate profile and mocked file chooser, no-VPS UI authorization, managed manifest compatibility.

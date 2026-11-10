# CMMTools AIVID Interactive Live Studio (private pilot)

## What this does

At `/aivid-live-studio`, an allowlisted user can operate the real AIVID page in a **Browserless Live URL iframe**. This is not a direct `https://aivid.dev` iframe and not the Windows RDP automation agent. Browserless streams the actual remote browser's tabs as an interactive canvas, including the native provider login and video editor. The remote session is isolated per CMMTools user, limited to two sessions in parallel, and automatically expires within ten minutes. The CMMTools page includes a toolbar for transferring reference uploads and saved video downloads.

The embedded view uses `Browserless.liveURL({mode:'follow',interactable:true,showBrowserInterface:true})` so the user can switch between popup tabs such as the provider's Google login. There is **no automated CAPTCHA solver, identity impersonation, or claim that Google OAuth succeeds**. Google may reject automated or embedded browsers. If Google refuses the sign-in, use **Open in browser** to visit AIVID in the user's **own regular browser**; its cookies are **not** transferred into the cloud iframe. Neither CAPTCHA nor Google OAuth can be guaranteed to work in Browserless. Do not market the viewer as solving CAPTCHAs.

## Human reference-upload and download flow

1. Customer clicks **Open Studio** while logged into a separately authorized AIVID account in the remote browser (or attempts normal sign-in there).
2. In the **embedded AIVID page**, click its own reference upload button. The Playwright `filechooser` event is captured on the backend and the local **Choose local...** input appears in the CMMTools toolbar. The user selects files from their own computer and clicks **Upload selected files**. The server transfers those files to the precise clicked `input[type=file]` via `Browserless.uploadFile`. A tag is applied to that input only temporarily to target it; it is removed after the transfer. Server-side constraints: max **30 files, 45 MiB total, 30 MiB per file**, PNG/JPG/WebP, MP4/MOV/WebM, MP3/WAV/M4A only. Actual AIVID file and plan limits still apply. Uploading references **does not** click Generate.
3. Customer submits the video using the original AIVID controls, with provider-direct billing. After finishing, click the original AIVID **Download** action. `Browserless.setDownloadEnabled` sends completed remote downloads to the authenticated backend with `Browserless.fileDownloaded`. Video files named .mp4, .mov or .webm (up to 60 MiB and subject to Browserless's own stricter transfer cap) appear in **Downloads ready to save**; the CMMTools user can download them once from an authenticated same-user endpoint. At most three completed videos are temporarily held in memory. They disappear after download or when the live session expires. A download that opens as an ordinary page instead of triggering a browser download will **not** be captured; in that case use the regular-browser link.
4. The page polls the current authenticated session's transfer status. Neither file bytes nor session URLs are published to other customers, client-side logs, or any shared catalog. The iframe URL is a short-lived bearer credential and should not be shared.

## Security and billing

**Off by default**, as in the previous pilot. Set on the Hostinger web process:

```ini
AIVID_LIVE_VIEW_ENABLED=false
AIVID_LIVE_VIEW_ALLOWED_EMAILS=
AIVID_LIVE_VIEW_ALLOWED_IDS=
AIVID_LIVE_VIEW_BROWSERLESS_WS=
AIVID_LIVE_VIEW_DIRECT_BILLING_ACK=false
```

To test, install a Browserless plan supporting `Browserless.liveURL`, `Browserless.uploadFile` and `Browserless.setDownloadEnabled`, save the secure token-containing WSS URL server-side, explicitly acknowledge provider-direct billing, and enable only the exact CMMTools test account in the ID/email allowlist. This uses **separate browser identities** from any existing Windows Edge RDP account. Do not put a shared privileged AIVID account in this viewer: a user could view its credit balance, history, personal details and account capabilities.

The web app requires signed-in CMMTools identity for each request, validates same-origin writes, and checks that the user owns the current live session. It does not expose the Browserless API token. Uploaded files and downloads are held in memory only during transfer/session lifetime. Do not allow untrusted users to access someone else's saved Browserless page. The remote-browser direct Generate click **does not** deduct CMMTools wallet credits, reserve balances, enforce CMMTools source caps, or log a CMMTools generation job; AIVID itself bills the account used by the customer. Arrange independent customer billing and provider-account permissions before enabling.

## Verification and limitations

- Tests exercise allowlisting, sign-in popup-follow mode, file chooser targeting, upload payload, downloaded video validation, and same-origin gating with synthetic browser events. No actual Google credentials, AIVID paid jobs or customer media were used in CI.
- Before production activation, perform manual smoke tests on **your own authorized Browserless plan, a separately owned AIVID test account, and a real browser**: Google login or provider alternate login; human CAPTCHA prompts; all three reference types and the exact input; video Download event and streaming limit; two simultaneous users isolated. Browserless may prevent the Google flow, so its success **cannot** be promised.
- In particular, this is **not a direct iframe workaround** for AIVID's `frame-ancestors` / X-Frame-Options restrictions. CMMTools displays a browser stream. Google sign-in in an embedded environment may be refused by Google; regular-browser fallback is provided without credential bridging.
- Browserless cloud browser costs are extra; 10-minute session/size limits apply. Production Hostinger deploy is a separate step and is unverified in the code-change task. The separate server-owned Premium quotes, AIVID RDP Edge agent and historical queued jobs are not modified.

Reference documentation: https://docs.browserless.io/baas/monitor-sessions/embedding-live-url and https://docs.browserless.io/examples/file-transfers and https://developers.google.com/identity/protocols/oauth2/web-server

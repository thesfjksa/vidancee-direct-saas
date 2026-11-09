# CMMTools AIVID Live Studio Pilot

This is a **private, explicitly enabled pilot** to show the actual AIVID website in a branded CMMTools page at \`/aivid-live-studio\`. It embeds a remote-browser canvas, **not** an aivid.dev iframe, and injects a basic CMMTools page skin. AIVID's actual video-generation controls remain functional inside the session if the browser is logged in, but branding selectors may need adjustment as AIVID changes its DOM.

## Prerequisites

- A configured Browserless account that supports \`Browserless.liveURL\` with an interactive Live URL. This route **does not reuse the existing Windows RDP browser profile**; it starts a separate cloud browser per allowlisted CMMTools user. Browserless could require a separate AIVID sign-in. Google/AIVID login compatibility has not been verified.
- A dedicated AIVID account/browser session for each customer. Do **not** share the owner's automation account with a customer: that would expose account data, generation history, source credits, and could interfere with existing paid collection.
- Explicit operator acceptance that **CMMTools credits are not deducted** by this interactive pilot. The browser's Generate button pays the upstream provider directly. Use a separate approved billing arrangement; the pilot is not a replacement for the existing server-owned CMMTools credit reservation flow.

## Hostinger web-service environment (disabled by default)

\`\`\`ini
AIVID_LIVE_VIEW_ENABLED=false
AIVID_LIVE_VIEW_ALLOWED_EMAILS=
AIVID_LIVE_VIEW_ALLOWED_IDS=
AIVID_LIVE_VIEW_BROWSERLESS_WS=
AIVID_LIVE_VIEW_DIRECT_BILLING_ACK=false
\`\`\`

For a *single pre-approved pilot account only*, enable the feature, set **exactly that** CMMTools customer email or ID on its allowlist, supply a secure Browserless websocket endpoint with a token from your Browserless dashboard, and set \`AIVID_LIVE_VIEW_DIRECT_BILLING_ACK=true\` only after you arrange billing independently. **Never place the Browserless API token in a customer page or commit it to GitHub.** The server creates an expiring viewer URL and sends it only to that authenticated customer's browser. The viewer URL itself acts as a bearer credential; never share it.

Open \`https://cmmtools.site/aivid-live-studio\` while logged in as the allowed user, select **Open Studio**, sign into the dedicated AIVID session if needed, and use the real UI. Browser sessions expire after ten minutes and are limited to two at once. **End session** disconnects the cloud browser. A page reload can resume an active session for the same user.

## Current limits / validation before production

- Browserless must remain available; this is **not** a direct iframe and is **not** connected to the existing AIVID Windows RDP worker. Browserless cloud costs are extra.
- CMMTools wallet metering, generation idempotency, queue history, and paid retry/collection protection **do not cover** generations clicked directly inside the remote browser. No automatic customer credit charge should be assumed.
- Branded CSS and navigation text rewriting are best-effort only. Test exact logos, footer, popups and navigation after AIVID updates. Google login, reference uploads, media downloads, and actual model output require live verification.
- The feature is **off by default**, separate from customer Video Studio and from the retired AIVID model IDs; it never silently enables any source/model or uses existing Windows RDP browser credentials.
- No live Browserless session, AIVID login, customer payment, Hostinger deployment or end-to-end video generation was performed as part of this implementation.

## Validation

Run \`npm test\` plus the repository's existing browser/admin checks. Deploy **only the Hostinger web service** if piloting; the separate worker and Windows agent do not change. Then verify the customer account allowlist, a real interactive live view, actual source billing, reference upload/download, and user-session isolation before client use.

Reference: https://docs.browserless.io/baas/monitor-sessions/embedding-live-url

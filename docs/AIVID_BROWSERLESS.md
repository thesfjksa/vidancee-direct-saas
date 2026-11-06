# AIVID through Browserless: owner pilot

This is the first cloud integration stage. It replaces the need for a Windows
RDP browser with a Browserless persistent Chrome session. It includes a CLI,
an internal CMMTools generation queue, safe recovery and admin setup.
No customer model is registered or enabled yet. There has been no authenticated
Browserless/AIVID end-to-end test. Do not advertise it as working production
generation until the acceptance checks below pass.

## What is implemented

- Persistent session creation and manual Google/AIVID login using a temporary
  Browserless Live URL. The Google password never enters the CMMTools CLI.
- Mini form preparation for 4–15 s, 480p/720p, 16:9/9:16/1:1, including image,
  video and audio inputs. These controls were observed on the public site on
  November 5, 2026. Upload acceptance still requires an authenticated test.
- An explicit source-credit ceiling and a separate global charge switch.
- A CDP request guard requiring exact job settings, public visibility, and
  the expected reference count/kinds before allowing the web-app POST.
  An unknown provider payload schema aborts before forwarding. No API access
  token extraction, CAPTCHA solving, proxy rotation or login bypass is used.
- A pre-click reservation. Unknown outcomes remain held for account-history
  reconciliation. No automatic resubmission or timeout refund of unknown jobs.
- Completed video retrieval from the source detail page using Browserless
  download events, with a 100 MiB MP4 limit, then existing CMMTools storage.
- The standalone CLI saves local MP4s. Queue jobs use CMMTools storage and its
  existing transactional, idempotent customer refund function.

## Set up in Admin

No environment variables, terminal commands or session files are needed for
dashboard setup.

1. Open `/admin-console`, unlock Admin, and choose **Provider**.
2. In **AIVID · Browserless connection**, enter your Browserless API key,
   choose a region and session lifetime supported by your plan, then click
   **Save Browserless key**. The key is encrypted in shared app_settings and
   never returned to the page. Leave the field blank to keep a saved key.
3. Click **Connect aivid**. The server creates a persistent session if one
   is needed, saves it encrypted, and opens a short-lived login attempt.
4. Click **Open aivid login window**. In that private cloud browser, complete
   Google/AIVID sign-in yourself. Your Google password is not submitted to
   CMMTools. The window lasts up to approximately two minutes; Google can
   still reject a cloud browser.
5. Return to Admin and click **Verify sign-in**. The server checks AIVID,
   closes the browser, reconnects to the same persisted profile and verifies
   sign-in again. Only then does the panel say **Sign-in verified**. The worker
   can use the saved session immediately; there is no manual install step.
6. Click **Check connection** to check the form, balance and price without
   generating or charging for a video.

The browser link grants temporary account control and is shown only through
authenticated, no-store login responses. It is not put in browser storage or
activity logs. Refreshing Admin resumes status from the shared database; a
different web process can receive **Verify sign-in** or **Close login window**.
The login owner keeps the remote browser connected and shares the same MySQL
lock as the queue, so another worker cannot use it during sign-in.

The sign-in viewer uses a fixed 1024 × 720 viewport with interaction explicitly
enabled, keeps the page in the foreground, and hides Browserless's navigation
frame. It follows new tabs/popups for Google sign-in. The fixed viewport prevents
different viewers from repeatedly resizing the same remote page. Both the CLI
and Admin use the same viewer settings. JPEG quality is set to 30 to reduce
stream bandwidth. The viewport contains 28% fewer pixels than the previous
1280 × 800 view. The server opens AIVID's **Sign In** dialog before delivering
the link, leaving **Continue with Google**, credentials and verification to
the owner. An already signed-in profile is left signed in.

Admin and the viewer show the short login-window countdown. The 1/7/30/90-day
setting controls the saved profile's lifetime, not the connected login window.
Viewer timeout/disconnection clears the link and releases the login lock;
neither event proves authentication. Reconnect to reopen the saved profile.

Browserless Free limits each connection to two minutes. CMMTools cannot extend
that provider limit; the login wait remains bounded and does not automatically
reconnect. A longer paid-plan limit alone does not establish that the stream
will be responsive. The lower-bandwidth view still needs a live owner test.
See the provider's [session limits](https://docs.browserless.io/baas/session-management/standard-sessions)
and [bandwidth options](https://docs.browserless.io/baas/advanced-configurations/hybrid-automation-configurations).

In the owner's original live window, the page rendered and a dropdown click did
not open it; the stream later reported its time limit. The fixed-viewport viewer
is a mitigation that still requires a live account retest. Mock browser checks
do not prove Browserless mouse/keyboard forwarding or Google login.

**Connect aivid** normally reuses the saved session. After expiry or an unusable
session, **Session recovery → Create new login session** starts a replacement.
Replacement is blocked while AIVID generations are outstanding. The previous
session record is kept encrypted, and no existing profile is deleted. Session
lifetimes are absolute and limited by your Browserless plan. Dashboard settings
take precedence over legacy environment settings.

Customer model activation remains disabled pending live generation/reference
verification. Saving a key or verifying login never enables customer billing.

### Setup errors

Saving a key stores it encrypted; it does not validate it with Browserless.
**Connect aivid** makes the session request. Failures now show the HTTP status
and a fixed, actionable explanation and remain visible after refreshing status.
Raw upstream responses, API tokens and connection URLs are never displayed.

- **HTTP 401/403:** Copy the current API token (only the token, not a full
  URL) from Browserless, save it, and reconnect. Check account permissions,
  units and endpoint access if it still fails.
- **Lifetime rejected:** Start with **1 day**, save settings, and reconnect.
  Longer persistent-session lifetimes depend on the Browserless plan.
- **No available units:** Check usage and billing in Browserless.
- **HTTP 429:** Close unused Browserless connections, then retry. CMMTools
  does not create extra sessions or retry automatically.
- **Server cannot reach Browserless:** Retry or choose another region and
  save settings. Database/encryption failures have separate CMMTools messages.

An authentication error alone cannot prove that a key is incorrect: Browserless
can also reject account limits or feature access. Diagnose the displayed status
before changing the subscription. No customer video is generated during setup.

## Optional command-line setup

Use Node 20+ and `npm install`. `playwright-core` does not download a local
browser. Run on a trusted computer or the application host. Keep the local
state folder on persistent, private storage.

1. Set `BROWSERLESS_API_TOKEN` in the trusted host's environment. Never put it
   in frontend code, a customer API response, a screenshot or a Git commit.
2. Run `npm run aivid:browserless -- create-session`. It creates a one-day
   persistent Chrome session and saves `.aivid-browserless/session.json`.
   `BROWSERLESS_SESSION_TTL_MS` can change the lifetime within your plan limits.
   `BROWSERLESS_ENDPOINT` chooses the documented Browserless cloud region.
3. Run `npm run aivid:browserless -- login`. Open the temporary control link
   printed in your own terminal and sign in manually. Press Enter after AIVID
   is signed in. The link grants browser control: keep it private. The login
   window has a two-minute connection limit; Google may reject cloud sessions.
4. On the application host with DB credentials and `SETTINGS_ENCRYPTION_KEY`,
   run `npm run aivid:browserless -- install-session`. It stores the session
   object using the existing encrypted app_settings store shared by web/worker.
   Alternatively set `AIVID_BROWSERLESS_CONNECT_URL` to the returned session's
   connect URL on both hosts. Do not use a fresh generic endpoint per job:
   it would lose the logged-in profile.

The session data expires at the original TTL, independently of connection
timeouts. Closing the browser preserves the session; DELETE on its `stop` URL
permanently removes it. When it expires, create and manually log in to a new
session. The CLI refuses to overwrite a session file; intentionally archive the
old private state directory and use a new `AIVID_STATE_DIR` before replacing it.
Do not overwrite a live session while jobs are outstanding.

## Owner smoke test

Create a local job file (keep real prompts/files out of Git):

```json
{
  "jobId": "mini_trial_0001",
  "prompt": "A quiet river at dawn",
  "duration": 4,
  "resolution": "480p",
  "aspectRatio": "16:9",
  "references": []
}
```

Run `npm run aivid:browserless -- preflight trial.json`. It prepares the form
and reads price/balance; it never clicks Generate. Zero credits must be read
as zero balance, not confused with the video price.

For an intentionally paid trial, set `AIVID_MAX_SOURCE_CREDITS` to your reviewed
maximum per video, then run:

```bash
npm run aivid:browserless -- submit trial.json --submit
npm run aivid:browserless -- collect trial.json
```

The explicit `--submit` command is paid authorization for that local job; it
does not debit a CMMTools customer wallet. Keep its receipt directory. A job ID
with any attempted submission receipt cannot be submitted again, even if a
crash or network error occurred. A pending collect can be run again; it never
generates. If an outcome is uncertain, inspect AIVID My Videos manually.

Reference trial example:

```json
{
  "jobId": "mini_refs_0001",
  "prompt": "Animate @image1 with the motion shown in @video1",
  "duration": 4,
  "resolution": "480p",
  "aspectRatio": "16:9",
  "references": [
    {"kind":"image","mimeType":"image/png","path":"reference.png"},
    {"kind":"video","mimeType":"video/mp4","path":"motion.mp4"}
  ]
}
```

Relative reference paths resolve against the job file. Adapter limits: 9 images,
3 videos, 3 audio files, 15 total, 64 MiB combined; 10 MiB/image and 30 MiB/video
or audio. AIVID additionally requires total video and audio duration ≤15 s each
for Mini. Use short fixtures in the pilot; duration, upload completion, public
toggle semantics, outgoing reference fields and download streaming must all be
confirmed in live tests. The request guard currently recognizes explicit
`isPublic/public=true`, `isPrivate/private=false`, or `visibility=public`, and
`references` with `type/kind` values `image/video/audio`. It fails closed if the
real schema differs. Adjust only from observed requests, without logging raw
credentials, prompts, uploaded media or signed URLs.

## CMMTools queue and admin operations

`GenerationWorker` starts the internal AIVID queue; it does nothing without a
configured session. `AIVID_ENABLED=false` and `AIVID_MAX_SOURCE_CREDITS=0` are the
defaults. Both explicit enable/ceiling and existing `allowProviderCharges` are
required to claim a queued job. Accepted jobs can be collected while new starts
are paused. Only one operation uses the browser at a time across worker
processes, using MySQL `GET_LOCK`; no new tables or migrations are needed.

Do not manually insert paid customer rows. Public catalog selection, verified
pricing and customer enqueue activation are deliberately deferred to the next
stage after live verification. The internal queue expects the existing
`generations` and `generation_media` representation with `provider='aivid'`.
Its state reservation is in `provider_operation`; accepted IDs are saved in
`provider_job_id`. It uses the existing storage and wallet lifecycle.

Existing admin authentication protects:

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/aivid/status` | Credential-free setup and enable status |
| POST | `/admin/aivid/settings` | Save Browserless credentials and region encrypted |
| POST | `/admin/aivid/login` | Create/reuse the session and open manual login |
| GET | `/admin/aivid/login/<uuid>` | Read one login attempt; private window link only while active |
| POST | `/admin/aivid/login/<uuid>/finish` | Ask the browser owner to verify persisted sign-in |
| POST | `/admin/aivid/login/<uuid>/cancel` | Close the login window and retain the saved profile |
| POST | `/admin/aivid/check` | Read-only Mini form/balance preflight |
| POST | `/admin/aivid/generations/<uuid>/reconcile` | Resolve an uncertain submission against account history |

After checking the correct AIVID account, reconcile with either
`{"action":"attach","providerJobId":"<verified-existing-id>"}` or
`{"action":"refund","confirmedNotSubmitted":true}`. Never refund an accepted
source job just because the browser timed out. A held job blocks later starts.
Preflight and reconciliation share the queue's MySQL browser lock. CLI access
must be coordinated with the worker; Browserless allows one session connection.

Worker `/health` includes `aividPolling` timestamps/readiness, never credentials.

## Acceptance before customer activation

1. Manual Google login survives browser close/reconnect on the selected plan.
2. Text-only, image-reference, video-reference and mixed-reference trials each
   produce the requested public video with the correct settings.
3. The form balance/price and generated request schema match observed values;
   no reference is omitted or unfinished when the request is allowed.
4. Completed MP4 downloads through the actual Browserless account work and
   save successfully to the configured CMMTools storage.
5. Simulate a worker restart after click reservation and after acceptance:
   no duplicate charge, no wrong-account video, no automatic ambiguous refund.
6. Add verified source pricing and the public model/enqueue adapter, then
   enable through the existing customer access controls.

Reference docs:
- https://docs.browserless.io/baas/session-management/persisting-state
- https://docs.browserless.io/overview/getting-started/connect-playwright
- https://docs.browserless.io/api-reference/cdp-extensions

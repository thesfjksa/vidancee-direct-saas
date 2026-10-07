# Project Handoff — Vidancee Direct SaaS

**Repository:** `thesfjksa/vidancee-direct-saas`  
**Branch:** `main`  
**Current stage:** Production multi-provider SaaS with isolated Hostinger web and worker applications.

## Project goal

Build a multi-user SaaS video-generation platform backed by an authorized Vidancee provider account. Customers use our own product; Vidancee authentication/session details remain completely server-side.

## Architectural direction

```text
Customer UI
   ↓
Our API
   ↓
Auth + customer credits + local generation record
   ↓
Queue / worker
   ↓
Vidancee provider adapter
   ↓
generate.php
   ↓
provider job ID
   ↓
jobs.php polling
   ↓
completed video
   ↓
our library/storage
```

## What has been implemented

Milestone 1 currently includes:

- Node.js 20+ HTTP server
- Hostinger-ready root `server.js`
- provider session cookie jar
- GET login page + login CSRF parsing
- POST login form
- PHPSESSID persistence
- authenticated GET studio page
- studio CSRF parsing from `meta[name="csrf-token"]`
- text-to-video `generate.php` submission
- `jobs.php` polling
- relative output URL resolution
- provider health endpoint
- admin-only browser test console
- provider-spending safety switch
- parser tests
- hPanel deployment notes
- protocol notes

## Current HTTP endpoints in our app

```text
GET  /health
GET  /
POST /admin/provider/check
GET  /admin/provider/jobs
GET  /admin/provider/job?id=...
POST /admin/provider/generate
```

Every `/admin/*` endpoint requires:

```text
X-Admin-Token: <ADMIN_TOKEN>
```

## Environment variables

```env
VIDANCEE_BASE_URL=https://vidancee.com
VIDANCEE_EMAIL=
VIDANCEE_PASSWORD=
ADMIN_TOKEN=
ALLOW_PROVIDER_CHARGES=no
```

## Confirmed provider protocol

Read `docs/VIDANCEE_PROTOCOL.md`.

Key summary:

```text
GET /login.php
→ parse login csrf_token
POST /login.php
→ email + password + csrf_token
→ 302 /studio.php + PHPSESSID
GET /studio.php
→ parse meta[name="csrf-token"]
POST /api/generate.php
→ multipart text-to-video request
→ job_id/job_ids
GET /api/jobs.php?limit=12&status=finished&with_active=1
→ active/history/provider state
```

## Next milestone

After deployment and one successful real generation from Hostinger:

### Milestone 2

Add:

- MySQL connection
- users table
- login/session for our customers
- customer credit ledger
- generations table
- provider_job_id mapping
- atomic credit reservation/deduction
- automatic refund on failed generation
- queue/worker loop
- generation status API
- customer generation history
- admin users/credits controls

Do not build payments until the generation accounting path is stable.

## Important security note

A provider password was previously visible in a chat screenshot. It should be rotated. New credentials must stay only in hPanel environment variables and never be committed to GitHub or pasted into project documentation.

## Instructions for another LLM

Continue from this repository. Treat `docs/VIDANCEE_PROTOCOL.md` as confirmed protocol evidence, not as a generic guess. Do not replace this direct HTTP integration with Browserless unless the direct protocol demonstrably stops working. First verify the deployed Milestone-1 provider check and one real text-to-video generation, then move to Milestone 2.


## Hostinger 503 troubleshooting update — 2026-10-04

The first deployment returned a generic 503 Service Unavailable. The repository was hardened for Hostinger:

- `package.json` now has explicit `main`, `build`, and `start` scripts.
- `app.js` compatibility entry point was added in case hPanel defaults to `app.js`.
- Missing `ADMIN_TOKEN` no longer terminates the entire process at startup; the server can still expose `/health` while admin routes report configuration error.
- `/health` now reports only safe booleans indicating whether required provider/admin variables are configured.
- Recommended managed-hosting port is `3000`; server remains compatible with `process.env.PORT || 3000`.

If a 503 remains after redeployment, inspect hPanel **Deployments → deployment details** and **Runtime logs** before changing application logic.


## Hostinger LiteSpeed runtime fix — 2026-10-04

Runtime logs showed:

```text
Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph with top-level await
...
at startApplication (/usr/local/lsws/fcgi-bin/lsnode.js:426:15)
```

Root cause: Hostinger LiteSpeed's Node launcher loads the application entry through CommonJS `require()`. The repository used ESM (`"type":"module"`) and the entry contained top-level `await` to read the HTML file.

Fix applied:

- removed `"type":"module"` from package.json
- converted `server.js` to CommonJS
- replaced top-level async file read with `fs.readFileSync`
- converted `src/provider/vidancee.js` to CommonJS
- converted tests to CommonJS
- changed `app.js` compatibility entry to `module.exports = require('./server.js')`

This project should remain CommonJS while hosted through Hostinger LiteSpeed unless the hosting runtime is changed.


## Milestone 1 provider connectivity verified — 2026-10-04

Live Hostinger deployment at `https://ai.mehroz.online` successfully authenticated to Vidancee and read provider state.

Observed successful provider-check response:

```json
{
  "ok": true,
  "login": "OK",
  "provider": {
    "credits": 321,
    "reserved": 0,
    "concurrency": 1,
    "processing": 0,
    "activeCount": 0,
    "returnedHistoryCount": 12,
    "hasMore": true
  }
}
```

This confirms the production Hostinger server can:

- reach Vidancee
- retrieve the login CSRF token
- authenticate with the configured provider account
- preserve PHPSESSID
- retrieve the studio CSRF token
- call the authenticated jobs endpoint

Next step: temporarily set `ALLOW_PROVIDER_CHARGES=yes`, redeploy/restart, and submit one controlled 10-second text-to-video generation. Record the returned `job_id`, then poll jobs until terminal status.


## First live paid generation submitted — 2026-10-04

A production text-to-video request was successfully submitted from `https://ai.mehroz.online`.

Observed response:

```json
{
  "ok": true,
  "submitted": true,
  "provider": "vidancee",
  "job_id": 1410,
  "job_ids": [1410],
  "quantity": 1
}
```

Test configuration:

```text
model: Seedance 2.5
duration: 10s
aspect ratio: 9:16
prompt: A cinematic red sports car driving through a modern city at night
```

This confirms the production server can successfully call `/api/generate.php` and receive a provider job ID.

The temporary admin test UI was also upgraded to automatically poll `/admin/provider/job?id=<jobId>` every 5 seconds after submission and surface the final video/poster URLs once the provider job reaches `completed`.


## Milestone 2 implemented — 2026-10-04

The repository now contains the first real multi-user SaaS layer.

Implemented:

- MySQL persistence with automatic schema creation
- users table
- secure password hashing using Node scrypt
- opaque server-side sessions stored as SHA-256 token hashes
- login/register/logout/me APIs
- customer credit balance
- credit ledger
- atomic credit deduction when a generation is queued
- generations table with provider_job_id mapping
- background generation worker
- provider concurrency awareness
- automatic provider-job synchronization
- automatic refund on provider failure or submission error
- customer generation history
- same-domain media proxy so customer responses do not expose raw provider video URLs
- admin user listing and credit adjustment API
- real customer-facing dashboard at /
- provider/admin console moved to /admin-console

New production dependencies:

```text
mysql2
```

New required hPanel variables:

```env
DB_HOST=
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=
```

Important: create a MySQL database/user in Hostinger and add those credentials before testing registration. The app still boots when MySQL is absent, but account/generation APIs return a configuration error.

Customer generation flow:

```text
POST /api/generations
→ transaction locks user
→ checks credit balance
→ inserts queued generation
→ deducts customer credits
→ writes credit ledger debit
→ worker checks provider capacity
→ worker submits to Vidancee
→ stores provider_job_id
→ worker polls jobs.php
→ completed: stores internal provider media URL
→ failed: atomically restores customer credits and writes refund ledger entry
```

The customer API never returns the stored provider media URL. Instead it returns same-origin media endpoints such as:

```text
/api/generations/<id>/media?type=video
```

Next verification steps:

1. Configure MySQL environment variables in hPanel.
2. Redeploy.
3. Check /health and confirm database.connected=true.
4. Register a test customer.
5. Open /admin-console, load users, and add test credits.
6. Queue a customer generation from /.
7. Confirm the worker submits it and the UI moves through queued/submitted/processing/completed.
8. Confirm failed provider jobs restore credits.


## Milestone 2 syntax/startup fix — 2026-10-04

Hostinger runtime logs reported:

```text
src/pricing.js:11
seedance_2.5: {
          ^^
SyntaxError: Unexpected number
```

Cause: JavaScript object keys containing periods must be quoted. The pricing keys were written as bare identifiers.

Fixed:

```js
'seedance_2.5': { ... }
'seedance_2.0_fast': { ... }
```

Additional resilience added at the same time:

- HTTP listener now starts before MySQL schema initialization
- MySQL initialization runs in the background
- database connection timeout defaults to 8 seconds
- a bad/unreachable database can no longer prevent the site and /health endpoint from starting


## Milestone 2 production database verified — 2026-10-04

Production health check at `https://ai.mehroz.online/health` returned:

```json
{
  "ok": true,
  "app": "vidancee-direct-saas",
  "milestone": 2,
  "node": "v20.19.4",
  "providerChargesEnabled": true,
  "database": {
    "configured": true,
    "connected": true
  },
  "config": {
    "adminTokenConfigured": true,
    "providerEmailConfigured": true,
    "providerPasswordConfigured": true,
    "providerBaseUrl": "https://vidancee.com",
    "signupsEnabled": true
  }
}
```

This verifies:

- Hostinger runtime is healthy on Milestone 2
- MySQL credentials are valid
- schema initialization can reach the production database
- provider credentials are configured
- customer signups are enabled
- provider charging is enabled

Next production verification sequence:

1. Register the first customer at `/`
2. Open `/admin-console`
3. Load users and add credits to the new user
4. Queue one customer generation
5. Confirm the background worker submits it to Vidancee
6. Confirm the customer UI reaches completed status and plays the proxied video
7. Test one failure/refund path before considering Milestone 2 complete


## Admin user route compatibility fix — 2026-10-04

The Milestone 2 admin console displayed `ERROR: Admin route not found.` when loading customer users.

Fixes applied:

- request paths are now normalized to ignore trailing slashes, so both `/admin/users` and `/admin/users/` resolve consistently
- admin credit adjustment now accepts either a numeric user ID or an email address
- new endpoint:
  `POST /admin/users/credits`
  with JSON `{ "identifier": "<id-or-email>", "amount": 100 }`
- admin console input now says **User ID or email**

The original numeric endpoint remains supported for compatibility.


## Milestone 3 complete application UI — 2026-10-04

The project has been upgraded from a development console into a full SaaS application shell.

Customer dashboard now includes:

- responsive authenticated layout
- overview statistics
- create-video page
- model/duration/aspect-ratio pricing controls
- generation history with live status updates
- completed video playback through the same-origin media proxy
- credit balance and full credit ledger
- account/profile information
- password change with session rotation
- mobile navigation

Admin panel at `/admin-console` now includes:

- private ADMIN_TOKEN gate stored only in browser sessionStorage
- overview statistics
- searchable/filterable customer users
- enable/disable customer accounts
- credit adjustment by user ID or email
- searchable/filterable generation monitoring
- full credit ledger
- Vidancee connection/status checks
- provider job viewer
- configuration/pricing visibility

New API routes:

```text
GET  /api/dashboard
GET  /api/credits
POST /api/account/password

GET   /admin/stats
GET   /admin/config
GET   /admin/users?q=&status=
PATCH /admin/users/:id
POST  /admin/users/credits
GET   /admin/generations?q=&status=
GET   /admin/credits
```

The generation worker now also respects `ALLOW_PROVIDER_CHARGES`. Turning provider charges off prevents automatic queued customer jobs from being submitted.

Scope note: text-to-video is production-enabled. Image-to-video is intentionally not exposed yet because its exact provider submission payload has not been captured/verified.


## Image-to-video protocol captured and implemented — 2026-10-04

The exact Vidancee Image → Video multipart payload was captured from the browser.

Confirmed fields:

```text
mode         = image-to-video
model        = seedance_2.5
duration     = 10
aspect_ratio = 9:16
prompt       = create ad of this
quantity     = 1
max_retries  = 3
images[]     = (binary)
```

No separate upload endpoint was observed before `generate.php`; the image binary is sent directly in the `generate.php` multipart request.

Implemented end-to-end:

- customer Text → Video / Image → Video toggle
- 1–6 reference image upload
- JPEG/PNG/WebP validation
- 10 MB per image and 30 MB combined upload cap
- temporary image persistence in MySQL `generation_images`
- worker loads reference images when the queued job is submitted
- Vidancee provider adapter appends each reference as `images[]`
- provider request includes `max_retries=3`
- temporary image blobs are deleted after successful provider submission
- generation history displays the correct mode

New dependency: `busboy` for streaming multipart upload parsing.

## CreatePulse multi-provider backend added — 2026-10-04

CreatePulse is now supported as a second backend via its official API.

Routing defaults to PROVIDER_ROUTING=overflow: Vidancee remains primary, and compatible queued jobs spill to CreatePulse when Vidancee has no free slot.

CreatePulse model mapping:
- seedance_2.5 + 10s -> dreamina-seedance-2.5
- seedance_2.0_fast + 10s -> dreamina-seedance-2.0
- seedance_2.0_fast + 15s -> dreamina-seedance-2.0-15s

CreatePulse routing uses only aspect ratios documented by its API: 9:16, 16:9, 1:1, 4:3.

For image-to-video, the first uploaded image is exposed to CreatePulse as init_image_url and up to four additional images as image_reference_urls. Temporary URLs are HMAC-signed provider asset routes on APP_URL. Image blobs are retained until the CreatePulse job finishes, then deleted.

Database migration changes provider_job_id from BIGINT to VARCHAR(191), provider_cost to DECIMAL(12,4), and adds provider_cost_unit.

New environment settings:
CREATEPULSE_BASE_URL=https://createpulse.online
CREATEPULSE_API_KEY=<secret>
CREATEPULSE_MAX_INFLIGHT=3
PROVIDER_ROUTING=overflow
PROVIDER_ASSET_SECRET=<long-random-secret>


## CreatePulse long Seedance 2.5 durations verified — 2026-10-04

CreatePulse's current API documentation confirms these canonical model IDs:

- `dreamina-seedance-2.5` — 10s
- `dreamina-seedance-2.5-15s` — 15s
- `dreamina-seedance-2.5-20s` — 20s
- `dreamina-seedance-2.5-30s` — 30s

The provider adapter now maps our `seedance_2.5` model to all four durations. This means existing customer 30s Seedance 2.5 jobs can overflow to CreatePulse instead of being forced to wait for Vidancee.

The 20s customer option is configurable through `PRICE_SEEDANCE_25_20`; leave it blank to hide 20s or set a positive integer customer-credit cost to expose it.

CreatePulse image routing now accepts all 6 images supported by our customer upload UI (one init image + up to five reference URLs).


## Unified aspect-ratio lock — 2026-10-04

The customer-facing generator is now intentionally restricted to the four aspect ratios supported by both configured backends:

- 9:16
- 16:9
- 1:1
- 4:3

Previously exposed Vidancee-only ratios 3:4 and 21:9 have been removed from the public configuration.

Reason: the SaaS keeps provider routing completely invisible to customers. Every aspect ratio shown in the generation UI must be routable to either backend, allowing the queue/router to choose capacity without changing the customer's requested output format or exposing provider names.


## Unified generation window + provider privacy — 2026-10-04

Customer generation UX is now a single form. There is no Text-to-Video / Image-to-Video mode selector.

Behavior:
- prompt + no uploaded image -> backend derives text-to-video
- prompt + one or more uploaded images -> backend derives image-to-video
- customer cannot choose or submit a mode field
- the same POST /api/generations endpoint is used in both cases

Provider/source privacy was tightened:
- customer generation serialization no longer includes the internal provider
- public /health no longer exposes provider names, provider domains, routing mode, or provider credential state
- customer-visible generation errors use generic service wording rather than backend names
- admin generation monitoring still includes the internal provider for operational use

The four public aspect ratios remain 9:16, 16:9, 1:1, and 4:3.


## Professional customer UI redesign — 2026-10-04

The user-facing application in `public/index.html` was fully redesigned into a polished dark AI-studio interface inspired by contemporary creative-video SaaS UX patterns.

Updated areas:
- split-screen premium authentication experience
- compact professional sidebar navigation
- modern top bar with account avatar and credit balance
- overview hero and compact operational metrics
- unified generation composer with large prompt canvas
- optional reference-image upload integrated directly into the composer
- compact model/duration/aspect-ratio controls
- cleaner generation cost and CTA treatment
- redesigned video library cards and status badges
- improved credit history and account-security views
- responsive tablet/mobile navigation
- no provider/source engine names exposed to customers

All existing generation, authentication, credits, library, and account APIs remain unchanged.


## Gallery-first creative studio redesign — 2026-10-04

The customer frontend was rebuilt again to follow a professional creative-tool layout similar in information architecture to leading AI video products, while keeping original branding and functionality.

Key UX changes:
- slim promotional strip and compact global navigation
- Create is now the default authenticated workspace
- fixed/sticky left generation composer on desktop
- prompt, optional reference images, model, duration, ratio, cost and Generate are all contained in one compact control panel
- large gallery/canvas area on the right for render history
- masonry-style render gallery that respects generation aspect ratios
- All / Completed / In progress render filters
- dedicated Library, Credits and Account views
- responsive layout collapses the creator above the gallery on tablet/mobile
- no backend/provider engine names are exposed in customer UI

The unified generation behavior remains unchanged: no image = prompt-only generation; one or more images = image-guided generation.


## Stable video playback during polling — 2026-10-04

The customer render gallery previously refreshed every polling cycle because the frontend rebuilt the entire gallery with `innerHTML` every 5 seconds. That recreated completed `<video>` elements and caused visible playback resets while a user was watching a render.

The gallery now uses keyed DOM updates based on generation ID and a generation fingerprint.

Behavior:
- unchanged render cards keep their existing DOM nodes
- completed `<video>` elements are preserved instead of recreated
- playback time, play/pause state, volume, buffering state, and fullscreen context are no longer reset by routine polling
- only a render whose data actually changed is replaced
- removed generations are cleaned from the DOM
- background generation polling is skipped while the browser tab is hidden
- overlapping `/api/generations` requests are prevented with a pending-request guard

This keeps status polling active without interrupting media playback.


## CURRENT STATE SNAPSHOT — authoritative as of 2026-10-04

> Earlier milestone sections below are historical records. If an older section conflicts with this snapshot, use this snapshot as the current project state.

### Deployment and repository

- Production domain: `https://ai.mehroz.online`
- GitHub repository: `thesfjksa/vidancee-direct-saas`
- Active branch: `main`
- Customer app: `/`
- Private admin app: `/admin-console`
- Health endpoint: `/health`

### Customer generation UX

The public product has one unified generation composer.

- prompt only -> text-to-video
- prompt + 1–6 reference images -> image-to-video
- customers do not choose a mode
- customers do not see provider/source-engine names
- the backend derives the mode automatically from uploaded images
- the same `POST /api/generations` route is used for both workflows

Public aspect ratios are intentionally limited to the set supported by both internal engines:

- 9:16
- 16:9
- 1:1
- 4:3

### Internal generation engines

Two internal generation sources are integrated behind the private router:

1. Vidancee
2. CreatePulse

Provider selection is server-side only and invisible to customers.

Routing policy is configurable from the Admin dashboard. Supported policies are:

- `overflow` — primary first, overflow engine when needed
- `balanced`
- `createpulse-first`

CreatePulse supports the mapped Seedance 2.5 10s / 15s / 20s / 30s variants used by this project. Unsupported provider combinations are not silently converted to another duration or aspect ratio.

### Provider credentials are Admin-managed

Provider credentials are no longer intended to be managed as normal provider ENV values.

Admin path:

`/admin-console` -> **Provider**

The Admin Provider panel manages:

- primary provider base URL
- primary provider login email/password
- overflow provider base URL
- overflow provider API key
- overflow max-inflight limit
- routing policy
- generation submission Enabled / Paused state

Secrets are stored in MySQL and encrypted before persistence. The Admin read endpoint never returns saved provider passwords/API keys; it only reports configured/not-configured state.

Encryption root:

1. `SETTINGS_ENCRYPTION_KEY`, if configured
2. otherwise `ADMIN_TOKEN`

The worker reloads provider settings dynamically, so changing a provider API key or login in Admin does not require a redeploy.

A one-time legacy migration imports old provider ENV values into database settings when the saved setting does not yet exist. After verifying the Admin Provider page shows the credentials as configured, the legacy provider credential ENV values can be removed from hPanel.

Infrastructure ENV values still belong in hPanel, including:

- `APP_URL`
- `ADMIN_TOKEN`
- optional `SETTINGS_ENCRYPTION_KEY`
- MySQL credentials
- worker timing/settings
- customer pricing variables

### Active worker/runtime files

The active server imports:

`src/worker_admin_settings.js`

That worker reads provider configuration through:

`src/settings.js`

Do not treat the older transitional `src/worker.js` as the active runtime worker unless the server import is changed again.

### Current customer UI

The customer frontend is a gallery-first dark creative studio.

Current layout:

- compact global top navigation
- Create is the default signed-in workspace
- left-side generation composer on desktop
- large render gallery/canvas on the right
- prompt + optional reference images in one workflow
- model, duration, aspect ratio, cost, Generate controls
- All / Completed / In progress filters
- Library, Credits and Account sections
- responsive tablet/mobile layout
- source-engine names hidden from customers

The visible Model, Duration and Aspect Ratio controls use custom themed dropdown components. Native browser selects remain hidden for state/form compatibility, preventing Windows/Edge from showing the default blue native option menu.

### Stable media polling

The render gallery continues polling for job updates without recreating unchanged video elements.

Current behavior:

- unchanged render cards preserve their DOM nodes
- completed videos keep playback position and play/pause state
- only generations whose data changed are replaced
- overlapping generation fetches are blocked
- background polling pauses when the browser tab is hidden

This prevents completed videos from visibly refreshing every polling cycle.

### Current high-value implementation files

- `public/index.html` — customer studio UI
- `public/admin.html` — private admin console
- `server.js` — HTTP/API routes
- `src/settings.js` — encrypted provider settings
- `src/worker_admin_settings.js` — active generation worker/router
- `src/provider/vidancee.js` — Vidancee adapter
- `src/provider/createpulse.js` — CreatePulse adapter
- `src/provider/assets.js` — signed temporary image URLs for external provider fetching
- `src/generations.js` — customer generation records, credits and mode derivation
- `src/pricing.js` — customer model/duration pricing and public aspect ratios
- `src/db.js` — schema initialization
- `docs/ADMIN_PROVIDER_SETTINGS.md` — provider credential-management notes



## Theme-matched custom dropdowns — 2026-10-04

The customer Model, Duration and Aspect Ratio selectors previously used visible native HTML `<select>` menus. On Windows/Edge the open option list used the operating system's bright blue selection styling, which conflicted with the dark lime-accent product theme.

The frontend now renders custom dropdown controls for all three selectors.

Implementation notes:

- the original `<select>` elements remain hidden as the authoritative form/state controls
- custom trigger/menu UI mirrors each native select's options
- selecting a custom option updates the hidden select and dispatches the normal `change` event
- existing model -> duration pricing behavior is preserved
- dropdown menu, hover, selected state, chevron, border and focus styles use the product theme
- Escape and outside-click close open menus

This removes browser/OS-native blue dropdown styling without changing backend request behavior.


## Generation card actions — 2026-10-04

Customer generation cards now include three practical actions:

- **Reuse prompt** — loads the generation's prompt, model, duration, and aspect ratio back into the unified Create composer. Previously uploaded reference images are not restored; the user can upload new references if needed.
- **Download** — shown when a completed video is available and downloads the authenticated generation media.
- **Delete** — shown for terminal generations (completed, failed, submit_error). The backend refuses deletion while a generation is still queued/submitting/submitted/processing.

Deletion is ownership-scoped through `DELETE /api/generations/:id`. Deleting a generation removes it from the user's library; linked credit transaction history is preserved because the database foreign key sets its generation reference to NULL. Deletion does not create a refund.


## Admin generations response hardening — 2026-10-05

An Admin → Generations screen could show "Invalid server response" when the browser received a non-JSON upstream/hosting error page instead of the expected API JSON.

Hardening added:
- Admin API client now reads the raw response first and reports HTTP status plus a short sanitized response preview when JSON parsing fails.
- `/admin/generations` now selects only the generation fields it actually needs rather than `g.*`.
- database startup now idempotently verifies/adds key generation columns used by the current multi-provider schema (`provider`, `provider_job_id`, `mode`, `poster_url`, `provider_cost`, `provider_cost_unit`).
- fixed the server import for `deleteUserGeneration` used by the customer generation delete route.

This makes schema upgrades from earlier project milestones safer and makes future Hostinger/Node errors visible in the Admin UI instead of the generic "Invalid server response" message.


## Seedance 2.0 Fast duration lock — 2026-10-05

The customer-facing Seedance 2.0 Fast model is now hard-locked to **10 seconds only**.

Implementation:
- `src/pricing.js` exposes only the 10s duration for `seedance_2.0_fast`.
- legacy optional 15s/30s environment pricing no longer exposes those durations in the customer UI.
- when a model has only one available duration, the custom Duration control is rendered as a locked single-option field: the chevron is hidden and clicking it does not open a one-item dropdown.

Seedance 2.5 keeps its separately configured duration options.


## Generation deletion compatibility fix — 2026-10-05

Generation deletion now explicitly cleans related database rows before removing the generation.

Reason: some production databases were created during earlier milestones. `CREATE TABLE IF NOT EXISTS` does not replace an existing foreign-key definition, so an older `generation_images` or `credit_transactions` constraint could block deletion even though the current schema declares CASCADE / SET NULL behavior.

Current deletion transaction:
1. verify the generation belongs to the signed-in user
2. allow deletion only for terminal statuses
3. set matching `credit_transactions.generation_id` to NULL so credit history remains intact
4. delete stored `generation_images`
5. delete the generation record
6. commit atomically

Deleting a generation still does not refund credits.


## Reuse prompt now restores reference images — 2026-10-05

The customer **Reuse prompt** action now restores the original reference images when those image blobs are still stored.

Current behavior:
- clicking Reuse prompt fetches the owned generation detail
- prompt, model, duration and aspect ratio are restored
- saved reference images are loaded back into the reference-image preview with a Reused badge
- reused images can be individually removed before the next generation
- fresh uploads can be combined with reused images up to the existing 6-image total limit
- the next generation securely copies the selected stored image blobs into its own generation_images rows
- reference-image bytes are served only through an authenticated user-owned route

New authenticated image route:
`GET /api/generations/:generationId/reference-images/:imageId`

Generation detail now includes `reference_images` metadata for images owned by that user.

The active worker no longer deletes reference-image blobs after provider submission/completion/failure. Images are retained until the customer deletes the generation, enabling later prompt+image reuse.

Important historical limitation: generations completed before this change may have had their reference-image blobs deleted by the previous worker behavior. Those old images cannot be reconstructed from the database; for such older generations the UI restores the prompt/settings and tells the user to upload the references again.


## Reference image removal + drag/drop ordering — 2026-10-05

Reference-image handling in the Create composer is now fully interactive.

Current behavior:
- every reference-image thumbnail has a small **× remove** control
- remove works for both freshly uploaded images and images restored through Reuse prompt
- desktop users can drag thumbnails to reorder them
- touch/pointer users can drag from the small grip control to reorder
- users can also drag JPEG/PNG/WebP files directly onto the reference upload drop-zone
- reused and fresh images can be mixed in any order, up to the existing 6-image limit

The chosen order is now preserved end-to-end. The frontend sends a `referenceOrder` manifest with the multipart generation request, and `src/generations.js` validates it and stores `generation_images.position_index` in that exact visual order. This means provider submission receives reference images in the same order the customer arranged them.

The browser file input is no longer treated as the source of truth after selection. The frontend keeps an explicit reference-item list so fresh uploads can be removed/reordered and can coexist cleanly with reused stored images.


## Session-check splash prevents login flash — 2026-10-05

Page refresh no longer briefly shows the login screen before restoring an existing authenticated session.

Previous behavior:
- the login/auth shell was visible in the initial HTML
- JavaScript then called `/api/me`
- valid sessions were switched into the dashboard only after that request completed
- this caused a visible login-screen flash on every refresh

Current behavior:
- a minimal Mehroz AI boot screen is shown first
- both the auth screen and application shell stay hidden while the existing session is checked
- valid session -> dashboard is shown directly
- HTTP 401/no session -> login screen is shown
- session/config errors -> login screen is shown with the error message

This removes the misleading login-then-auto-login flicker without changing cookie/session behavior.


## Atlas Cloud image generation — 2026-10-05

Mehroz AI now supports customer-facing **image generation** alongside the existing video workflow.

### Customer UX

A new **Images** navigation item opens a dedicated image-generation studio with:

- text-to-image generation
- optional 1–6 reference images for reference-guided generation/editing
- drag/drop reference upload
- thumbnail removal and drag reordering
- model selection
- aspect-ratio selection
- customer credit cost display
- asynchronous generation status
- generated-image gallery
- image download
- deletion of terminal image generations

Image generation is separate from the video Create workspace, while sharing the same customer account and credit balance.

### Atlas Cloud integration

Image generation uses Atlas Cloud's asynchronous generation API:

- submit: `POST /api/v1/model/generateImage`
- poll: `GET /api/v1/model/prediction/:predictionId`

Internal model mappings:

- `seedream_v5_lite`
  - text: `bytedance/seedream-v5.0-lite`
  - references/edit: `bytedance/seedream-v5.0-lite/edit`
- `nano_banana_2`
  - text: `google/nano-banana-2/text-to-image`
  - references: `google/nano-banana-2/reference-to-image`

Public image aspect ratios:

- 1:1
- 4:3
- 16:9
- 9:16

Seedream ratios are translated to supported pixel-size presets. Nano Banana receives the aspect ratio directly.

### Image data and provider access

Image jobs reuse the existing `generations` and `generation_images` tables.

A new `generations.media_type` column distinguishes:

- `video`
- `image`

Existing rows migrate safely to `video`.

For reference-guided Atlas Cloud requests, the worker exposes stored reference images using the existing HMAC-signed `/provider-assets/:generationId/:position` URLs. These are provider-accessible without exposing customer sessions.

### Customer APIs

- `GET /api/image-generations`
- `POST /api/image-generations`
- `GET /api/image-generations/:id`
- `DELETE /api/image-generations/:id`
- `GET /api/image-generations/:id/media`

Video APIs are now explicitly scoped to `media_type='video'`, so image jobs do not appear in the video gallery/Library.

### Worker behavior

The active `src/worker_admin_settings.js` worker now:

- creates/reloads an Atlas Cloud client from Admin-managed settings
- submits queued image jobs independently from video-provider capacity
- limits Atlas concurrency with `atlascloud_max_inflight`
- polls Atlas predictions
- stores the first completed output URL in `generations.output_url`
- refunds customer credits on submit/process failure

### Admin settings

Atlas Cloud is configured under:

`/admin-console` -> **Provider**

Admin-managed Atlas settings:

- Base URL (default `https://api.atlascloud.ai`)
- API key (encrypted in `app_settings`)
- Max inflight image jobs

Secrets are never returned to the browser after storage; the Admin UI only shows configured/not-configured state.

Legacy ENV migration is supported for:

- `ATLASCLOUD_BASE_URL`
- `ATLASCLOUD_API_KEY`
- `ATLASCLOUD_MAX_INFLIGHT`

New deployments should configure provider credentials in Admin rather than hPanel ENV.

### Customer image pricing

Current defaults:

- Seedream 5.0 Lite: 2 credits/image
- Nano Banana 2: 3 credits/image

Optional ENV overrides:

- `PRICE_IMAGE_SEEDREAM_50_LITE`
- `PRICE_IMAGE_NANO_BANANA_2`

These are customer-facing credit prices, not Atlas Cloud billing values.


## vgenv MiniMax H3 + universal 2.5× pricing rule — 2026-10-05

### MiniMax H3 video integration

Mehroz AI now includes customer-facing **MiniMax H3** video generation backed privately by **vgenv**.

Customer behavior:
- MiniMax H3 appears as a normal model in the existing Create video model selector.
- Provider identity remains hidden from customers.
- supported duration options are every integer from **4 through 15 seconds**
- public app aspect ratios remain the shared set: 9:16, 16:9, 1:1, 4:3
- prompt-only jobs are sent as text-to-video
- prompt + reference images are sent as ordered reference-image video generation
- the existing app limit stays at 6 reference images
- H3 references are limited to 5 MB each to stay inside the vgenv public input contract used by this integration

Internal vgenv contract:
- Base URL default: `https://api.vgenv.com`
- Primary create path: `POST /v1/videos`
- Primary poll path: `GET /v1/videos/:id`
- The provider client automatically falls back to the equivalent `/v2/videos` endpoints on HTTP 404 because current vgenv public materials show both versioned forms.
- public model ID: `minimax/h3`
- tier: `fast`
- resolution: `768p`
- create calls use an idempotency key based on the local generation UUID
- completed jobs store the returned signed output URL in `generations.output_url`
- the provider quote snapshot is stored in `provider_cost` with `provider_cost_unit='usd'`
- failed/cancelled jobs refund customer credits

The active worker routes `model='minimax_h3'` exclusively to vgenv. Existing Seedance jobs continue to use the Vidancee/CreatePulse routing policy. vgenv has its own configurable local inflight cap.

### Admin-managed vgenv settings

`/admin-console` -> **Provider** now includes a MiniMax H3/vgenv card with:
- Base URL
- encrypted API key
- Max inflight H3 jobs

Settings keys:
- `vgenv_base_url`
- `vgenv_api_key`
- `vgenv_max_inflight`

Legacy environment migration is supported for:
- `VGENV_BASE_URL`
- `VGENV_API_KEY`
- `VGENV_MAX_INFLIGHT`

The customer config hides MiniMax H3 until the vgenv API key is configured, and the generation POST route also refuses H3 submission if the backend is not configured.

### Universal 2.5× customer-credit rule

All model pricing now passes through one shared billing rule:

`customer credits = source billing units × 2.5`

The default multiplier is implemented centrally in `src/billing.js` and can be overridden with:

`CUSTOMER_CREDIT_MULTIPLIER=2.5`

This multiplier is applied to:
- Seedance 2.5
- Seedance 2.0 Fast
- MiniMax H3
- Seedream 5.0 Lite
- Nano Banana 2
- future models that use the shared billing helper

Existing `PRICE_SEEDANCE_*` and `PRICE_IMAGE_*` values are now treated as **source-site billing units before markup**, not final customer prices.

Examples with the current defaults:
- Seedance 2.5 10s: source 6 -> customer 15 credits
- Seedance 2.5 15s: source 9 -> customer 22.5 credits
- Seedance 2.0 Fast 10s: source 5 -> customer 12.5 credits
- Seedream 5.0 Lite: source 2 -> customer 5 credits
- Nano Banana 2: source 3 -> customer 7.5 credits

For vgenv H3, the current Fast 768p public rate is represented internally in source-cent units:
- source rate default: 0.3 source units/sec (= $0.003/sec)
- customer rate at 2.5×: 0.75 credits/sec
- 5s = 3.75 credits
- 10s = 7.5 credits
- 15s = 11.25 credits

The H3 source-unit rate can be changed with:
`SOURCE_MINIMAX_H3_FAST_768P_CREDITS_PER_SECOND`

### Fractional-credit migration

Because a strict 2.5× multiplier produces half/quarter-credit values, credit storage now supports decimals.

Database types are migrated idempotently to:
- `users.credits DECIMAL(12,2)`
- `generations.credits_cost DECIMAL(12,2)`
- `credit_transactions.amount DECIMAL(12,2)`

Admin credit adjustments also accept decimal values.

### New implementation files

- `src/billing.js` — universal customer-credit multiplier
- `src/provider/vgenv.js` — vgenv MiniMax H3 client

Updated major files:
- `src/pricing.js`
- `src/image_pricing.js`
- `src/settings.js`
- `src/worker_admin_settings.js`
- `src/db.js`
- `src/generations.js`
- `server.js`
- `public/admin.html`


## Customer plans + manual fulfillment workflow — 2026-10-05

Mehroz AI now has three customer plans built into the SaaS:

| Plan | Price | Included credits | Simultaneous generations | Queue priority |
| --- | ---: | ---: | ---: | --- |
| Basic | PKR 1,500/month | 500 | 2 | Standard |
| Pro | PKR 4,500/month | 1,500 | 3 | Priority |
| Premium | PKR 12,000/month | 4,000 | 5 | Highest |

### Customer UX

A new **Plans** navigation section shows the three plan cards, current plan, pending purchase request, included credits, concurrency level, and plan features.

Customers can request a plan from the Plans page. Until a payment gateway is integrated, plan fulfillment is intentionally manual:

1. customer chooses a plan
2. a pending plan request is stored in MySQL
3. Admin verifies payment outside the app
4. Admin approves the request
5. the selected plan becomes active
6. the plan's included credits are added to the user's existing credit balance
7. a `plan_credit` ledger entry is created

Renewing the same plan is supported by submitting another request after the previous request has been decided.

### Admin workflow

The private Admin dashboard now has a **Plans** tab.

Admin can:
- filter plan requests
- see user/current plan/requested plan/price/credits
- approve a pending request
- reject a pending request

Approval is transactional: user plan assignment, credit grant, ledger entry, and request decision are committed together.

### Plan-aware runtime limits

Generation concurrency is enforced across both image and video jobs.

- no paid plan: 1 active generation
- Basic: 2
- Pro: 3
- Premium: 5

Active means any generation in:
- queued
- submitting
- submitted
- processing

Queue priority is also persisted per generation:

- no paid plan: 0
- Basic: 10
- Pro: 20
- Premium: 30

Both the image and video workers now select queued work with:

`ORDER BY queue_priority DESC, created_at ASC`

So higher plans receive their promised queue preference without changing provider identity or routing.

### Database additions

`users.plan_code VARCHAR(20) NULL`

`generations.queue_priority INT NOT NULL DEFAULT 0`

New table:

`plan_requests`

It stores:
- user
- plan code
- PKR price snapshot
- credit snapshot
- concurrency snapshot
- request status
- created/updated/decided timestamps

### Plan APIs

Customer:
- `GET /api/plan-status`
- `POST /api/plan-requests`

Admin:
- `GET /admin/plan-requests?status=...`
- `POST /admin/plan-requests/:id` with `approve` or `reject`

Plan definitions live in `src/plans.js`.

### Billing relationship

The plan prices sell the customer credit pool. Model generation costs still use the existing universal source-cost × 2.5 customer-credit rule. The plan layer does not apply a second markup to model consumption.


## Admin provider settings 403 / edge-challenge compatibility fix — 2026-10-05

The Provider page previously saved credentials with an HTTP `PUT /admin/provider-settings` request. On the production edge, this could be intercepted by the hosting/CDN security layer and return an HTML browser-challenge page with HTTP 403 instead of reaching the Node app.

Current behavior:
- the Admin UI now saves provider settings using `POST /admin/provider-settings`
- the server accepts both POST and PUT for backward compatibility
- the Admin API helper recognizes common edge/browser-challenge HTML and shows a clear hosting-security message instead of dumping HTML/CSS into the Provider page

This change does not alter provider secret storage or encryption.


## Video resolution selector — 2026-10-05

The customer video composer now supports model-specific resolution selection.

Current implementation:
- MiniMax H3 exposes **480p** and **768p**
- H3 defaults to **768p**
- Seedance models keep their existing provider-defined resolution and therefore do not show an unnecessary resolution selector
- changing H3 resolution immediately recalculates the displayed credit cost
- selected resolution is stored in `generations.resolution`
- Reuse prompt restores the previous resolution
- generation cards display the selected resolution
- Admin generation monitoring includes a Resolution column
- the worker forwards the stored resolution to vgenv

H3 Fast source-rate defaults used by the shared 2.5× pricing rule:
- 480p: `0.15` source units/sec (normalized from $0.0015/sec)
- 768p: `0.3` source units/sec (normalized from $0.003/sec)

Environment overrides:
- `SOURCE_MINIMAX_H3_FAST_480P_CREDITS_PER_SECOND`
- `SOURCE_MINIMAX_H3_FAST_768P_CREDITS_PER_SECOND`

At the current 2.5× multiplier this yields:
- 480p: 0.375 customer credits/sec before two-decimal rounding
- 768p: 0.75 customer credits/sec

The public pricing payload now includes per-resolution duration/cost entries for models that expose customer-selectable resolutions.


## Per-provider backend switches — 2026-10-06

Admin → Provider now has an independent ON/OFF switch for every configured backend source:

- Primary video engine (Vidancee)
- Overflow video engine (CreatePulse)
- Image engine (Atlas Cloud)
- MiniMax H3 engine (vgenv)

The switches are stored in `app_settings` and default to enabled so an existing deployment does not unexpectedly lose models after upgrading.

### Customer catalog behavior

A source must be both **configured** and **enabled** before its models are exposed by `GET /api/config`.

Current model-source behavior:

- static `seedance_2.5` and `seedance_2.0_fast` remain available from Vidancee/CreatePulse when those sources are active
- static `minimax_h3` remains available from vgenv when that source is active
- static Atlas image models remain available when Atlas Cloud is active
- when Higgsfield MCP is active, any enabled/available synced Higgsfield image/video model is merged into the same customer catalog
- when a synced Higgsfield model uses the same public model ID as a static model, the Higgsfield definition is primary while Higgsfield is active; the static source becomes the fallback when Higgsfield is switched off

A customer model disappears only when no active enabled backend still exposes that public model.

Provider identities remain private; customers only see the resulting model catalog.

The backend also enforces the switches server-side, so a customer with a stale browser page cannot submit a hidden/disabled model.

### Worker behavior

Provider switches affect **new submissions** only.

- queued work that has no active eligible source waits until an eligible source is enabled again
- jobs already submitted/processing continue to be polled to completion even if that source is switched off
- provider clients remain available internally for status synchronization of existing jobs

This avoids abandoning already-running provider jobs while still preventing new charges through a disabled source.

### Admin data

`getAdminProviderSettings()` now returns `enabled` and `active` for each provider:

- `configured`: credentials/config exist
- `enabled`: Admin switch is on
- `active`: configured + enabled

`/admin/config` exposes private `providerEnabled` and `providerActive` maps for operations/debugging.


## Higgsfield MCP primary catalog integration — 2026-10-06

Higgsfield MCP is now implemented as a full image/video backend source rather than a single-model adapter.

### Authentication

- Official MCP endpoint default: `https://mcp.higgsfield.ai/mcp`
- Admin connects the paid Higgsfield account with OAuth from **Admin → Provider → Higgsfield MCP → Connect / Reconnect**.
- No Higgsfield password or API key is entered into Mehroz AI.
- OAuth tokens, dynamic client registration information, PKCE verifier, discovery state, and OAuth state are persisted through the encrypted `app_settings` store.
- The public callback is `${APP_URL}/admin/higgsfield/oauth/callback`; `APP_URL` must therefore be the real public HTTPS application origin.
- The OAuth callback is intentionally not protected by the Admin header token because the external authorization server redirects the browser to it. It is protected by stored OAuth `state` comparison and the MCP SDK issuer/discovery validation.

### Dynamic model sync

A new `provider_models` table stores the live model catalog discovered from the authenticated MCP tool schemas.

After OAuth succeeds, the server automatically attempts a model sync. Admin can also press **Sync models** at any time.

For each discovered image/video model the app stores:

- provider model ID
- neutral customer-facing model ID
- label
- media type
- generation tool(s)
- input schema
- supported duration values when exposed
- supported resolutions when exposed
- supported aspect ratios when exposed
- default values when exposed
- Admin enabled/disabled state
- whether the model appeared in the latest sync

Models missing from the newest sync are marked unavailable rather than deleted. Admin visibility choices are preserved across syncs.

Provider identity is not exposed to customers. Dynamically discovered public IDs use the neutral `ai_` prefix, while known overlapping products reuse the existing public IDs such as `seedance_2.5`, `seedance_2.0_fast`, and `minimax_h3`.

### Admin controls

The Higgsfield provider card includes:

- source ON/OFF switch
- MCP endpoint
- connected status
- max inflight jobs
- Connect / Reconnect
- Sync models
- Disconnect

The Higgsfield model catalog below it has a Show/Hide control for every synced model.

Turning the whole Higgsfield source OFF removes its exclusive models from the customer catalog and stops new Higgsfield submissions. Turning an individual model OFF hides only that model. Existing submitted jobs continue to be polled while authorization remains available.

### Customer catalog and routing

When Higgsfield is active, `GET /api/config` merges enabled/available synced models into the existing Video and Image model selectors.

If Higgsfield supplies a model that already exists from another backend, the Higgsfield-backed dynamic definition takes precedence while Higgsfield is active. This makes Higgsfield the primary source for overlapping models such as Seedance while preserving the older providers as fallback sources when Higgsfield is switched off.

Customer APIs and UI do not mention Higgsfield.

### Pricing

Synced models use live source pricing rather than hard-coded customer prices:

1. the app calls the model's MCP generation tool with `get_cost: true`
2. it reads the source credit estimate
3. customer cost = source credits × `CUSTOMER_CREDIT_MULTIPLIER` (default 2.5)
4. the exact customer debit and source credit estimate are saved with the queued generation

The customer UI calls the neutral `POST /api/model-cost` endpoint for a live estimate. If the browser estimate cannot be retrieved, the server still calculates the exact cost before accepting a generation.

### Generation and polling

Queued Higgsfield jobs are tagged internally with provider `higgsfield` and processed by the active worker.

- reference uploads are exposed to the provider through the existing signed temporary asset URLs
- the worker selects the synced tool/schema for the requested model and mode
- async provider job IDs are stored in `provider_job_id`
- the synced `jobs_wait` MCP tool is used to poll completion
- successful result URLs are proxied to customers through the existing authenticated media routes
- failed provider jobs use the existing atomic credit refund path

Higgsfield image and video jobs share the configured `HIGGSFIELD_MAX_INFLIGHT` pool.

### Deployment / first connection

After deployment:

1. confirm `APP_URL=https://ai.mehroz.online` (or the actual public HTTPS origin)
2. open **Admin → Provider**
3. keep **Higgsfield MCP** enabled
4. click **Connect / Reconnect**
5. sign in to the paid Higgsfield account and approve authorization
6. after returning to Admin, the server attempts an automatic model sync
7. use **Sync models** manually if needed
8. review the synced list and hide any models that should not be sold to customers

No Higgsfield account credentials should be pasted into chat, env files, or the Admin secret fields.

### Live-schema validation note

The integration is schema-driven so it can adapt to Higgsfield's current MCP catalog. Static syntax and routing checks are performed before deployment, but the exact live MCP tool schemas can only be validated after the paid Higgsfield account completes OAuth. If a specific reference-image model exposes unusual parameter names or requirements, refine that model's schema mapping after the first real sync rather than hard-coding guessed IDs.


### Higgsfield live-schema sync compatibility patch — 2026-10-06

The first real Ultra-account connection confirmed OAuth works, but the live MCP tool schemas did not expose model IDs as JSON-Schema `enum` values. The original sync logic was too strict and returned:

`No image or video models were discovered from the current MCP tool schemas.`

The sync parser now also discovers model IDs from:

- JSON-Schema `example` / `examples`
- model-field defaults
- model-field descriptions and tool descriptions containing slug-style IDs
- model-specific generation tool names when no model parameter exists

A safe **Inspect MCP tools** action was added to Admin. It shows tool names, descriptions, property names, and sanitized model-field schema information, but never returns OAuth tokens or account passwords. Use this only when a future Higgsfield schema change cannot be auto-discovered.

Official Higgsfield automation documentation shows that MCP generation tools may accept `model` as a normal string (for example `soul_2`) rather than requiring an enum, so the integration must not depend on enum-only discovery.


### Higgsfield utility-tool filtering fix — 2026-10-06

A real customer-page test showed MCP utility/workflow tools being misclassified as sellable AI models (examples included Animation Actions, Explainer Presets, Video Analysis Jobs, and Virality Predictor).

The Higgsfield model sync now:

- requires a generation-like tool shape instead of treating any image/video-related tool as a model
- excludes analysis, predictor, preset, action, jobs, history, balance, status, workflow, and template utilities
- only uses a tool name as a model fallback when the tool name itself contains a recognized creative model family
- filters description-derived model IDs to recognized creative model families
- quarantines previously stored utility-tool rows by marking them unavailable during the next sync
- applies an additional customer-catalog safety filter so already-stored utility rows disappear from the customer UI immediately after deployment, even before a successful re-sync

The Admin catalog still retains unavailable rows for diagnostics/history, but customers only receive plausible creative models.


### Higgsfield authoritative models_explore sync — 2026-10-06

The deployed Ultra account exposed 146 MCP tools. Tool-schema inference was not reliable because Higgsfield exposes many workflows/utilities alongside creative generation tools.

The integration now uses Higgsfield's dedicated MCP catalog flow as the source of truth:

- locate `models_explore`
- call `action=list,type=image,limit=100`
- call `action=list,type=video,limit=100`
- map returned model fields (`id`, `name`, `provider_name`, `parameters`, `medias`, `aspect_ratios`, `durations`, `duration_range`) into `provider_models`
- route image models through the generic `generate_image` MCP tool
- route video models through the generic `generate_video` MCP tool
- wrap generation parameters inside the MCP `params` object when required by the live schema
- preserve tool-schema inference only as a backward-compatible fallback

Models imported from `models_explore` are tagged internally as `catalogVerified`. Customer/Admin catalogs trust these authoritative entries even when the model family is new and not present in our static heuristic list.

Old workflow/tool rows from the earlier inference attempt are hidden from Admin/customer catalogs once the new sync succeeds.

Reference images now use Higgsfield's MCP media flow instead of passing Mehroz signed URLs directly:

1. `media_upload` requests a provider upload URL and media ID
2. the worker PUTs the image bytes to the returned upload URL
3. `media_confirm` confirms the provider media
4. generation passes the returned media ID with a model-declared media role

The worker maps image references using the roles supplied by the live model catalog (`image`, `start_image`, `end_image`, `image_references`, or `input_images`). Models that do not declare an image-reference role reject reference uploads before customer credits are reserved.

Cost parsing also supports Higgsfield's nested `cost.credits_exact` response and generation responses that use a top-level `id`.


### Higgsfield generation mode mapping — 2026-10-06

Live catalog sync also preserves model `mode` options/defaults. When a model exposes `omni_reference` and reference media is present, the MCP payload automatically selects `omni_reference`; when prompt-only generation exposes `t2v`, it selects `t2v`. Otherwise the provider-declared default mode is used. This is important for models such as Seedance 2.5 and Cinema Studio that use different generation modes for prompt-only versus reference-driven requests.


### Hostinger/VPS MCP network compatibility — 2026-10-06

A deployed Hostinger test showed the browser-side Admin inspector returning `ERROR: Failed to fetch` while the Higgsfield account still appeared connected. This indicates a transport/network failure rather than an OAuth failure.

The Higgsfield MCP client now prefers IPv4 DNS resolution using Node's `dns.setDefaultResultOrder('ipv4first')`. This addresses a common Linux/VPS failure mode where Cloudflare-backed hosts resolve IPv6 first but the server has no working outbound IPv6 path, causing Node fetch to surface only `TypeError: fetch failed`.

Authenticated MCP requests also retry transient network failures up to three times with short backoff. Retry detection covers common socket/DNS timeout/reset/unreachable conditions and preserves OAuth errors separately.

If all retries fail, Admin receives a more useful MCP network error containing the safe cause/code chain instead of only the generic `Failed to fetch` string.


### Higgsfield Cloudflare/WAF compatibility — 2026-10-06

The official Higgsfield MCP endpoint is Cloudflare-fronted. A connected OAuth session can still fail on individual MCP tool calls if the server-side HTTP client presents a generic/non-browser user agent.

The Streamable HTTP MCP transport now sends a browser-like `User-Agent` on every request while leaving the SDK-managed Authorization, MCP protocol, and session headers intact.

The model-catalog response parser now also accepts JSON wrapped in Markdown code fences or surrounding explanatory text, because MCP tool text blocks are not guaranteed to contain raw JSON only.

When `models_explore` fails, Admin now receives the safe underlying cause instead of the previous generic "catalog could not be read" message. The existing catalog is still left unchanged on failure.


### Higgsfield official-catalog fallback — 2026-10-06

A deployed Ultra account returned no entries for the attempted `models_explore action=list` call even though OAuth and the MCP tool catalog were available. Higgsfield's current public CLI/Skills documentation treats `models_explore` primarily as a recommend/get discovery surface, while the official CLI repository publishes its generation `job_set_type` catalog generated from `higgsfield model list`.

The sync flow now uses this order:

1. try the live `models_explore` catalog
2. if it returns no usable entries, populate the current main image/video generation catalog from the official Higgsfield CLI model IDs/names
3. use the live MCP `generate_image` / `generate_video` tools for actual submissions and `get_cost`
4. retain tool-schema inference only as a last-resort compatibility fallback

The official fallback intentionally excludes analysis/background-removal-style utilities from the customer generation selector. It includes the main current image/video generation families such as GPT Image, Nano Banana, Seedream, Soul, Flux, Recraft, Kling image, Seedance, Kling video, Veo, Gemini Omni, Wan, MiniMax/Hailuo, Grok video, Cinema Studio, and Marketing Studio.

Fallback models are marked `catalogVerified` because their IDs are sourced from Higgsfield's official CLI/Skills repository rather than inferred from MCP utility tool names. The Admin success message reports `via official-cli-fallback` when this path is used.


### Current Higgsfield deployment status — 2026-10-06

Latest live test status:

- Higgsfield OAuth connection is successful; Admin shows `Account: connected`.
- The connected account exposes a large MCP tool surface, but `models_explore` did not return a usable full catalog for the attempted list flow.
- Previous heuristic discovery incorrectly surfaced workflow/utility tools as sellable models; those paths are now filtered/quarantined.
- The current implementation therefore uses the official Higgsfield CLI/Skills generation catalog as the model-list fallback while keeping all real generation activity on the authenticated MCP account.
- Actual image/video generation, live cost checks, reference-media upload/confirmation, and job polling still go through Higgsfield MCP and consume the connected account's credits.
- The provider-wide Admin ON/OFF switch and per-model Show/Hide controls remain authoritative for customer visibility.
- Higgsfield stays primary for overlapping synced/fallback models while enabled; existing sources remain fallback when Higgsfield is switched off.

Current sync order:

1. attempt live `models_explore`
2. if it returns no usable catalog, use the current official Higgsfield CLI/Skills generation model IDs and metadata
3. bind those models to the live MCP `generate_image` / `generate_video` tools
4. use live MCP `get_cost` before customer debit
5. use the Higgsfield provider-reported credit cost 1:1 for customer display/debit (including legitimate 0-credit subscription-covered generations)
6. submit through the authenticated Higgsfield account and poll the returned job

Current operational next step after deployment:

1. hard-refresh Admin
2. keep Higgsfield connected
3. press **Sync models**
4. expect the success message to identify either `models_explore` or `official-cli-fallback`
5. verify the Admin catalog contains actual generation models such as Seedance/Kling/Veo/Nano Banana rather than MCP workflow utilities
6. run one low-cost generation before increasing concurrency

Do not reconnect the account unless OAuth itself stops working; model-catalog sync failures alone do not require reconnecting.


### Capability-driven reference composer — 2026-10-06

The customer creation UI is now model-aware instead of assuming every video model accepts the same six images.

Each dynamic provider model exposes normalized reference capabilities through the public catalog:

- image references: supported, max/min count, allowed semantic roles, required roles
- video references: supported, max/min count, allowed semantic roles, required roles
- audio capability metadata is retained for future UI expansion
- total reference-file maximum
- text-only detection

The customer composer automatically changes when the selected model changes:

- text-only models hide reference upload controls
- models with one start frame show a single-image capability
- models with start/end frame support expose semantic roles
- multi-image models show their model-specific image limit
- video-reference capable models show a separate video upload block with the model-specific limit
- unsupported reference types disappear
- changing models trims/removes incompatible references and remaps roles safely
- the model selector shows a compact capability summary such as `Text to video · no reference uploads`, `References optional · image refs: 9`, or `References required · frame/image refs: 1`

Reference roles are preserved in multipart submission and stored in `generation_media` for dynamic provider jobs. Supported roles include:

- `start_image`
- `end_image`
- `image_references`
- `video_references`
- provider-compatible aliases such as `image`, `input_images`, `video`, and `input_videos`

Backend validation mirrors the UI and runs before customer credits are reserved:

- rejects unsupported image/video references
- enforces per-type maxima/minima
- enforces total-reference limits
- rejects duplicate fixed semantic roles
- enforces required roles
- enforces `end_image` requiring `start_image` when declared
- rejects video uploads for legacy/static providers that do not support them

Dynamic video reference files support MP4, WebM, and MOV up to 25 MB each. Dynamic image references support JPEG, PNG, and WebP.

The Higgsfield worker reads `generation_media`, uploads each reference through the provider media-upload/confirm flow, and sends the exact stored semantic role with the provider media ID.

Static legacy video models retain the existing six-image behavior, so the new capability system does not break older Vidancee/CreatePulse/vgenv flows.

Deleting a generation explicitly removes both `generation_images` and `generation_media` before deleting the parent generation. This protects older deployments whose foreign-key cascades may not match the current schema.


### Per-customer provider/source assignments — 2026-10-06

Admin can now control which backend sources are available to each individual customer.

Admin path:

- `/admin-console` → **Users** → **Sources**

Assignable sources:

- Higgsfield
- Vidancee
- CreatePulse
- MiniMax / vgenv
- Atlas Cloud

The access model is layered:

1. provider credentials/configuration must exist
2. the provider-wide Admin ON/OFF switch remains the master switch
3. the customer must be assigned that source
4. only models backed by allowed/active sources are returned to that customer's `/api/config`

The server enforces source access at submission time as well as in the UI, so a stale page or direct API call cannot bypass the customer's assignment.

A new `user_provider_access` table stores per-user source permissions. Missing rows intentionally default to enabled for backward compatibility with existing customers.

Legacy Seedance routing also respects per-user Vidancee/CreatePulse access. MiniMax H3 respects per-user vgenv access. Atlas image generation respects per-user Atlas access. Higgsfield dynamic image/video models and live cost checks respect per-user Higgsfield access.

The customer app reloads `/api/config` immediately after authentication so newly assigned source/model access takes effect without requiring a second login.


### Higgsfield customer pricing rule — 2026-10-06

Higgsfield is an explicit exception to the older universal markup rule.

For Higgsfield-backed models:

- the customer-facing cost uses the provider-returned Higgsfield credit amount 1:1
- the same value is reserved/deducted at submission
- no 2.5× multiplier is applied
- a provider-reported cost of `0` is valid and must display as `0 credits`
- zero-cost dynamic image/video jobs must not fall back to legacy static pricing

The live cost parser accepts nested/wrapped MCP responses and common credit field names. `/api/model-cost`, dynamic generation creation, and provider-cost persistence all accept zero as a valid non-negative cost.


### Admin dashboard visual refresh — 2026-10-06

The Admin console was restyled to match the customer-facing Mehroz AI visual system:

- charcoal/black surfaces
- lime accent
- tighter data density
- cleaner tables/forms/buttons
- improved Provider cards and switches
- responsive source-assignment modal in Users

This was a visual refresh only; existing Admin functionality remains intact.


### Seedance 2.0 Fast 15-second support — 2026-10-07

The legacy Vidancee-backed `seedance_2.0_fast` model now exposes both:

- 10 seconds
- 15 seconds

Pricing keys:

- `PRICE_SEEDANCE_20_FAST_10`
- `PRICE_SEEDANCE_20_FAST_15`

The 15-second default fallback source cost is proportional to the 10-second fallback. Vidancee submission already forwards the selected duration directly to `generate.php`, so no provider-adapter change was required.


### Dynamic selector/cost UI fixes — 2026-10-06

Recent customer UI fixes:

- model-specific aspect-ratio options now rebuild the custom dropdown whenever the selected model changes
- dynamic cost preflight sends the current prompt and model options
- Higgsfield cost parsing accepts additional nested/string-wrapped MCP response shapes
- invalid/missing dynamic costs still fall back to the existing "at submit" presentation, but valid zero-cost responses no longer do

## Production stability architecture — 2026-10-07

The production deployment is now intentionally split into **two Hostinger Node.js applications**.

### Main customer/API application

```text
Domain: https://ai.mehroz.online
Entry file: server.js
WORKER_ENABLED=false
```

Responsibilities:

- customer UI
- authentication
- Admin UI/API
- generation submission
- MySQL queue writes
- credits/plans/account APIs
- media delivery/proxying
- provider configuration management

It does **not** run the generation worker.

Lightweight liveness endpoint:

```text
GET https://ai.mehroz.online/live
```

Full health endpoint:

```text
GET https://ai.mehroz.online/health
```

### Standalone generation worker

```text
Domain: https://worker.mehroz.online
Entry file: worker.js
WORKER_ENABLED=true
APP_URL=https://ai.mehroz.online
```

Responsibilities:

- queue polling
- provider submission
- provider status polling
- generation completion/failure updates
- refunds/failure handling
- Higgsfield/Vidancee/CreatePulse/vgenv/Atlas provider workload

Worker health endpoint:

```text
GET https://worker.mehroz.online/health
```

Verified production response:

```json
{"ok":true,"service":"mehroz-ai-worker","pid":808232,"uptimeSeconds":2099}
```

The worker and web app use the **same MySQL database** and the same encryption-compatible provider settings.

### Why this split is required

The original single-app deployment intermittently became unreachable even when no code/deployment changes were made.

The lightweight `/live` endpoint also timed out, proving the outage was not caused only by MySQL or a provider API route.

Runtime logs showed external process termination:

```text
[runtime] SIGTERM received ...
```

When the main app worker was disabled:

```env
WORKER_ENABLED=false
```

the main site remained live.

A dedicated Hostinger worker application was then deployed and remained stable. A real customer task was submitted, picked up by the standalone worker, completed successfully, and returned to the dashboard.

Therefore:

- **do not enable the worker inside the main web app**
- keep `WORKER_ENABLED=false` on `ai.mehroz.online`
- keep `WORKER_ENABLED=true` only on `worker.mehroz.online`

### Hostinger worker settings

```text
Framework: Other
Node version: 20.x
Branch: main
Root directory: ./
Package manager: npm
Build command: npm run build
Entry file: worker.js
```

Do not use `npm run worker` as Hostinger's build command. It is a runtime script, not a build step.

### Shared worker environment

At minimum, the worker needs the same database and encryption-compatible settings as the web app:

```env
NODE_ENV=production
APP_URL=https://ai.mehroz.online
WORKER_ENABLED=true
DB_HOST=
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=
SETTINGS_ENCRYPTION_KEY=
ADMIN_TOKEN=
```

Do not set `APP_URL` to the worker domain.

### Higgsfield OAuth stability

Production logs also exposed rotating refresh-token reuse:

```text
OAuth "invalid_grant"
The refresh token was already used.
```

The MCP integration now serializes authenticated OAuth activity with a MySQL advisory lock so concurrent application processes do not refresh the same token simultaneously.

If the current stored refresh token is already invalid, reconnect Higgsfield once in Admin.

### Current production verification

Verified on 2026-10-07:

- main site remained live with its internal worker disabled
- standalone worker health endpoint remained online with the same PID for more than 2,000 seconds
- customer task submission succeeded
- standalone worker picked up the queued task
- task completed successfully
- completed result appeared back in the customer dashboard

This split web/worker deployment is the current recommended production architecture.

## Vibi voice generation and cloning — 2026-10-07

Voice generation now uses the official Vibi API instead of AI Tools Flow.

### Provider

```text
Base URL: https://api.vibi.pro
Authentication: xi-api-key
Admin source key: vibi
```

The API key is saved encrypted in Admin provider settings. Do not commit it to the repository.

### Supported voice features

- text-to-speech with Vibi-supported ElevenLabs and MiniMax models
- Vibi default/system voice browsing
- customer-owned MiniMax cloned voices
- async voice generation queue/polling
- MP3 playback/download through Mehroz AI
- voice-clone sample upload (maximum 20 MB per Vibi docs)
- clone status polling
- per-customer Voice source assignment

### Production flow

```text
Customer Voice Studio
  -> Mehroz AI API
  -> MySQL queue
  -> standalone worker.mehroz.online
  -> Vibi API
  -> Vibi history / clone polling
  -> Mehroz AI dashboard
```

Provider API calls and clone uploads are performed by the standalone worker where practical, preserving the split web/worker stability architecture.

### Voice billing

TTS reserves a conservative credit estimate at submission. Once Vibi reports the final `credits_deducted` value, the worker reconciles the customer charge to:

```text
Vibi source credits × 2.5
```

Higgsfield remains the existing 1:1 pricing exception.

Vibi's documentation does not define a fixed voice-cloning credit formula, so clone creation uses an Admin-configurable customer cost (`vibi_clone_customer_cost`) rather than inventing a provider cost.

### AI Tools Flow

The unfinished AI Tools Flow integration was intentionally removed after Vibi's official API documentation became available. Vibi is now the supported voice backend.

# Project Handoff — Vidancee Direct SaaS

**Repository:** `thesfjksa/vidancee-direct-saas`  
**Branch:** `main`  
**Current stage:** Milestone 1 direct provider connector.

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

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

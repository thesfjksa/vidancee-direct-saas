# CMM Tools Hostinger Deployment

Updated 11 October 2026.

The production deployment uses **two separate Hostinger Node.js applications** connected to the same GitHub repository and the same MySQL database.

This split is intentional. The customer-facing web app must stay lightweight and must not run the generation worker in the same Hostinger application.

## GitHub repository

```text
thesfjksa/vidancee-direct-saas
```

Use the `main` branch for both Hostinger applications.

A push to `main` does not start a deployment on its own (checked 20 October 2026: two pushes left both applications running the previous version). After merging, click Redeploy in hPanel for each application, then confirm `/live` shows a new `startedAt`.

---

## Production architecture

| Component | Origin | Entry | Worker flag |
| --- | --- | --- | --- |
| Customer web and API | https://cmmtools.site | server.js | WORKER_ENABLED=false |
| Standalone generation worker | https://worker.mehroz.online | worker.js | WORKER_ENABLED=true |

Both applications connect to the shared MySQL queue and encrypted Admin settings. The worker handles ArgoLink, Vercel AI Gateway, SmartAIPI, Vidancee, CreatePulse, vgenv and Vibi work. Gemini prompt enhancement runs asynchronously in the web process. Its in-memory records are not persistent across restarts.

The web app and worker use the same database and Admin-managed provider settings.

The main app writes queued generations into MySQL. The worker app picks up those jobs, submits them to the configured providers, polls provider status, and writes completion/failure state back into MySQL.

The web app also wakes the standalone worker with a non-blocking GET to its health endpoint when it saves a job. On cmmtools.site this defaults to https://worker.mehroz.online/live. Other deployments should set `WORKER_WAKE_URL` explicitly; a blank value disables it. Active image-status polling repeats this wake request at most once per 15 seconds. No customer content or API credentials are sent. GPT image pickup runs independently of video-provider polling. Worker `/health` revision 6 shows whether the consumer is enabled and when each polling loop last ran. A healthy HTTP response alone does not confirm enabled processing.

---

## Main web application

Production domain:

```text
https://cmmtools.site
```

Recommended Hostinger settings:

```text
Framework: Other
Node version: 20.x
Branch: main
Root directory: ./
Package manager: npm
Build command: npm run build
Entry file: server.js
```

Important environment setting:

```env
WORKER_ENABLED=false
```

The main application must **not** run the generation worker.

The main app exposes:

```text
GET /live
GET /health
GET /
GET /admin-console
```

### Main app liveness check

```text
https://cmmtools.site/live
```

`/live` is intentionally lightweight. It does not depend on MySQL or any AI provider.

If `/live` is unavailable, the Node process or Hostinger routing to that process is unavailable.

### Main app health check

```text
https://cmmtools.site/health
```

`/health` includes database/service readiness and runtime diagnostics.

---

## Standalone worker application

Production worker domain:

```text
https://worker.mehroz.online
```

Recommended Hostinger settings:

```text
Framework: Other
Node version: 20.x
Branch: main
Root directory: ./
Package manager: npm
Build command: npm run build
Entry file: worker.js
```

The repository also contains:

```text
npm run worker
```

for manually starting the worker, but in Hostinger the correct configuration is:

- Build command: `npm run build`
- Entry file: `worker.js`

Do **not** put `npm run worker` in Hostinger's Build command field.

Important environment setting:

```env
WORKER_ENABLED=true
```

Worker health endpoint:

```text
https://worker.mehroz.online/health
```

Worker health includes `revision: 6` (a worker that is still starting answers `starting: true`; the health port opens before the database and catalog setup so Hostinger does not stop a fresh worker), `workerEnabled`, general `polling` timestamps and independent `imagePolling` diagnostics. For configured image processing, check:

- `imagePolling.enabled` and `imagePolling.sourceReady`
- recent `lastStartedAt`, `lastFinishedAt` and `lastSuccessfulAt`
- `imagePolling.activeTasks`, alongside configured inflight limits
- increasing `uptimeSeconds` and a stable PID between deployments

Use `/health` or `/live` without a query string on this worker. An HTTP 200 response alone does not prove active queue processing or a successful upstream generation.

A continuously increasing `uptimeSeconds` value with the same PID indicates the worker is staying alive.

The standalone worker has been production-verified to:

- stay online independently
- read queued jobs from the shared MySQL database
- process submitted customer generations
- write completed results back to the customer application

---

## Shared environment variables

Both applications must point to the same MySQL database.

Typical shared values:

```env
NODE_ENV=production
APP_URL=https://cmmtools.site

DB_HOST=
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=

SETTINGS_ENCRYPTION_KEY=
ADMIN_TOKEN=
```

Use the exact same database credentials in both applications.

If `SETTINGS_ENCRYPTION_KEY` exists on the main app, the worker must use the exact same value so it can read encrypted Admin-managed provider credentials/settings.

If `ADMIN_TOKEN` is used as an encryption fallback in the current deployment, keep it identical between the two applications.

Hostinger supplies `PORT`. Do not normally define `PORT` manually.

### APP_URL on the worker

Even though the worker has its own domain, keep:

```env
APP_URL=https://cmmtools.site
```

Do not set `APP_URL` to `https://worker.mehroz.online`.

Public callbacks and signed provider asset URLs should continue using the real customer application domain.

---

## Worker-specific environment

Main app:

```env
WORKER_ENABLED=false
```

Worker app:

```env
WORKER_ENABLED=true
```

Only one production worker should normally be active unless the queue implementation is deliberately changed for multi-worker locking/concurrency.

---

## Why the worker was separated

The original deployment ran the HTTP server and generation worker inside the same Hostinger Node application.

Production runtime logs showed repeated platform-level termination:

```text
[runtime] SIGTERM received ...
```

and the entire customer site, including the lightweight `/live` route, became unreachable with `ERR_CONNECTION_TIMED_OUT`.

The logs also showed the application being started repeatedly by Hostinger.

The worker was disabled on the main app:

```text
[worker-child] disabled by WORKER_ENABLED
```

and the main site remained live.

A second Hostinger Node application was then created for `worker.js`. The standalone worker remained healthy for an extended period and successfully processed a real submitted generation while the main site stayed online.

Current conclusion:

- keep the web process and generation worker separated
- do not re-enable the worker inside the main `cmmtools.site` application
- treat Hostinger `SIGTERM` as a platform/process-supervisor event rather than a provider API exception

---

## Runtime diagnostics

The main server logs:

- uncaught exception monitor events
- unhandled promise rejections
- SIGTERM
- SIGINT
- process exit diagnostics
- RSS/heap memory
- system free memory/load

Example:

```text
[runtime] SIGTERM received {"pid":...,"uptimeSeconds":...,"rssMb":...}
```

The worker also logs startup/shutdown/runtime information.

Useful production checks:

```text
https://cmmtools.site/live
https://cmmtools.site/health
https://worker.mehroz.online/health
```

When diagnosing an outage, check these endpoints before redeploying.

---

## Security

Never commit real values for:

- provider passwords
- provider API keys
- OAuth tokens
- PHPSESSID
- CSRF tokens
- ADMIN_TOKEN
- SETTINGS_ENCRYPTION_KEY
- database passwords
- payment secrets

Provider credentials are managed through the private Admin UI and encrypted at rest where supported.


Worker polling timers keep the Node event loop alive until shutdown. They are cleared by `stop()` on SIGTERM/SIGINT, so the consumer cannot exit merely because a request finished and only background polling remained.


## Current readiness check

Public checks on 2026-10-11 returned HTTP 200 for the customer page, public config, web health and worker health. The web database was connected. Worker revision 4 reported recent general/image polling and image source readiness. This is an availability check, not a paid provider-generation test. Web health `workerEnabled=false` and `workerOnline=false` are expected in the separated production architecture.

Web health `services.queueRevision=1` identifies the non-blocking wake implementation, and `services.imageCanvasRevision=1` identifies the selected-canvas request and output-validation update. Public config `promptEnhancer.revision=5` identifies enhancement status recovery. On the current UI the stylesheet version is `cmm-7`.

## Vercel AI Gateway deployment

Keep both applications on CommonJS and Node 20 or later. No new SDK dependency or Node runtime change is required. Startup adds `generations.provider_operation`, `generations.generation_options`, `provider_models.price_override` and the chunked video-output tables. Both processes seed the initial public media catalog when no Vercel entries exist; a catalog-seeding error does not stop existing provider queues. Configure the encrypted API key in Admin after deployment. Alternatively `AI_GATEWAY_API_KEY` is imported once when no saved key exists.

Verify web `services.mediaGatewayRevision=1`, worker `revision=5` and the `gatewayPolling` timestamps. `gatewayPolling.sourceReady=false` is expected until an API key is saved, the source is enabled and generation submissions are enabled. Catalog presence and HTTP health do not prove paid generation or account quota.

## Domain: cmmtools.site

The customer app lives at `https://cmmtools.site` (and `www.cmmtools.site`). It moved from `ai.mehroz.online`, whose HTTPS no longer works. The worker stays at `worker.mehroz.online`.

- Both apps: `APP_URL=https://cmmtools.site`. The code also treats an old `APP_URL=https://ai.mehroz.online` as `https://cmmtools.site`, so provider reference-image links always use the new domain, but update the setting anyway.
- Web app: `WORKER_WAKE_URL` can stay unset (default `https://worker.mehroz.online/live`).
- Visits to `ai.mehroz.online` (if its SSL comes back) redirect `/` and `/admin-console` to cmmtools.site without any setting. `CANONICAL_URL` overrides the target.
- Keep `ADMIN_TOKEN` and `PROVIDER_ASSET_SECRET` unchanged, or links already handed to providers stop verifying.

Customers sign in again once on the new domain (login cookies belong to a domain); the Admin token is re-entered once too. The database, credits, images and videos are shared.

# Changelog

## 2026-10-04 — Milestone 1 initialized

- Created fresh GitHub project for direct Vidancee integration.
- Added Hostinger-compatible Node server.
- Added authenticated Vidancee connector.
- Added text-to-video submission.
- Added jobs polling and provider-status inspection.
- Added provider-spend safety switch.
- Added admin-only test UI.
- Added tests and deployment/protocol/handoff documentation.

## 2026-10-04 — Hostinger 503 hardening

- Added explicit package main/build/start configuration.
- Added `app.js` compatibility launcher.
- Prevented missing ADMIN_TOKEN from killing the web process.
- Added safe configuration indicators to `/health`.
- Documented `PORT=3000` for Hostinger managed Node hosting.

## 2026-10-04 — Fix LiteSpeed ERR_REQUIRE_ASYNC_MODULE

- Converted runtime from ESM to CommonJS for Hostinger LiteSpeed compatibility.
- Removed top-level await from the entry graph.
- Converted provider module and tests to CommonJS.

## 2026-10-04 — Production provider login verified

- Hostinger deployment at ai.mehroz.online is live.
- Vidancee authentication succeeded from production.
- jobs.php provider-state read succeeded.
- Observed provider state: 321 credits, concurrency 1, processing 0.
- Next checkpoint: one controlled paid text-to-video generation.

## 2026-10-04 — First production generation submitted

- Successfully submitted provider job 1410 from ai.mehroz.online.
- Confirmed generate.php integration from production.
- Added automatic per-job polling to the Milestone-1 test console.
- Completed jobs now surface direct video/poster links in the test console.

## 2026-10-04 — Milestone 2 multi-user SaaS layer

- Added MySQL persistence and automatic schema initialization.
- Added user registration/login/session authentication.
- Added customer credit ledger and atomic debits/refunds.
- Added persistent generation records and provider job mapping.
- Added background queue/worker with provider concurrency awareness.
- Added real customer dashboard and generation history.
- Added same-origin media proxy.
- Added admin user listing and credit adjustment controls.

## 2026-10-04 — Fix pricing syntax and non-blocking DB startup

- Quoted model IDs containing periods in src/pricing.js.
- Start HTTP server before MySQL initialization.
- Added MySQL connection timeout and keep-alive options.

## 2026-10-04 — Milestone 2 production DB verified

- Production /health is green.
- MySQL configured=true and connected=true.
- Provider credentials configured.
- Customer signups enabled.
- Ready for first end-to-end customer account + credits + generation test.

## 2026-10-04 — Fix admin user/credit routes

- Normalize route trailing slashes.
- Add credit adjustment by user ID or email.
- Update admin console to accept email identifiers.

## 2026-10-04 — Milestone 3 complete dashboard/admin application

- Rebuilt customer UI as a responsive multi-page-style SPA.
- Added overview, create, library, credits and account sections.
- Added customer dashboard/credit-ledger/password APIs.
- Rebuilt admin console with stats, users, generations, credit ledger and provider monitoring.
- Added user enable/disable controls and searchable admin tables.
- Made worker respect ALLOW_PROVIDER_CHARGES.

## 2026-10-04 — Add Image → Video end-to-end

- Captured exact Vidancee image-to-video multipart fields.
- Added browser image upload UI with previews.
- Added multipart parsing with Busboy.
- Added generation_images MySQL table for queued reference images.
- Added provider generateImage() using images[] and max_retries=3.
- Updated worker to submit image-to-video jobs and clear temporary blobs after submission.

## 2026-10-04 — Add CreatePulse overflow backend

- Added CreatePulse official API adapter.
- Added Vidancee-to-CreatePulse overflow routing.
- Added configurable CreatePulse inflight cap.
- Added CreatePulse-compatible image-to-video routing via signed temporary image URLs.
- Migrated provider job IDs to string storage for CreatePulse batch IDs.
- Added provider column to admin generation monitoring.

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

## 2026-10-04 — Enable CreatePulse Seedance 2.5 long durations

- Added CreatePulse mappings for Seedance 2.5 15s, 20s and 30s.
- 30-second Seedance 2.5 customer jobs can now use CreatePulse overflow routing.
- Added optional PRICE_SEEDANCE_25_20 customer pricing switch.
- Expanded CreatePulse image routing to the app's full 6-image upload limit.

## 2026-10-04 — Lock public aspect ratios to shared provider support

- Public aspect-ratio options are now limited to 9:16, 16:9, 1:1 and 4:3.
- Removed 3:4 and 21:9 from customer generation options.
- Ensures every visible ratio can route to either backend without exposing provider differences.

## 2026-10-04 — Unified generation form and hide backend providers

- Removed the customer mode selector.
- Optional reference images now automatically determine image-assisted generation.
- Server derives generation mode from file presence and ignores customer mode selection.
- Removed provider identity from customer generation API responses.
- Sanitized public /health to avoid backend/source disclosure.
- Replaced provider-named customer failure messages with generic generation errors.

## 2026-10-04 — Professional customer UI redesign

- Rebuilt the customer-facing layout as a modern AI creative studio.
- Added premium auth, sidebar, overview, generation composer, library and account UX.
- Improved responsive behavior for tablet and mobile.
- Preserved the unified prompt + optional-reference-image generation workflow.

## 2026-10-04 — Gallery-first creative studio UI

- Rebuilt customer workspace around a left-side generation composer and large render gallery.
- Added compact global navigation and responsive mobile dock.
- Added render status filters and masonry-style media cards.
- Made Create the default signed-in workspace.
- Preserved one unified prompt + optional image workflow.

## 2026-10-04 — Preserve video playback during live polling

- Replaced full gallery re-renders with keyed per-generation DOM updates.
- Existing video elements are preserved when generation data is unchanged.
- Prevented playback resets caused by 5-second background refreshes.
- Added a pending-request guard to avoid overlapping generation polling.
- Paused generation polling while the browser tab is hidden.

## 2026-10-04 — Admin-managed provider credentials

- Added database-backed provider settings in the private Admin dashboard.
- Provider passwords/API keys are encrypted before persistence.
- Worker reloads saved provider credentials dynamically without redeploy.
- Routing, overflow concurrency and generation enable/pause can be controlled from Admin.
- Added one-time migration from legacy provider ENV values.

## 2026-10-04 — Theme-matched custom dropdowns

- Replaced visible native Model, Duration and Aspect Ratio menus with custom dark dropdown components.
- Prevented Windows/Edge native blue option styling from appearing in the customer studio.
- Preserved hidden native select state and existing change-event behavior.

## 2026-10-04 — Generation card actions

- Added Reuse prompt action to restore prompt/model/duration/aspect ratio into Create.
- Added Download action for completed videos.
- Added confirmed Delete action for terminal generations.
- Added ownership-scoped DELETE /api/generations/:id endpoint.
- Active/in-progress generations cannot be deleted.

## 2026-10-05 — Harden Admin generations API

- Replaced generic "Invalid server response" handling with HTTP status and sanitized non-JSON response diagnostics.
- Made Admin generations query explicit and lighter.
- Added idempotent migrations for current multi-provider generation columns.
- Fixed missing deleteUserGeneration server import.

## 2026-10-05 — Lock Seedance 2.0 Fast to 10s

- Removed 15s and 30s customer duration exposure for Seedance 2.0 Fast.
- Added single-option dropdown behavior so a one-value Duration control no longer opens an unnecessary menu.

## 2026-10-05 — Fix generation deletion on older databases

- Explicitly detach credit-ledger rows before deleting a generation.
- Explicitly delete stored generation image rows.
- No longer relies solely on historical foreign-key ON DELETE definitions.
- Keeps credit history while allowing terminal generations to be removed reliably.

## 2026-10-05 — Restore images with Reuse prompt

- Reuse prompt now reloads saved reference-image thumbnails.
- Added authenticated per-generation reference-image delivery route.
- Added backend copying of selected reused images into new generation jobs.
- Reused and new uploads can be combined up to 6 total images.
- Added remove control for reused reference images.
- Workers now retain reference-image blobs until the generation itself is deleted.
- Older jobs whose images were already purged cannot recover those historical blobs.

## 2026-10-05 — Reference image delete and reorder controls

- Added a small remove icon to every reference-image thumbnail.
- Added drag/drop thumbnail reordering.
- Added touch/pointer drag support through a compact grip control.
- Added direct file drag/drop onto the reference upload area.
- Added backend referenceOrder validation and exact position persistence.
- Mixed reused + fresh reference images now retain the user-selected order through provider submission.

## 2026-10-05 — Remove login flash on refresh

- Added a lightweight boot/session-check screen.
- Auth and dashboard remain hidden until /api/me resolves.
- Valid sessions now open directly into the dashboard without flashing the login form.
- Unauthenticated users see the login screen only after the session check returns 401.

## 2026-10-05 — Add Atlas Cloud image generation

- Added a dedicated customer Images workspace.
- Added text-to-image and reference-guided image generation.
- Added Seedream 5.0 Lite and Nano Banana 2 model mappings.
- Added Atlas Cloud asynchronous submit/poll adapter.
- Added Admin-managed encrypted Atlas Cloud API key/base URL/max-inflight settings.
- Added media_type migration so video and image jobs share the generation/credit system safely.
- Added image generation APIs, gallery, download and delete controls.
- Added reference upload/remove/reorder support for image generation.
- Scoped existing video APIs/worker queries to video jobs.
- Added customer image credit pricing overrides.

## 2026-10-05 — Add vgenv MiniMax H3 and universal 2.5× markup

- Added vgenv REST client for MiniMax H3.
- Added MiniMax H3 to the customer video model selector.
- Added H3 durations from 4–15 seconds.
- Added H3 text-to-video and ordered reference-image video generation.
- Added H3-specific 5 MB reference-image validation.
- Added Admin-managed encrypted vgenv API key/base URL/max-inflight settings.
- Added dedicated worker routing so MiniMax H3 goes only to vgenv.
- Added vgenv polling, provider cost capture, success output handling, and failure refunds.
- Hid H3 from customer config until vgenv is configured.
- Added central CUSTOMER_CREDIT_MULTIPLIER with default 2.5.
- Applied the 2.5× pricing rule to all existing video and image models.
- Migrated credit balances, generation costs, and ledger amounts to DECIMAL(12,2).
- Enabled decimal Admin credit adjustments.

- Added v1/v2 endpoint compatibility fallback for the vgenv Video resource.

## 2026-10-05 — Add Basic, Pro and Premium plans

- Added Basic at PKR 1,500/month with 500 credits.
- Added Pro at PKR 4,500/month with 1,500 credits.
- Added Premium at PKR 12,000/month with 4,000 credits.
- Added customer Plans page and plan request flow.
- Added Admin Plans tab for manual payment verification/approval.
- Plan approval grants the included credits and writes a plan_credit ledger transaction.
- Added users.plan_code and plan_requests persistence.
- Added plan concurrency limits: 2 / 3 / 5 active generations.
- Added plan queue priorities and priority-aware worker ordering.
- Unsubscribed users retain a one-generation concurrency limit.
- Kept the existing universal 2.5× model-cost rule separate from plan pricing.

## 2026-10-05 — Fix Provider settings save 403

- Switched Admin provider-settings save requests from PUT to POST to avoid production edge/WAF browser challenges.
- Kept PUT support server-side for backward compatibility.
- Added friendly detection of Cloudflare/edge HTML challenge responses in the Admin API helper.

## 2026-10-05 — Add video resolution selection

- Added model-specific Resolution control to the video composer.
- Added MiniMax H3 480p and 768p options, with 768p as default.
- Added resolution-aware H3 credit pricing under the universal 2.5× rule.
- Added generations.resolution persistence and migration.
- Reuse prompt now restores the selected resolution.
- Generation cards and Admin monitoring now show resolution.
- vgenv requests now receive the customer's selected H3 resolution.
- Seedance keeps its provider-defined resolution without showing a redundant selector.

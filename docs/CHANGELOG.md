# Changelog

## 2026-10-12 — GPT Image models from the AI Gateway

- The gateway catalog already contained GPT Image 1, 1 Mini, 1.5, 2, 2.5 Flare and 2.5 Sunburst, but bills them by tokens, so they had no per-image price and stayed hidden until an Admin price was set. They now use OpenAI's published per-image prices (see `docs/VERCEL_AI_GATEWAY.md`), become ready without setup and are marked as estimates because prompt and reference input tokens are extra. GPT Image 2.5 uses GPT Image 2's figures as an estimate; an Admin price still overrides.
- The image picker shows one entry per model name. A model another source already provides to the customer (SmartAIPI's GPT Image 2, 2.5 and 1.5 on the live site) keeps its entry; the gateway copy appears when that source is unavailable. GPT Image 1 and 1 Mini are new for customers with gateway access.
- Not verified with a paid gateway request from this environment.

## 2026-10-12 — Outages after Admin actions

- Report: the site went offline for a few minutes after Admin actions such as assigning a customer to the AI Gateway source. The web process had in fact been running without a restart for 12.7 hours (since the 17:08 UTC deploy on 11 October, 97 MB RSS), so these outages did not come from an application crash. The browser error seen earlier (`ERR_CONNECTION_TIMED_OUT`) means the connection to Hostinger's edge itself failed.
- Hostinger's edge firewall has challenged `PUT` requests from this site before (see 2026-10-05). The Sources assignment still sent `PUT`; Disable/Enable user sent `PATCH`; customer deletes sent `DELETE`. All browser requests now use `POST`: `POST /admin/users/:id/providers`, `POST /admin/users/:id` (status/role) and `POST /api/{generations|image-generations|voice-generations}/:id/delete`. The old methods remain accepted for clients that have not reloaded. A test from outside Pakistan was not blocked for any method, so the firewall's behaviour for the owner's connection is not directly verified.
- Diagnostics, so the next report can be answered with evidence: `runtime_boots` stores every web and worker start; the web process measures event-loop freezes (over 1s) and requests slower than 5s. `/health` and `/live` include `startedAt`, current and worst event-loop lag and the stall count. `GET /admin/diagnostics` (admin token) returns details and the boot history; the Admin Overview shows it as "Server health". Deploys count as starts.

## 2026-10-11 — Instant credit estimates

- `/api/config` includes a price table (`costTable`, keyed `ratio|quality|size`, plus `costEstimates`) for every AI Gateway image model, computed with the same `quoteGateway` used by `/api/model-cost` and the current Admin conversion rate. The Image Studio shows the cost immediately without a request; 97 sampled combinations matched `/api/model-cost` exactly.
- Remaining server quotes (video and non-gateway models) are cached per selection, limited to 10s and retried once, so a slow request no longer ends in "at submit".

## 2026-10-11 — Recraft image sizes

- Recraft accepts only fixed sizes per aspect ratio, and the generic size calculation was valid only for 1:1. Every non-square Recraft request (for example Recraft V4 at 3:4 as 768x1024) was rejected by the AI Gateway with HTTP 400. Requests now use Recraft's size tables: V2/V3 (3:4 = 1024x1365), V4/V4.1/Flash (3:4 = 896x1216) and V4/V4.1 Pro (double the V4 sizes, 3:4 = 1792x2432).
- The returned-image aspect check allows 3% instead of 2.5%, because Recraft's 3:2 size (1280x832) differs from an exact 3:2 by 2.6%. Distinct shapes still differ by at least 6.7%.
- Not verified against a live paid Recraft request from this environment.

## 2026-10-11 — Faster recovery of interrupted images and live status

- The browser gives status reads a 20s limit, so one hung request (for example during a hosting timeout) no longer freezes gallery updates until a reload. Measured: a hung list request previously left a finished job showing "Processing" indefinitely; the page now updates within about 23s.
- Worker heartbeat: every pass, the worker marks its in-flight AI Gateway and GPT image requests as alive. A "processing" image that has not been marked for 3 minutes belonged to a worker that restarted or was killed, and is refunded then, instead of after 10 minutes. Requests still running in a live worker are never expired.
- On SIGTERM (for example a redeploy), the worker stops claiming new jobs and waits up to `WORKER_SHUTDOWN_DRAIN_MS` (default 25s) for in-flight image requests to finish and save before exiting.
- Redeploying the worker application during a long render can still interrupt it; such jobs are refunded automatically. Prefer deploying the worker while no generations are running.

## 2026-10-11 — Instant reuse of image references

- Reuse prompt on a reference-based image no longer downloads and re-uploads the reference files. The image list includes reference metadata (no bytes), the form restores references as pointers, and submissions send `reuseGenerationId` plus a `referenceOrder` such as `[{"kind":"reused","id":2},{"kind":"upload"}]`.
- The server (`src/reference_reuse.js`) loads the customer's own stored references, merges them with new uploads in the given order and then runs the existing model, count and size validation unchanged. References from another account, duplicates and mismatched upload counts are rejected.
- Measured in a throttled browser: prompt, settings and references restore in about 20 ms with Generate ready immediately, down from about 2.5–5s.

## 2026-10-11 — Gallery previews and instant prompt reuse

- Image galleries load small WebP previews (768px wide, about 140 KB instead of 2–5 MB) from `/api/image-generations/:id/thumbnail`. Previews are created on first view with the optional `sharp` dependency, stored in the new `generation_image_thumbnails` table (created automatically on startup) and cached by the browser. Database and provider-hosted images are both supported. Without `sharp`, the route serves the original image.
- The image preview dialog shows the cached preview instantly and swaps in the full-resolution original once it downloads. Downloads always use the original.
- Reuse prompt fills the prompt and settings immediately from data already on the page. Only reference images are fetched in the background; the prompt stays editable and Generate waits until references are restored. Text-only generations make no network request.
- Optional tuning: `IMAGE_THUMB_WIDTH` (default 768), `IMAGE_THUMB_QUALITY` (default 76) and `IMAGE_THUMB_CONCURRENCY` (default 2).
- Local measurement on a throttled 40 Mbit/s connection with 60 stored 4.4 MB images: visible Image Studio cards loaded in 1.4s on first visit and 0.6s afterwards, down from 10.9s, and the page downloaded 1.3–2 MB instead of 50 MB. Reuse filled the form in 13 ms, down from about 5s.

## 2026-10-11 — Stability and speed fixes

- Fixed a web-process crash: a provider connection reset while proxying a provider-hosted video escaped as an unhandled stream error and terminated `server.js`. The proxy now uses `stream.pipeline`, aborts the provider download when the viewer disconnects, and times out providers that do not answer within `MEDIA_PROXY_HEADER_TIMEOUT_MS` (default 30s). Covered by `test/media_proxy.test.js`.
- Idle browser tabs refresh generation status every 30s instead of every 5s; the 5s cadence applies only while a video, image or voice job is active. A tab returning to the foreground refreshes immediately.
- The image gallery is no longer rebuilt on every poll when nothing changed.
- Gallery videos attach their source only when the card nears the viewport, so hidden Library cards and off-screen videos no longer stream from the database on page load.
- Finished images and database-stored videos are cached by the browser (`private, max-age=31536000, immutable`), so revisiting a gallery does not re-download every file.
- Local measurement with 60 images and 50 videos: one idle tab dropped from 36 to 6 API requests per minute, and opening then revisiting Image Studio dropped from 301 MB to 7.7 MB of media. Under 30 tabs plus 4 gallery visitors on one CPU, API p95 latency fell from 2.05s to 0.28s.

## 2026-10-11 — Professional UI restyle

- Merged the brand header and workspace navigation into one compact sticky bar with underline tabs; on tablet and mobile the tabs move to a second scrollable row that keeps the active tab in view.
- Self-hosted the Inter variable font (SIL OFL) at `/assets/fonts/inter-latin-wght.woff2`; no external font service is used.
- Rebuilt the design tokens around neutral surfaces, near-black headings and a 12–14px minimum text size, with deep blue reserved for primary actions and turquoise for accents.
- Restyled creation panels, gallery cards, status badges, model and ratio pickers, image preview, plans, credits, account, sign-in and the admin console. Markup IDs, handlers and generation logic are unchanged.

## 2026-10-11 — Vercel AI Gateway image and video integration

- Added encrypted Admin API credentials, source and account switches, concurrency and USD credit conversion.
- Seeded 83 official media models, including Gemini multimodal image models, with live catalog/eligibility sync that preserves visibility and Admin prices.
- Added model-specific image quality/resolution, video audio/mode settings, capability validation and separate quotes.
- Added independent image/video queue processing, stable video start idempotency keys and saved operations for restart recovery.
- Added durable MP4 chunks, authenticated Range playback, image output shape checks and idempotent failure refunds.
- Added transport, pricing, ownership and queue tests. Paid end-to-end generation requires a configured gateway key and funding.


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

## 2026-10-06 — Add backend source ON/OFF switches

- Added per-provider enable switches in Admin → Provider.
- Added persisted enable settings for Vidancee, CreatePulse, Atlas Cloud, and vgenv.
- Customer model catalog now removes models whose backend source is disabled.
- Seedance stays visible while at least one enabled/configured Seedance source remains.
- MiniMax H3 disappears when vgenv is disabled.
- Atlas image models disappear when Atlas Cloud is disabled.
- Added server-side submission guards so stale customer pages cannot bypass disabled sources.
- Worker routing now avoids disabled providers for new submissions while continuing to poll already-submitted jobs.
- Health/Admin runtime state now distinguishes configured, enabled, and active providers.

## 2026-10-06 — Higgsfield MCP full catalog integration

- Added the official MCP client package and CommonJS-compatible integration.
- Added OAuth authorization from Admin without storing an account password.
- Persisted OAuth tokens, DCR client information, PKCE verifier, and discovery state in encrypted app settings.
- Added automatic model sync after authorization and a manual Sync models action.
- Added `provider_models` for dynamic image/video model discovery, options, availability, and per-model visibility.
- Added a Higgsfield Admin source card with ON/OFF, connection status, MCP endpoint, max inflight, reconnect, sync, and disconnect controls.
- Added per-model Show/Hide controls.
- Added customer-side dynamic video/image model selectors with model-specific duration, resolution, and aspect-ratio options.
- Added live cost estimation through MCP `get_cost`, followed by the universal 2.5× customer markup.
- Added neutral customer-facing dynamic model IDs so backend provider identity remains hidden.
- Added worker submission and `jobs_wait` polling for both image and video jobs.
- Added source-credit tracking and existing atomic refunds for failed Higgsfield generations.
- Made Higgsfield primary for overlapping synced models while retaining existing sources as fallback when Higgsfield is disabled.
- Added deployment documentation for `APP_URL`, MCP endpoint, provider switch, and initial account authorization.


## 2026-10-06 — Fix Higgsfield live MCP model discovery

- Confirmed the paid account OAuth connection works from the deployed Admin UI.
- Fixed dynamic model discovery when the MCP `model` field is a plain string rather than a JSON-Schema enum.
- Added discovery from schema examples, defaults, descriptions, and model-specific tool names.
- Improved the sync failure message to report the returned MCP tool count.
- Added **Inspect MCP tools** in Admin for sanitized live-schema troubleshooting without exposing OAuth tokens or passwords.


## 2026-10-06 — Remove MCP utility tools from customer model selector

- Fixed incorrect Higgsfield model discovery that surfaced workflow utilities such as Video Analysis Jobs and Virality Predictor as customer models.
- Tightened generation-tool detection and model-family recognition.
- Added customer-side catalog filtering for previously stored bad rows.
- Added automatic quarantine of old utility-tool rows during the next Higgsfield sync.


## 2026-10-06 — Switch Higgsfield sync to models_explore

- Replaced heuristic MCP-tool-as-model discovery with the authoritative `models_explore` image/video catalog.
- Mapped live model durations, duration ranges, resolutions, aspect ratios, media roles, provider labels, and defaults into the dynamic provider catalog.
- Added `catalogVerified` provenance so new Higgsfield model families can appear without static code changes.
- Routed synced image/video models through the generic `generate_image` and `generate_video` MCP tools using their `params` payload contract.
- Added Higgsfield `media_upload` → PUT → `media_confirm` handling for reference images.
- Added model-specific media-role validation before reserving customer credits.
- Added support for nested `cost.credits_exact` pricing and top-level generation job `id`.
- Admin now shows only authoritative/current Higgsfield catalog rows.


## 2026-10-06 — Map Higgsfield generation modes

- Preserved provider-declared model mode options/defaults from `models_explore`.
- Automatically selects `omni_reference` for reference-driven models when supported.
- Automatically selects `t2v` for prompt-only generation when supported.
- Falls back to the provider-declared default mode for other models.


## 2026-10-06 — Fix Hostinger MCP fetch failures

- Preferred IPv4 DNS resolution for Higgsfield MCP traffic on Linux/Hostinger deployments.
- Added bounded retries for transient MCP network failures.
- Added safe cause-chain reporting for persistent MCP network errors.
- Kept OAuth authorization errors separate from network retries.


## 2026-10-06 — Improve Higgsfield MCP transport compatibility

- Added a browser-like User-Agent to all Higgsfield MCP Streamable HTTP requests for Cloudflare/WAF compatibility.
- Kept OAuth and MCP transport headers controlled by the official SDK.
- Added parsing for fenced/annotated JSON returned inside MCP text blocks.
- Improved model-sync errors so Admin shows the real safe failure reason from `models_explore`.


## 2026-10-06 — Add official Higgsfield catalog fallback

- Added a safe fallback catalog sourced from the current official Higgsfield CLI/Skills model IDs when `models_explore` returns no list entries.
- Kept live `generate_image`, `generate_video`, pricing, OAuth, job polling, and media upload through MCP.
- Excluded analysis/background-removal utility job types from the customer generation selectors.
- Added current main image/video families including Seedance 2.5, Seedance 2.0, Kling 3, Veo 3.1, Wan, MiniMax/Hailuo, Grok Video, Cinema Studio, GPT Image, Nano Banana, Seedream, Soul, Flux, Recraft, and Marketing Studio.
- Sync now reports `official-cli-fallback` when the live MCP catalog does not provide a list response.


## 2026-10-06 — Document current Higgsfield production state

- Recorded that OAuth is successfully connected in the live deployment.
- Recorded that the attempted `models_explore` list flow returned no usable full catalog.
- Documented the official CLI/Skills model-catalog fallback as the current model-list source when live discovery is empty.
- Clarified that real generation, cost checks, media uploads, polling, and credit consumption still use the connected Higgsfield MCP account.
- Added the current post-deploy verification sequence and noted that catalog-sync failures do not require OAuth reconnection.


## 2026-10-06 — Add per-model reference capability composer

- Added model-specific image/video reference capabilities to the customer catalog.
- Added capability-aware Create Video and Create Image controls.
- Text-only models now hide reference uploads.
- Added model-specific image/video reference limits and semantic roles.
- Added separate customer upload support for video references.
- Added start-frame/end-frame/reference-image role handling.
- Added client- and server-side validation for required roles, maxima, minima, total limits, and unsupported reference types.
- Added `generation_media` storage for dynamic provider reference files and roles.
- Higgsfield worker now uploads stored reference media and forwards exact provider roles.
- Added compact model capability summaries under customer model selectors.
- Added explicit dynamic-media cleanup when deleting image/video generations.


## 2026-10-06 — Fix dynamic aspect ratio and Higgsfield cost display

- Rebuilt the styled aspect-ratio dropdown whenever a model changes so stale ratio options are not shown.
- Included the current prompt in live Higgsfield cost requests.
- Hardened MCP cost parsing for additional nested/wrapped credit response shapes.
- Accepted zero-credit Higgsfield costs as valid instead of falling back to "at submit".
- Allowed zero-cost dynamic image/video generation records without falling back to static pricing.

## 2026-10-06 — Use Higgsfield provider credits 1:1

- Removed the 2.5× customer markup from Higgsfield-backed models.
- Customer cost display now uses the Higgsfield provider-reported credits directly.
- Submission debit/reservation uses the same value.
- Provider cost remains stored separately for accounting.
- Legitimate 0-credit subscription-covered generations are supported.

## 2026-10-06 — Restyle Admin dashboard

- Reworked Admin UI to match the Mehroz AI customer interface.
- Switched to black/charcoal surfaces with lime accent.
- Improved table density, cards, forms, buttons, responsive layout, source cards, and status switches.
- No Admin business logic was removed.

## 2026-10-06 — Add per-customer provider source assignments

- Added `user_provider_access` persistence.
- Added Admin → Users → Sources controls for Higgsfield, Vidancee, CreatePulse, vgenv/MiniMax, and Atlas Cloud.
- Customer `/api/config` now returns only models backed by sources assigned to that user.
- Added server-side submission enforcement so users cannot bypass assignments with direct API calls.
- Legacy worker routing respects per-user Vidancee/CreatePulse/vgenv access.
- Higgsfield live pricing and generation respect per-user Higgsfield access.
- Existing users default to all sources enabled until explicitly restricted.
- Customer config is refreshed immediately after authentication.

## 2026-10-07 — Add Seedance 2.0 Fast 15-second option

- Added 15-second duration to the Vidancee-backed Seedance 2.0 Fast model.
- Added `PRICE_SEEDANCE_20_FAST_15` override support.
- Kept the existing 10-second option.

## 2026-10-07 — Diagnose Hostinger process recycling

- Added lightweight `GET /live` endpoint that does not depend on MySQL or external AI providers.
- Added runtime diagnostics for SIGTERM, SIGINT, uncaught exceptions, unhandled rejections, uptime, RSS/heap memory, free system memory, and load.
- Production logs confirmed Hostinger was sending `SIGTERM` to the main Node process while the customer site was intermittently unreachable.
- Confirmed `ERR_CONNECTION_TIMED_OUT` also affected `/live`, proving the outage was below individual application/API routes.

## 2026-10-07 — Harden Higgsfield rotating OAuth tokens

- Identified production `invalid_grant` failures caused by reuse of a rotated Higgsfield OAuth refresh token.
- Added MySQL advisory locking around authenticated Higgsfield MCP operations.
- Added safe retry handling for refresh-token rotation races.
- Kept manual Admin reconnect as the recovery path when the stored token is already revoked/expired.

## 2026-10-07 — Split web app and generation worker into separate Hostinger applications

- Removed the production generation worker from the customer-facing Hostinger Node app.
- Main web application now runs with `WORKER_ENABLED=false`.
- Added dedicated `worker.js` entry point and `npm run worker` script.
- Added a lightweight HTTP health server to the standalone worker so Hostinger can supervise it as an independent Node application.
- Worker production domain: `https://worker.mehroz.online`.
- Worker Hostinger entry file: `worker.js`.
- Worker runs with `WORKER_ENABLED=true`.
- Both apps share the same MySQL database and encrypted Admin-managed provider settings.
- Worker `APP_URL` intentionally remains `https://ai.mehroz.online`.
- Production verification confirmed the standalone worker stayed alive for more than 2,000 seconds with the same PID.
- Production verification confirmed a customer generation could be submitted, processed by the standalone worker, completed, and returned to the customer dashboard while the main site remained online.
- This split deployment is now the recommended production architecture.

## 2026-10-07 — Replace AI Tools Flow voice integration with Vibi API

- Removed the unfinished AI Tools Flow provider integration and its session/login automation path.
- Added official Vibi API integration using `xi-api-key` authentication against `https://api.vibi.pro`.
- Added Vibi Admin settings: API key, global ON/OFF, max inflight voice jobs, and configurable customer cost for creating a cloned voice.
- Added Admin connection test using `GET /v1/auth/me`, including provider credit balance.
- Added per-customer Vibi/Voice source assignment.
- Added voice catalog loading from Vibi:
  - ElevenLabs-compatible default voices
  - MiniMax system voices
  - customer-owned cloned voices
  - Vibi model catalog for both voice engines
- Added text-to-speech submission through `POST /v1/text-to-speech/{voice_id}`.
- Added worker polling through `GET /v1/history/{id}` and same-origin audio delivery.
- Voice jobs reserve a conservative customer-credit estimate and reconcile to Vibi's final `credits_deducted` value at completion using the platform's 2.5× customer multiplier.
- Added MiniMax voice cloning through `POST /v1/minimax/voices/clone`.
- Voice samples are queued in MySQL and uploaded by the standalone worker, keeping provider upload work out of the customer-facing web process.
- Added per-user clone ownership so one customer's cloned voices are not exposed to other customers.
- Added cloned-voice status synchronization from `GET /v1/minimax/voices`.
- Added customer Voice Studio controls for provider/model/voice selection, TTS history, audio playback/download, and voice-clone creation.


## 2026-10-07 — CMM Tools studio redesign

- Applied the supplied blue/turquoise logo and app icon across customer and admin UI.
- Rebuilt the customer workspace with a navigation rail, scrollable creation panel, readable gallery and responsive mobile dock.
- Centered model selection in a native modal with independent list scrolling, search and keyboard navigation.
- Added shared styles, explicit asset routes and a complete design/validation note in `docs/CMM_UI_DESIGN.md`.
- Passed existing tests and browser checks with mocked APIs; live deployment verification is separate.

## 2026-10-08 — Horizontal workspace navigation

- Moved the workspace navigation from the side rail to a sticky horizontal row above the workspace, below the logo header.
- Expanded the content to use the released space and adjusted the creation panel to clear both header rows.
- On mobile the same row scrolls horizontally to expose every section; removed the duplicate bottom dock and sidebar plan card.
- Updated the studio stylesheet cache version. No database or environment changes.


## 2026-10-09 - GPT image canvas validation and light preview

- Application revision `d3befea1847dd337a13cdf94c1cce80f7d1305e4` added selected-size canvas instructions and PNG dimension checks. Wrong-shape outputs fail and refund without automatic paid regeneration.
- The same revision retained equal GPT Image 2 and 2.5 credit quotes where SmartAIPI's published rates match.
- Application revision `f7787b414444ef59247d944970fc16b26dafc0d7` replaced the dark image preview with a pale canvas, white details, prompt and metadata, Download image and Reuse prompt actions, and responsive mobile stacking.
- Guarded delayed dialog-close events and restored thumbnail focus.
- Canvas validation recorded 42 automated tests passing. Preview validation recorded seven browser viewport sizes and interaction/error checks with mocked provider APIs.

## 2026-10-11 - Current documentation and downloadable handoff

- Rewrote the main handoff around the deployed CMM Tools application and archived the accumulated milestone handoff separately.
- Updated README, Admin source/settings guidance, plans and billing exceptions, image UI, Hostinger worker diagnostics, Gemini recovery notes and the confirmed image-to-video protocol.
- Documented the SmartAIPI 160-credit square Medium baseline, size-dependent estimates, Admin overrides and source-specific refund boundaries.
- Public read-only checks confirmed the served app revision, connected database, worker revision 4 and recent independent image polling.
- Prepared PDF, editable Word and Markdown documentation for project continuation. No runtime behavior or commercial settings were changed by this documentation update.

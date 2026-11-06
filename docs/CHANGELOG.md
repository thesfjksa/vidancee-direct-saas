## 2026-11-06 — AIVID priced using owner's $0.12 source-credit cost

- Owner confirms **each AIVID source credit costs USD $0.12**. AIVID now shares the existing `src/billing.js` 6,720-CMM-credits/USD conversion: **806.40 base CMM credits per AIVID credit**. Existing customer pricing adds the standard 5% and any boosted rate: **846.72 credits per source credit** for an ordinary customer; 2 source credits = 1,693.44 customer credits. The actual AIVID **Public-mode live quote** determines how many AIVID credits a job consumes.
- Legacy stored Admin values including 480 are **ignored**; there is no separate arbitrary AIVID multiplier. The Admin now displays the derived 806.4 rate read-only like other USD-priced providers. The saved source-credit ceiling and provider enabled switch are not altered. Old completed jobs, reserved wallet amounts, historical debits/refunds and provider-cost units are unchanged.
- Tests cover USD conversion, ordinary/boosted customer rates, legacy rate migration and preflight source-credit quoting. Requires web **and** worker deployment of the current GitHub main, with no paid provider job required to test the arithmetic. This change does not confirm a live generation; source-credit amount must still be verified with AIVID.

## 2026-11-06 — AIVID Premium models, public mode and customer visibility (GitHub source)

- PR [#141](https://github.com/thesfjksa/vidancee-direct-saas/pull/141): AIVID visibility is set to **Public** before reading its source price and independently checked in the outbound request guard.
- PR [#143](https://github.com/thesfjksa/vidancee-direct-saas/pull/143): introduced customer-facing `aivid_seedance_2_0_mini`, `aivid_seedance_2_0` and `aivid_seedance_2_5` Premium models, with Admin per-customer grants, separate AIVID source-credit conversion (default 480 CMM credits per AIVID credit; **owner must confirm economics**), source ceiling, RDP quote and durable guarded generation queue; Windows Agent **v2.1.0** includes the standalone model registry.
- PR [#144](https://github.com/thesfjksa/vidancee-direct-saas/pull/144): keep AIVID price checks off the public pricing examples and warn customers that Public output may be visible upstream.
- PR [#145](https://github.com/thesfjksa/vidancee-direct-saas/pull/145): fix all three AIVID model choices disappearing from the customer's Video Studio when an already-configured source went offline, the source was disabled or source-ceiling was zero. Configured models now remain visible as **Unavailable**; Generate is disabled while not ready. A never-configured AIVID installation is not injected into the catalog. Explicit per-customer source denial still hides the choices.
- PR #143 passed Node, browser, MySQL and Windows agent checks; PR #145 passed Node, MySQL and Windows checks. This is **source-level verification only**. No live Hostinger web/worker deployment, installed v2.1.0 agent, per-model paid generation, or output download has been confirmed. Do not equate AIVID source credits with 888API CNY; preserve all existing users, ledger, job receipts and 888API routes.
- Read [the 6 November operational handoff](PROJECT_HANDOFF_2026-11-06.md) for source-control SHAs, exact model IDs, release/diagnostic procedures and unresolved tests. Older October handoff incidents are historical and may have changed.

## 2026-10-31 — Neutral model branding without a warning banner

- Customer-facing Video Studio label is now **CMM Mini**, not "Seedance 2.0 Mini", because the actual backend is MiniMax H3 Origin Fast. Removed the prominent backend warning for the now-neutral name. Admin metadata and internal documentation keep the real provider and model identity.
- Retained historical internal ID `seedance_2_0_mini` for compatibility, along with source pricing, worker routing, reference support, credit accounting and completed/queued job IDs. No paid provider operation or Hostinger deployment was performed.
- Updated catalog and regression tests. Prior changelog entry below documents the original intermediate alias before this correction.

## 2026-10-31 — Replace 888API Seedance 2.0 Mini with vgenv Origin Fast alias

- Removed `sd_2.0_mini_special` from the 888API customer offer; historical rows are unready at read time without reimport. Existing jobs, charges and refunds are untouched.
- Added Video Studio `seedance_2_0_mini`, displayed as **Seedance 2.0 Mini**, routed to vgenv `origin` + `fast` (`POST /v3/videos`) at the same 480p/768p and 4–15s pricing as MiniMax H3 Origin. Existing Origin and Beast are unchanged. Cartoon Studio excludes the alias.
- The customer-facing warning discloses that the alias uses MiniMax H3 Origin and is **not** genuine ByteDance Seedance. Includes catalog, routing, pricing, and retirement tests. Code only pending separate web/worker deployment; no paid generation or live database mutation.

## 2026-10-30 — Minimax Beast (Origin Quality via vgenv)

- Added **Minimax Beast** as a separate vgenv MiniMax H3 choice (internal ID `minimax_beast`) in Video Studio and Cartoon Studio. It submits `model: origin` and `tier: quality` to vgenv's `/v3/videos`; the existing Base, Cinematic, and Origin entries remain on `fast`.
- Beast uses the vgenv Origin Quality published USD pricing: **$0.0077/s at 480p** and **$0.015/s at 768p**, plus the existing customer price-rate rules. Supports the existing H3 4–15-second range and reference paths. No new vgenv credentials or provider switch.
- Includes unit checks of Beast pricing, request payload, worker tier routing, and legacy Fast behavior. **GitHub code only; do not claim Hostinger deployment or a paid end-to-end video has succeeded until verified.** See `docs/MINIMAX_BEAST.md`.

## 2026-10-29 — Vidancee Omni Flash draft integration

- Draft PR #111 restores the authorized Vidancee website session source for **Omni Flash** in Video Studio, not CreatePulse. Supports both text-to-video and one-image-to-video at **4 / 6 / 8 / 10 seconds** for the owner's confirmed **30 / 40 / 50 / 60 Vidancee source credits** respectively, in 9:16. The owner's image-reference job 26443 completed and its multipart payload (`images[]`, `max_retries=0`) was verified. Includes encrypted Admin credentials, isolated worker queue, durable provider job IDs, no duplicate charged POST, polling, MP4 download, and mocked tests for all four tiers and both modes. **Not yet production-verified**, source off by default; see docs/VIDANCEE_OMNI_FLASH.md.

# Changelog

## 2026-10-29 — Omni Flash (Vidancee) priced at cost

- Omni Flash charged customers one CMM credit per Vidancee credit (30/40/50/60 for 4/6/8/10 s), but Vidancee credits cost $1 per 900, so each clip sold at about 1/7.5 of its cost. It is now sold at cost like every model: 224/299/374/448 credits before the 5% increase (236/314/393/471 after it). `VIDANCEE_CREDITS_PER_USD` in `src/vidancee_models.js`.

## 2026-10-28 — CreatePulse removed again

- Owner request: Omni Flash from CreatePulse (#109) is removed. Its client, queue, Admin card, settings and Sources switch are gone, and CreatePulse is back in the retired-sources cleanup, so any open job on it is refunded. Its only job (28 Oct) was refused by CreatePulse for the $10 minimum balance and refunded.

## 2026-10-26 — Longer prompts on 888API models

- Every 888API model refused prompts over 4,096 characters ("The prompt exceeds this model’s text limit."), e.g. long Seedance 2.5 Realism prompts with several @Image references. 888API states no limit, and 4,096 had no source. The limit is now 20,000 characters, what Seedance 2.5 accepts on Sluice (`API888_PROMPT_CHARS` in `src/prompt_limits.js`). Rows synced earlier still hold 4,096 and get 20,000 without a re-sync. If 888API turns out to cap prompts lower, the job fails at 888API and is refunded as usual.

## 2026-10-25 — GPT image models from fal.ai

- fal bills OpenAI's GPT image models by tokens, so the importer left them off ("bills per units"). `src/fal_images.js` now prices six of them per image from their fal pages, with a Low / Medium / High quality picker (High by default): GPT Image 2, GPT Image 2.5 Flare, GPT Image 2.5 Sunburst, GPT Image 1.5, GPT Image 1 and GPT Image 1 Mini. Each quality is charged at the model's dearest size plus prompt tokens, so no ratio is under-charged. GPT Image 1.x offers its fixed sizes (1:1, 3:2, 2:3). They appear after the next fal.ai sync (worker start, daily, or Admin → **Sync fal.ai image models**).

## 2026-10-25 — 888API on for every customer

- 888API is no longer opt-in per customer: it is on by default like every other source, and switches left off under the old default are cleared once (`api888_access_all_on_at`). The worker runs 888API jobs for every customer whose 888API access is not switched off. The admin can still turn it off for a customer under Sources. The 888API source itself must stay enabled in Admin → Providers (it is).

## 2026-10-25 — Longest video length by default

- Video Studio selects a model's longest video length when the model is picked (e.g. 30 s for Seedance 2.5), and Cartoon Studio does the same when it opens. Changing only the resolution keeps the customer's chosen length when it is still offered.

## 2026-10-25 — 888API charged at cost, like every other source

- Plans are unchanged: Rs 5,000 = 60,000 credits, and every model costs 24 credits per rupee of what CMM Tools pays, so half of every plan is profit. 888API was the exception: it charged ¥1 = 1 credit, i.e. a ¥1 job (about Rs 40 of cost) used Rs 0.08 of credits.
- 888API yuan now convert at ¥7 per USD (slightly above market, so never under-charged): **¥1 = Rs 40 = 960 credits**, rounded up to whole credits per job. E.g. a ¥7 job = 6,720 credits (Rs 560 to the customer, Rs 280 cost). The yuan cost is still recorded with each generation; charges made before this change keep their amounts and refund unchanged.
- Studio badges ("Per request · N cr", "Dynamic · N cr/sec") and Admin show the converted credits; Admin also shows the yuan price. 888API image jobs now record their yuan cost (they recorded an empty USD cost before).

## 2026-10-25 — Wan 3.0 Standard

- 888API's `wan30-720p` is now named **Wan 3.0 Standard** (was "Wan 3.0 720p").

## 2026-10-25 — 888API: Wan 3.0 720p kept too

- `wan30-720p` is offered again as **Wan 3.0 720p** and switched on once. The default-on marker now lists the models it has switched on, so models added to the offer later are switched on once without touching the others.

## 2026-10-25 — 888API: four models only, renamed

- At the owner's request, 888API offers only four models; every other 888API video and image model is hidden ("Not offered on CMM Tools.") through the existing read-time catalog overlay, so no re-import is needed:
  - `seedance-2.5-g5-v2` → **Seedance 2.5 Realism**
  - `seedance2.5-301010-wool` → **Seedance 2.5 Standard**
  - `seedance2.0-933` → **Seedance 2.0 Standard**
  - `wan3.0-video-prime` → **Wan 3.0 Video Prime** (shown when 888API marks it available)
- These four are switched on once (`api888_default_on_models_v2`); a later Admin switch-off is respected. The wider catalog stays in code behind `setApi888OfferAll(true)`, which the catalog tests use.

## 2026-10-25 — Clearer fal.ai image model names

- fal names some models only by endpoint and gives variants one name. Raw names are now made readable ("fal-ai/flux-lora/stream" → "Flux Lora Stream"), variants get the part of their endpoint that differs ("Wan · V2.7 Pro", "Seedream · Flash"), and plain aliases at the same price (`fal-ai/flux/dev` and `fal-ai/flux-1/dev`) are offered once. Applied on the next sync.

## 2026-10-25 — fal.ai image models; MiniMax only from vgenv

- **fal.ai image models (`falimg`):** `src/fal_images.js` imports fal's whole text-to-image catalog: the public Platform API with `expand=openapi-3.0` for each model's request schema, plus `/v1/models/pricing` with the saved fal.ai key. Models are priced from fal's per-image or per-megapixel rate (fal megapixel = 1024², rounded up) at the fal credit rate. Each model's `image_size` presets or custom sizes, or its `aspect_ratio` enum, map to the Image Studio ratio picker. Models that need extra inputs (images, masks, LoRA names), vector output or GPU-second pricing stay off. Sync runs 60 s after the worker starts and daily, or from Admin → Provider → fal.ai → **Sync fal.ai image models**. Jobs run through `FalImageQueue` (fal queue submit, poll, download) and are stored like other images. Customers need the existing fal.ai access switch. Families another source already offers are not duplicated.
- **MiniMax H3:** 888API's MiniMax models (`minimax-h3-*`, `pidoi-h3video-2k`) are no longer offered. MiniMax H3 comes from vgenv, and vgenv access is turned on once for every customer who had it off.

## 2026-10-25 — 888API models take reference images only

- Following the 888API gateway tests (see API888.md), every 888API video model now offers reference **images** only. Video and audio upload controls are gone, labels show image counts only (e.g. "Seedance 2.5 G5 Realistic · 720p · 30 img"), and the server refuses video and audio files for these models. `doubao-seedance-2-0-fast` and `doubao-seedance-2-0`, which require a reference video, are unavailable. Saved catalog rows follow the code at read time, so no re-import is needed.
- The multimodal transport is kept behind `setApi888MediaRefs` / `API888_MEDIA_REFS=on` for when 888API forwards media references; its tests still run with it on.

## 2026-10-25 — Page security policy allows the R2 bucket

- Videos wouldn't play on the website after R2 became storage, and direct reference uploads silently fell back to the slow Hostinger path. The page's Content-Security-Policy allowed media and connections only from `'self'`, so the browser blocked the 302 to the presigned R2 link and the XHR PUT to the bucket. The policy now adds `https://*.r2.cloudflarestorage.com` and the configured S3 endpoint origin (refreshed every 5 minutes) to `media-src`, `connect-src` and `img-src`.

## 2026-10-25 — Incomplete video downloads are rejected and repaired

- A Wan 3.0 result (generation e3e43731) was saved at 261 KB: the download from 888API ended early, and the only check was the `ftyp` header. 888API downloads now have to be a complete MP4 (top-level boxes fill the file, with `moov` and `mdat`), and `readBounded` rejects a body shorter than its Content-Length. An incomplete download fails that poll and is fetched again on the next one.
- Once per worker start, recent 888API videos (last 3 days) are checked in R2. Incomplete ones are fetched again from 888API's finished task (free GET) and replaced. Activity events: `job.video_repaired` / `job.video_repair_failed`.
- Support: `GET /ops/generations/:id/media-check[?deep=1]` reports the bucket object, playback-link responses, MP4 boxes and codecs.

## 2026-10-25 — 888API reference videos actually reach the model

- Owner report: Wan 3.0 (`wan30-720p`) and Seedance 2.5 G5-V2 results ignored the uploaded reference video. Three fixes:
  1. **Field names.** Per 888API's general rule, models whose docs don't name a field take `video_urls` / `audio_urls`. Wan 3.0 (all four), Seedance 2.0 Full/Economy/Pro/Mini, MiniMax H3 2K and Omni Flash were sending `videos` / `audios`, which 888API silently ignores. Documented `videos` / `audios` models (G-series, SS/S2 2.5, 301010 wool, SS 2.0 933, Xin 933) are unchanged.
  2. **Reachable links.** Reference files stored in R2 are now given to 888API as 24-hour presigned bucket links instead of signed links that make 888API download through Hostinger, where large videos could time out.
  3. **Mentions.** `@Image1` / `@Video1` / `@Audio1` in the prompt are sent as 888API's `@图1` / `@视频1` / `@音频1`.

## 2026-10-25 — Reference videos and sound upload straight to R2

- A 16.6 MB reference video failed with "Failed to fetch": uploads through Hostinger run at under 1 MB/s, and long requests are dropped. The browser now uploads reference videos and sound directly to the R2 bucket with 15-minute presigned PUT links (`/api/uploads/presign`, `src/direct_uploads.js`) and shows "Uploading video… 45%". The form sends only the keys. The server checks that each key is in the customer's own `uploads/<user>/` prefix, reads the file, runs the usual trimming and validation, then deletes the temporary object.
- The bucket needs a CORS rule allowing PUT from cmmtools.site. The app adds it automatically when it can. If the token isn't allowed to, Admin → Storage shows the JSON to paste in Cloudflare. Without the rule, or without R2, uploads fall back to the old form upload.

## 2026-10-25 — Reference videos trimmed to the model's limit

- A reference video longer than the selected model accepts is cut to the limit when the customer clicks Generate, instead of failing. A popup then says "Your 40 s video has been trimmed to 30 s". The cut is lossless (`src/mp4_trim.js` rewrites the MP4/MOV sample tables, with no re-encoding and no ffmpeg needed) and keeps the start of the clip. Several clips share the model's total in upload order.
- Limits: 888API Seedance 2.0 models 15 s total (888API docs), Seedance 2.5 and Wan 30 s total; ArgoLink and gateway models from their catalog `max_duration_seconds`; Higgsfield Wan 3.0 30 s total; MiniMax H3 15 s per clip. Prices are computed from the trimmed length.
- Fragmented MP4 files can't be trimmed and still go through each model's existing length checks.

## 2026-10-25 — Images and reference uploads in cloud storage

- Generated images, reference images and reference videos and audio now go to the R2 bucket too. No schema change: the BLOB cell keeps a short tag (`offloadBlob` / `hydrateBlobs` in `src/object_storage.js`), and every reader restores the original bytes. Deletions and rolled-back creations remove their objects. The worker moves old rows over after videos, checking length and MD5. See [CLOUD_STORAGE.md](CLOUD_STORAGE.md).

## 2026-10-25 — Cloudflare R2 (S3-compatible) video storage

- New primary video storage: `src/object_storage.js` (SigV4 client, checked against the AWS reference signatures) and Admin → Storage → **Cloud storage**. Saving the settings tests the bucket. New videos go to `r2:videos/<id>.mp4`, and the worker moves old `db:video` rows over after checking size and MD5. Playback redirects to 1-hour private links, and downloads use `download=1`. See [CLOUD_STORAGE.md](CLOUD_STORAGE.md).
- Google Drive remains as a fallback but is no longer needed. Images, thumbnails, reference uploads and voice samples move in the next phase.

## 2026-10-25 — G5-V2 and Mini Special on by default

- Owner request: `seedance-2.5-g5-v2` and `sd_2.0_mini_special` start enabled without Admin opt-in. `enableDefaultApi888ModelsOnce` (web and worker startup) switches the existing rows on once, guarded by the `api888_default_on_models_v1` marker, so a later Admin switch-off is kept. Catalog re-imports no longer apply the opt-in gate to these two (`DEFAULT_ON_MODELS`). Global 888API switch, customer access and the availability filter still apply.

## 2026-10-25 — 888API model names and image aspect ratios

- 888API models get customer names that state resolution and reference limits, e.g. `Seedance 2.5 G5 Realistic · 720p · 30 img + 10 video + 10 audio`, `MiniMax H3 · 480p · 1–9 img` (image required), `Seedance 2.5 Plus · 480p · Text only`, `GPT Image 2.5 Flare · 4K`. Names come from `NAMES` / `api888Label` in `src/api888_models.js`.
- 888API image models offer 1:1, 16:9 and 9:16 (previously only 1:1, except `gpt-image-2`). Requests now send `size` from the documented gpt-image-2 table: 1K 1024x1024 / 1536x864 / 864x1536, 2K for `gpt-image-2`, 4K for `-4k` models. `gpt-image-2pro` stays 1:1. A wrong-shaped result is still rejected and refunded by `validateCanvas`.
- Names and ratios follow the current code at read time (the existing api888 row overlay now also covers image rows and labels), so no re-import is needed.

## 2026-10-25 — Customers only see 888API models marked "available"

- The worker reads `health_status` from 888API's `GET /v1/models` every 10 minutes and saves a snapshot in `app_settings` (`api888_model_health`). Customer Video and Image Studio hide every 888API model that is not currently `available` (当前可用); `verifying`, `no_recent_success`, `disabled` and models the key doesn't return are hidden. Submissions to a hidden model are refused before any charge.
- Models reappear automatically when 888API marks them available again. Admin switches, per-customer access and prices are unchanged.
- Fails open when there is no snapshot yet or 888API sends no health fields, so the catalog can't be emptied by an upstream change. Worker `/health` shows `api888ModelHealth` counts and the snapshot time.
- **Follow-up:** this key's `/v1/models` carries no `health_status`, so the first deploy hid nothing. The worker now reads 888API's public `GET /api/model-health`, the source of the pricing-page labels, and falls back to `/v1/models`. Snapshot on 25 Oct: 20 of the 39 catalog models are available; 7 are verifying and 12 have no recent success.
- `pidoi-h3video-2k` corrected to ¥2.0: 888API's `/api/pricing` billing formula is a flat `tier("base",(2.0))`. The same data confirms per-second formulas for every "Dynamic" SKU in code, and per-second "seconds" task billing for `wan3.0-video` / `wan3.0-video-prime`.
- Background: `wan3.0-video-prime` and `seedance2.0-pro-480p` failed with 888API `model_not_found` ("no available channel") on 25 Oct; both were refunded.

## 2026-10-25 — 888API prices and contracts re-checked against the model catalog and /docs

Compared all 39 cards in the 888API model catalog (owner screenshots, 25 Oct) and the https://888api.xin/docs model tables with `src/api888_models.js`. All 39 IDs exist in code. Prices follow 1 CNY = 1 credit; **where the catalog card and the docs disagree, the higher price is kept** so no job runs at a loss.

- **Undercharging fixed (provider cost was above our charge):** `seedance2.5-301010-wool` ¥1.7 → **¥7** per video (catalog and docs table agree; the docs' economy-tier paragraph still says ¥1.7 and is stale); `gemini-3-pro-image-preview` ¥0.075 → **¥0.12**; `gemini-3.1-flash-image-preview` ¥0.075 → **¥0.10**; `jimeng-video-seedance-2.0-fast-vip` ¥0.484/s (4–15 s) → **¥4.5 per video, fixed 15 s** (docs confirm).
- **Lowered:** `gpt-image-2` ¥0.075 → ¥0.05 (catalog).
- **Catalog lower than docs, left at the docs price, owner to confirm from the 888API bill:** `seedance2.0-933` (card ¥4.5, docs ¥5), `pidoi-h3video-2k` (¥2 vs ¥2.3), `seedance2.5-480p-plus` (¥0.5/s vs ¥0.6/s), `seedance2.5-720p-plus` (¥0.75/s vs ¥0.9/s), `seedance2.5-1080p-plus` (¥0.9/s vs ¥1.25/s).
- **Newly runnable from documented contracts:** `doubao-seedance-2.0-mini` (¥1.6, 5/10/15 s, 9 images), `ss-2.0-933-720p` (¥1.5, 5–15 s, 9 images / 3 videos / 3 audios), `seedance2.5-301010-wool-1080p` (¥10, 4–30 s, 1080P), `sd_2.0_mini_special` (¥0.15/s, 4–15 s, `duration` field, `image_urls` / `video_urls` / `audio_urls`; audio needs an image or video alongside). `seedance2.5-301010-wool` now also accepts 10 videos + 10 audios and the six documented ratios. Images: `gpt-image-2.5-flare` (¥0.05), `gpt-image-2.5-flare-4k` (¥0.09), `gpt-image-2-1k` (¥0.04). All still need Admin opt-in after re-import.
- **Checked, no change:** the catalog cards claim audio references for the four Wan 3.0 models, but the docs list images (+ videos for `wan3.0-video*`) only, so audio stays off. `jimeng-video-seedance-2.0-fast-vip` keeps the 2-image first/last-frame mode; its `omni_reference` mode (up to 12 mixed references) isn't wired up. `ss-2.5-720p-v1` is ¥5 in the docs vs ¥3.9 in code; it isn't returned by the account key, so it can't be used yet. Fix the price before it ever is. `sd_2.0_mini_special`'s 15 s total limit on reference video/audio length isn't validated locally.
- **Saved prices live in MySQL rows.** After deploying, run Admin → 888API → **Import all accessible models** so the new prices and contracts replace the saved ones.

## 2026-10-25 — 888API source expansion PRs #43–#45, account audit, Seedance G5-V2 multimodal

- **Merged PR [#43](https://github.com/thesfjksa/vidancee-direct-saas/pull/43)** (`ba657667`): expanded priced 888API video adapters, corrected SS 2.5 V1 fixed source cost to ¥3.90, adjusted documented maximum durations/ratio/media references, and added regression tests (**267 passed**).
- **Merged PR [#44](https://github.com/thesfjksa/vidancee-direct-saas/pull/44)** (`adb0ddbee`): implemented 27 more currently account-visible IDs across Sora 2, Grok video, GPT/Gemini images, Seedance 2.0, Doubao and Jimeng. Added provider-family payload builders, price/format tests and an **Admin opt-in gate** disabling newly adapter-supported 888API rows on their first successful live catalog reimport (**276 passed**).
- **Merged PR [#45](https://github.com/thesfjksa/vidancee-direct-saas/pull/45)** (`f82b02c0`): exact-account model `seedance-2.5-g5-v2` added to `VIDEO_IDS`, price/spec tables and reference capabilities, with **¥7 / request = 7 credits**, **720p**, **5–30s**, up to **30 images + 10 videos + 10 audio references**. Mocked request tests cover all three URL arrays, limits, fixed price and paid POST no-retry. Latest GitHub [`main` CI](https://github.com/thesfjksa/vidancee-direct-saas/actions/runs/40170975215) **281 passed, 0 failed**.
- **Owner-observed read-only account audit BEFORE #44/#45 sync:** 64 live IDs vs 115 historical saved IDs (49 stale); **0 missing from MySQL**, 0 wrong availability flags and 0 wrong media type; 27 implemented, 32 priced, 27 ready+enabled (23 video/4 image), 37 unimplemented. Source globally **enabled** per Admin audit, but customer source entitlements and per-model switches remain separate.
- **Seedance entitlement lesson:** `ss-2.5-720p-v1`, `s2-2.5-720p-v3`/`v4`, `dola-seedance-2.5-301010` and `seedance-2.5-G2-V` were not returned to the saved key. G5-V2 **was already imported** and returned by the key but had no runnable adapter until #45. 888API's model-card screenshot supplied the G5 price/capability limits; the **exact G5 video JSON transport is inferred from the documented related G2-V family**, not validated by a paid request.
- **Still unimplemented for the user's prior 64-ID snapshot (9):** `sd_2.0_mini_special`, `minimax-h3`, `gpt-image-2.5-flare-4k`, `doubao-seedance-2.0-mini`, `gpt-image-2-1k`, `seedance2.5-301010-wool-1080p`, `gpt-image-2-plus`, `ss-2.0-933-720p`, `gpt-image-2.5-flare`. Avoid enabling them with unverified pricing/contract.
- **Release boundary:** Code merged, CI successful; **no claimed live Hostinger web/worker deploy, MySQL quota recovery, refreshed model sync, OAuth/Drive migration, or paid 888API G5-V2 generation**. The next operator work is to verify both service revisions and write-safe MySQL, rerun read-only audit, import account models, confirm G5-V2 initially disabled with visible three media pickers, and authorize a single test before general activation.
- Handoff/docs refreshed at [PROJECT_HANDOFF_2026-10-25.md](PROJECT_HANDOFF_2026-10-25.md), [API888.md](API888.md), [HPANEL_DEPLOYMENT.md](HPANEL_DEPLOYMENT.md), [ADMIN_PROVIDER_SETTINGS.md](ADMIN_PROVIDER_SETTINGS.md).



## 2026-10-25 — Exact SS/S2 and Dola Seedance entitlement diagnostics

- Owner reported none of the documented SS 2.5 or Dola 301010 three-input models appear in Video Studio. Current source confirms support for those exact IDs but does not establish the saved 888API key receives them in its account-scoped `GET /v1/models` response.
- Extend Admin **Verify live import (read-only)** with actionable statuses for 4 primary image+video+audio SS/S2/Dola IDs and three alternate documented upstream models: not returned by provider, missing in MySQL, stale flag, disabled, incorrect media type, missing adapter/price, or ready. No paid call, DB mutation or force-enable.
- Clarify V1 `ss-` versus V3/V4 `s2-` and image-only `dola-seedance-2.5` versus three-input `dola-seedance-2.5-301010`. The provider documentation lists model names but does not guarantee every API key can access them.

## 25 October 2026 — Seedance video/audio controls still hidden after initial multimodal merge

The owner reported that even after PR #40, no Seedance model in Video Studio appeared to offer an **Add Video** or **Add Audio** control.

### Confirmed code defect and follow-up fix
- The old client displayed **one combined upload picker**, not distinct audio/video upload actions. \`public/index.html\` now has **Add image**, **Add video**, **Add audio** buttons wired to existing per-type upload handlers and displayed only where \`capabilities.image/video/audio.supported\` is true; combined drag/drop remains.
- **More importantly, persisted \`provider_models.options_json\` is a snapshot.** PR #40 added verified 888API multimodal mapping to code but only Admin → Import all accessible models refreshed the stored model options. Hostinger MySQL was reported quota-locked, so re-import could fail. \`serializeProviderModel()\` now overlays **current audited local input capabilities, media roles, supported operation IDs, aspect ratios, and upload transport field names** for already adapter-supported 888API video models at read time. This avoids any DB writes and affects both customer \`GET /api/config\` and the server/worker's per-model lookup. It preserves DB \`enabled\`, \`available\`, account source entitlement, prices and adapter readiness; it does **not** activate new/unsupported models or perform paid generation.
- The changed code still **must be deployed** to the website and standalone worker; no source edit can correct an old live Hostinger revision. A browser hard refresh reloads the UI, but cannot fix a server still running the old commit.
- **Not all Seedance models accept audio/video:** 888API's official docs explicitly say the low-cost \`seedance2.5-900-wool\` and related Wool variants accept reference images but **not reference videos or audios**, and 2.0 per-second stable/basic variants accept no reference materials. For actual multimedia input use the documented supported Seedance 2.5 models such as \`ss-2.5-720p-v1\` or \`s2-2.5-720p-v3\`/\`v4\`; \`s2-2.5-480p-v2\` supports audio but not video.
- PR #40's HTTP payload, max input counts and price validations remain unchanged. Current reference videos/audio are stored as BLOB inputs in MySQL even if the finished video output is saved on Drive: do **not** encourage uploads while the old production DB is over quota. No paid production generation or live site update was done in this follow-up.
- Source: https://888api.xin/docs.

## 2026-10-25 — 888API model-specific video, audio and aspect-ratio fixes

- Investigated CMM Tools showing only image input for 888API models. Code source advertised only image capabilities and rejected video/audio URL inputs; Video Studio widgets for video/audio already existed but were hidden by catalog metadata.
- Documented models now publish supported upload types/counts; request adapter maps video and audio to the provider's verified field names, including a specific \`metadata.audios\` path. Invalid MIME types, unsupported media, excessive files, unsupported ratios and unsafe reference URL schemes are rejected **before** a paid submission.
- Publish documented aspect-ratio lists (including 21:9/4:3/3:4 and model-specific Wan adaptive and H3 3:2/2:3 options) rather than only the generic three-ratio set. Customer UI shows these in its existing selector and model capability summary.
- Persisted model capabilities in MySQL must be refreshed using Admin → 888API → Import all accessible models **after deploying both apps**; a full/locked database may prevent the sync. Source/tests alone are not proof of live reference generation success, and new reference uploads still store data in MySQL.

## 2026-10-25 — Diagnose 888API model-count discrepancy and add read-only verification

- Investigated Admin screenshot: 115 **historical stored** 888API model IDs, 64 returned in last successful account sync, 31 adapter-supported rows reported by Import, but only 13 ready video + 4 ready image models. These counts are different sets, not evidence that 115 models are callable.
- Current sync retains historical database entries and marks upstream-missing IDs unavailable. Pricing and implemented video/image contracts are strict allowlists, so unverified imports remain Admin-only rather than risking paid API calls. 888API global switch and customer source access must separately be on.
- Added an Admin-only **Verify live import (read-only)** action that compares current \`GET /v1/models\` to saved MySQL rows; returns missing IDs, stale models, media-type mismatches, availability-state mismatches, present adapter/price/ready counts, and clear reasons for unready entries. No catalog updates or paid generations.
- **Verification boundary:** source + mocked tests do not establish live model import parity. The owner must deploy the change and run the new Admin audit while their connected 888API account is accessible. Existing MySQL quota and Hostinger clone problems may block deployment.

## 2026-10-25 — Comprehensive handoff / blocked production recovery (documentation only)

- Created [the authoritative 25 October implementation and recovery handoff](PROJECT_HANDOFF_2026-10-25.md), linked from the original `PROJECT_HANDOFF.md`. It records the complete post-11 October implementation, security and operational evidence, and makes clear which GitHub merges did **not** reach production.
- **P0 database:** Hostinger MySQL `u449234337_saas` at **3,143 / 3,072 MB**. Database permissions UI displayed full grants while a manual video cleanup failed immediately at its first `UPDATE credit_transactions` with **MySQL #1142**, likely quota-triggered DML suspension. **No video rows were confirmed deleted.** Owner reported a complete local SQL export (restore test not verified). Proposed new-database selective import/restore to avoid oversized video chunks; **not executed**.
- **P0 deployment:** Hostinger website build `089d08f` failed at **Cloning repository**; last screenshot-confirmed web deployment was `316e103`. Hostinger GitHub App showed access to All repositories, yet Hostinger clone still failed. Worker deployment revision not confirmed. GitHub remains accessible privately; remote repo itself exists. No source compilation error established.
- **P1 Google Drive:** OAuth web client created in Google Cloud; Client Secret inadvertently revealed in screenshot, **must rotate**. Latest encrypted Admin-managed Client ID/secret UI (#37) is merged but **not deployed**; Drive unconnected, migration paused, 106 MySQL videos / ~1.07 GiB awaiting disposition in the old Admin screenshot. No provider, MySQL or Google Drive mutation was done in the documentation update.
- Incident playbook covers 888API task completion vs local timeout/refund, raw-IP media download diagnostics, safe status queries, refund preservation and source opt-in (see detailed history below and `docs/API888.md`).
- Prior `README.md`, `docs/PLANS.md`, some 11 Oct historical handoff descriptions and `docs/HPANEL_DEPLOYMENT.md` contained dated or stale implementation/deployment expectations; this documentation checkpoint calls out superseding facts.

## 2026-10-24 — Google Drive, MySQL grant mitigation, Admin OAuth credential entry

- **PR #35 / `d6e4046`:** settings/schema probe existing MySQL tables with `SELECT ... LIMIT 0` before attempting `CREATE TABLE IF NOT EXISTS`. Does **not** restore writes suspended by quota or create a missing table without MySQL grants.
- **PR #36 / `316e103`:** Google Drive private video storage and Admin Storage connection flow; resumable chunks, checksum/size verification, protected playback, default for **new** video uploads after consent, background migration of historical `db:video` blobs to Drive with verify-before-delete/transactional MySQL cleanup; customer Drive file deletion handling. **Mock tests, not live connected Drive.**
- **PR #37 / `089d08f`:** Admin → Storage saves Client ID and secret encrypted into shared `app_settings`, OAuth callback + standalone worker read those values, secrets masked, legacy Hostinger env keys optional fallback; OAuth client ID cannot change on an already-connected account. **Build failed at GitHub cloning in Hostinger**.
- Both web and worker still require compatible `SETTINGS_ENCRYPTION_KEY`/encryption root; deployment must be checked separately.

## 2026-10-23–24 — 888API implementation and iterations

- **#20 `afe80a2`:** initial 888API, key settings, catalog, video/image workers, first USD×3.5 billing prototype; **superseded**.
- **#21 `7216707`, #22 `58bdaa1`, #23 `0d7db52`:** empty video selector/provider diagnostics, Seedance activation and wider supported 888API families/inventory.
- **#24 `96e95df`:** final 888API bill in yuan parity (**¥1 = 1 customer credit**); fixed per-request and duration/per-second pricing badges. No generic 3.5× multiplier for 888API.
- **#25 `2425d34`:** safe HTTP 400 error details, MiniMax H3 reference validation.
- **#26 `25214cf`:** oversized 888API 4K GPT image response body handling.
- **#27 `4700bd4`:** fix numeric `seconds` API request type; send seconds as JSON string.
- **#28 `cb4ead3`:** 60-second bounded/idempotent video status GET retry, safe network diagnostics, no ambiguous paid POST retry.
- **#29 `b521e78`:** Admin **Check 888API** read-only task status by saved ID.
- **#30 `00c040e`:** Admin confirmed recovery of completed/upstream yet timed-out/refunded videos; preserve original refund and ledger.
- **#31 `b963eeb`:** authenticated `GET /v1/videos/{id}/content` fallback plus recovery stage details.
- **#32 `d1def9a`:** relative URL/HTTPS canonicalization, SSRF checks and privacy-safe URL diagnostics.
- **#33 `c8c26a8`:** detect persistently unsafe raw-IP/custom-port output and fail/refund rather than hang Processing.
- **#34 `a261c2b`:** 888API explicitly **off by default** with Admin opt-in; constrained public IPv4 download support for returned video media, retaining private/local address restrictions.
- **Observed incident:** a 5-second MiniMax H3 480p T job cost 0.325 credits, timed out/refunded locally while 888API reported **Completed 100%**. Download recovery was **not verified successful**. Owner explicitly declined further recovery and authorized disposable video-history cleanup. See full dated handoff for generation/task IDs and safety guidance.

## 2026-10-20 — Additional merged studio/provider changes

- **#17 `9681f3d`:** Sluice/Seedance Lite provider.
- **#18 `2d184e3`:** Admin plan, credit and generation management.
- **#19 `2be9694`:** automatic audio on video models that support it.
- **#16 `96c4b84`:** Vidancee and CreatePulse retired.

## 2026-10-20 — Vidancee and CreatePulse removed

- **Removed:** Vidancee and CreatePulse (Seedance 2.5 Lite and Seedance 2.0 Fast): their API clients, worker polling and routing, Admin cards, routing policy, settings, customer Sources switches, usage rows and the old Admin test routes. Both had been refusing every job (Vidancee HTTP 403, CreatePulse "minimum $10 balance"). Jobs still open on them are refunded by the worker; finished videos stay in customers' libraries.
- Video Studio: ArgoLink, Higgsfield (Wan 3.0) and MiniMax H3 (vgenv). Cartoon Studio: MiniMax H3 only. ArgoLink's Seedance 2.5 and 2.0 are unchanged.
- Fixed-price jobs now default to vgenv. MiniMax H3 jobs used to be created under `vidancee` and relabelled by the worker; any still queued that way are moved to vgenv instead of being refunded.
- Plan descriptions now quote Wan 3.0 (about 71 or 142 five-second videos) instead of Seedance 2.5 Lite.

## 2026-10-20 — Price preview includes reference video seconds

- A customer reported Seedance 2.5 charging more than the price shown before generating. ArgoLink bills each reference video's length on top of the output (at 0.6x per second), and the charge included it, but the preview never sent the reference videos, so it showed the price without them (19 October: 15 s with 2 reference videos, charged 10,912 credits). Video Studio now reads each reference video's length in the browser and sends it with the price request (`previewVideoSeconds`), so the preview matches the charge. Jobs are still priced from the uploaded files; preview lengths are ignored on submit.

## 2026-10-17 — Wan 3.0 (Higgsfield) reference video fixes

- Three Wan 3.0 jobs on 17 October failed at Higgsfield ("Generation failed", refunded). All three were 30 s videos with a reference video; the 30 s jobs with only images completed. Wan 3.0 counts reference video time against its 30 s output, so a request is now refused before credits are taken when duration + reference video length is over 30 s, with the longest duration it can make.
- Uploads to Higgsfield's storage were refused (HTTP 403) because Content-Type was sent twice in different case, breaking the presigned signature; references then went as the app's signed links. The upload now sends exactly Higgsfield's headers.
- The `higgsfield.request` log entry shows each reference video's length and whether a file went through Higgsfield storage or a signed link.

## 2026-10-17 — MiniMax H3: reference video, and sound references fixed

- Video Studio's MiniMax H3 (vgenv) takes one reference video (MP4, 2–15 s, 25 MB), on its own or with reference images and sound.
- Sound references for MiniMax H3 were rejected by vgenv: 4 jobs on 17 October were refunded with "reference_audios.0.asset_id must match /^asset_…/". vgenv's API (api.vgenv.com/docs-json) takes sound and video only as uploaded Project Assets. The worker now uploads each sound clip and the video to vgenv (`POST /v1/assets/uploads`, PUT, `POST /v1/assets/{id}/complete`) and sends `reference_audios: [{asset_id}]` and `reference_video: {asset_id}`. The asset ids are saved on the job (`provider_operation.vgenvAssets`), so a resend after a restart repeats the same request without uploading again. Logged as `vgenv.assets_uploaded`.
- MiniMax H3 now takes at most 2 sound clips (vgenv's limit, was 3), with a reference image or the reference video. `src/h3_audio.js` is now `src/h3_references.js`.

## 2026-10-17 — One upload box for references in Video Studio

- Video Studio has one **References** upload box instead of separate image, video and sound boxes. It takes every kind the chosen model accepts (the file picker and the help text follow the model), and each file goes to its list below the box: images as thumbnails, videos and sound as rows. Drop a mix of files at once. Limits per kind are listed above the box.

## 2026-10-17 — Wan 3.0 (Higgsfield) for every customer

- On its next start the web app turns Higgsfield on for every customer once: Sources switches left off for Higgsfield are cleared (`higgsfield_access_all_on_at`, logged as `higgsfield_access.all_on`). New customers have it on by default; the admin can still turn it off per customer.

## 2026-10-17 — @ mentions for reference files in prompts

- In Video Studio and Image Studio, every attached reference has a name: @Image1, @Video1, @Audio1, numbered per type in list order (start/end frames have none). Each thumbnail and row shows its name.
- Typing @ in the prompt opens a list of the attached files with thumbnails (arrow keys, Enter or Tab to insert, Esc to close; typing after @ filters by name or file name). Without attachments it explains how to add them.
- Removing, reordering or re-roling a reference renumbers the mentions already in the prompt; mentions of a removed file are taken out. Prompts are sent as written, and the files go to the model in the same order as their numbers.

## 2026-10-17 — Wan 3.0 on the Higgsfield API; Yotta Labs removed

- Video Studio's Wan 3.0 now runs on the Higgsfield API (`hf_wan_3_0`, "Wan 3.0 · up to 30 s"): text, start/end frame, and reference videos with up to 10 images, 5 videos and 5 sound clips; 2–30 s; 480p, 720p and 1080p with the usual HD enhancement (720p rendered at 480p, 1080p at 720p, upscaled by fal.ai). Reference files are uploaded to Higgsfield's storage first. Sold at cost from Higgsfield's own price estimates; the model stays hidden until prices are read (saving the key does that). See `docs/HIGGSFIELD.md`.
- Admin → Provider has a Higgsfield card (key as KEY_ID:KEY_SECRET, switch, max inflight, Check saved key, Sync prices); Users → Sources, Usage & limits and Model names include it. Customer Sources switches left from the earlier Higgsfield connection are cleared once.
- **Removed:** Yotta Labs (Wan 3.0 and Wan 2.7): code, Admin card, settings, customer Sources and usage rows. Its model rows are switched off; any job still open on it is refunded by the worker. ArgoLink's Wan 3.0 and Wan 3.0 Prime are unchanged.
- The worker no longer refunds open `higgsfield` jobs as a retired source (that rule was left from the earlier Higgsfield connection and would have refunded every new job).

## 2026-10-17 — Seedance 2.5 on fal.ai gets reference files from ArgoLink storage

- Every Seedance 2.5 job with reference files that went to fal.ai while ArgoLink was out of credits failed ("Failed to download the file", 6 of 6 since 15 October; prompt-only jobs worked). fal's Seedance could not fetch the app's signed `/provider-media` links, the same problem ArgoLink's Seedance had. The files are now uploaded to ArgoLink's storage first (this works while ArgoLink has no balance) and those links are sent to fal; if the upload fails, the signed links are sent as before. HD enhancement is unchanged.
- `/provider-assets` and `/provider-media` answer HEAD requests (headers, no body); they returned 404 before.

## 2026-10-17 — Sound references for MiniMax H3

- Video Studio's MiniMax H3 (vgenv) takes up to 3 sound clips (MP3 or WAV, 15 MB each, 2–15 s each), sent together with at least one reference image, as MiniMax requires. The rules are checked before credits are taken (`src/h3_audio.js`; WAV lengths are measured, MP3 lengths are left to vgenv). Clips are stored with the job (`generation_media`, kind `audio`, positions after the images) and handed to vgenv as signed `/provider-media` links. Prices are unchanged. Cartoon Studio and the Claude connector do not send sound.
- vgenv's API docs could not be read when this was built. The request field (`reference_audios`, items `{type: "audio_url", audio_url: {url}}`, following vgenv's `reference_images`) is set in one place, `AUDIO_FIELD` in `src/provider/vgenv.js`. Check the first real job with sound in Admin → Activity; if vgenv rejects or ignores the field, change it there.

## 2026-10-15 — Comparison box on both pricing pages

- The public Pricing page and the dashboard Plans page show a small "Compared with other platforms" box: four clips, our live price next to the cheapest other platform listed for that clip, and a link to `/compare`. It stays hidden if prices are unavailable, and an empty comparison is no longer cached.

## 2026-10-15 — Longer prompts

- Prompts can be up to 50,000 characters (`src/prompt_limits.js`) on every model whose provider states no lower limit. Seedance 2.5 and 2.0 on ArgoLink were refused above 8,000 characters ("The prompt exceeds this model's text limit"), and Yotta's Wan above 5,000; those were the app's own defaults, not provider limits. Limits a provider does state still apply (ArgoLink MiniMax H3 7,000, Wan 3.0 20,000). The prompt enhancer still takes up to 8,000 characters.

## 2026-10-15 — Price comparison page

- New public page `/compare` (linked from Pricing and every footer): the same clip's price on CMM Tools and on Pika, Runway, Luma Dream Machine, Freepik, Invideo AI and Higgsfield, in rupees, plus their cheapest plans. CMM Tools prices are live (`/api/compare-prices`, Creator plan credit price); other platforms' list prices, sources and the date checked are in `src/compare_prices.js`. A row is shown only while CMM Tools is cheaper. Update that file when a platform changes its prices.

## 2026-10-15 — Reference videos and sound for Wan 3.0 and Wan 2.7

- Video Studio's Wan 3.0 and Wan 2.7 (Yotta) take reference videos and sound files. Wan 3.0: up to 10 images, 5 videos and 5 sound clips (cite them as @Image1, @Video1, @Audio1), 15 s of video and 15 s of sound in total. Wan 2.7: up to 5 images and videos, and one sound file that drives a text or start-frame video or voices the reference video; 10 s output with a reference video. Uploads accept MP3/WAV (15 MB) and are stored with the job (`generation_media`, kind `audio`). Combinations Yotta does not take are refused before credits are taken. Prices are unchanged. See `docs/YOTTA.md`.

## 2026-10-15 — Wan 2.7 sold at cost

- Wan 2.7 joins Wan 3.0 without profit (`NO_PROFIT_MODELS`): 5 s 720p 924 credits (was 1,241), 1080p 1,045 (was 2,090), exactly Yotta's render + HD upscale cost at the Creator plan's credit price.

## 2026-10-15 — Wan 3.0 sold at cost

- Wan 3.0 (Yotta and ArgoLink) carries no profit: customers pay exactly the render + HD upscale cost at the Creator plan's credit price (Rs 5,000 / 60,000). 5 s: 480p 588 credits (was 724), 720p 709 (was 1,418), 1080p 1,297 (was 2,594) — about 52–65% below Higgsfield. Wan 2.7 and Wan 3.0 Prime are unchanged. `NO_PROFIT_MODELS` in `src/wan_pricing.js`.

## 2026-10-15 — Wan at least 30% below Higgsfield

- Every Wan model (Yotta Wan 3.0 and Wan 2.7, ArgoLink Wan 3.0 and Wan 3.0 Prime) is priced at most 70% of the same clip on Higgsfield (Starter plan credit price), in `src/wan_pricing.js`. 5 s examples: Wan 3.0 480p 724 credits (was 1,176), Wan 2.7 720p 1,241 (was 1,848), ArgoLink Wan 3.0 720p 1,448 (was 1,519); the other resolutions were already more than 30% cheaper. All capped prices stay above cost. See `docs/YOTTA.md`.

## 2026-10-15 — Wan 3.0 and Wan 2.7 on Yotta Labs

- Video Studio lists **Wan 3.0 · up to 30 s** and **Wan 2.7 · up to 15 s** from Yotta Labs' AI Gateway. 480p is rendered natively; 720p and 1080p are rendered lower and upscaled to 1080p by fal.ai (HD enhancement). Wan 3.0 720p is rendered at 480p and 1080p at 720p; Wan 2.7 has no 480p, so its 720p is native and its 1080p comes from 720p. A 5 s Wan 3.0 clip is 1,176 / 1,418 / 2,594 credits at 480p / 720p / 1080p, where native 720p/1080p would cost 2,352 / 4,704. See `docs/YOTTA.md`.
- Admin → Provider has a Yotta Labs card (key, switch, max inflight, Check saved key, Sync live models); Users → Sources has a Yotta Labs switch; Usage & limits and Model names (with HD enhance) include it. Customers never see the Yotta name.

## 2026-10-15 — ArgoLink's Seedance 2.5 off the pricing pages

- ArgoLink's Seedance 2.5 (5 s 720p ≈ 3,179 credits) looked expensive, so the public Pricing page no longer lists it (`PRICING_PAGE_HIDDEN` in server.js), and the plan examples on the Pricing page, the landing page and the dashboard Plans page no longer mention its clips. Seedance 2.5 Lite stays everywhere. Video Studio and Claude still offer ArgoLink's Seedance 2.5.

## 2026-10-14 — Seedance 2.5 renders on fal.ai when ArgoLink is out of credits

- A Seedance 2.5 job in Video Studio that ArgoLink refuses for balance, or fails later for balance, is rendered by Seedance 2.5 on fal.ai. Prompt-only jobs use text-to-video, frame jobs image-to-video and reference jobs reference-to-video. The render then goes through the usual HD enhancement. ArgoLink is marked out of credits for 10 minutes, and Seedance 2.5 jobs go straight to fal during that time. The customer's price does not change; fal costs about 2.5 times ArgoLink's price for the render. Other ArgoLink models are refunded as before. See `docs/ARGOLINK.md`.

## 2026-10-14 — Fixes from a full test pass

- The whole app was tested end to end on a local copy, with MySQL, the web app, the worker and mock providers. That covered every studio in the browser (sign-up, plans, Video, Image, Cartoon, Voice and cloning, Upscaler, Library, Credits, Account, Use with Claude, the Admin tabs) and phone layouts. Fixes:
- The Cartoon Studio failure of 13 October 05:57 (CreatePulse HTTP 502 on submit) was already fixed by the Seedance switch to the other source; it was reproduced and confirmed.
- Lite (Vidancee, CreatePulse) and MiniMax H3 (vgenv) jobs that a source fails after accepting them now show the source's reason: "Generation failed: … Credits were refunded." Before, Lite jobs only said "Generation failed during processing", and MiniMax jobs showed vgenv's raw text without the refund note. Customers see it without vendor names.
- Admin → Generations shows the source's own error message again. It had shown the customer copy with vendor names removed.
- The public Pricing page left out models without generated audio (Wan 3.0 Prime, ArgoLink MiniMax H3), because their example price was asked for with audio on.
- The web app now exits on SIGTERM/SIGINT once requests in progress finish (within 10 s, `WEB_SHUTDOWN_GRACE_MS`), and exits when it cannot open its port. Before, the SIGTERM logging handler kept it running until it was killed, and a failed `listen` left a process that served nothing.

## 2026-10-14 — Public Pricing page

- New page at `/pricing` (no sign-in): the plans, a "What credits buy" table with the credit price of every video and image model at its default settings and how many a Creator plan covers (from the new public `/api/price-examples`, cached 10 minutes), a plan comparison, the FAQ and sign-up. "Pricing" in the home menu opens it; on phones a Pricing button sits next to Start creating.

## 2026-10-13 — Warning on the Lite models

- Seedance 2.5 Lite and Seedance 2.0 Lite show a small red warning under the model picker in Video and Cartoon Studio: "Lite models are having problems right now. Some generations may fail; failed ones are refunded automatically." Claude's list_models includes it as `warning`. Remove it by clearing `LITE_MODEL_WARNING` in server.js.

## 2026-10-13 — No vendor names for customers

- Customers and Claude never see which companies run CMM Tools' models. Page and plan texts no longer name any ("by Gemini", "ByteDance's video upscaler", "ArgoLink Seedance clips" are gone); library cards show model names instead of internal ids; and provider error messages are rewritten before they reach a customer or Claude (`src/vendor_names.js`: job messages, API errors, connector results), e.g. "AI Gateway rejected…" → "The generation service rejected…". Customer prompts are never changed. Admin, the activity log and support access keep the real names.

## 2026-10-13 — Cleaner top bar

- The studio's top bar had ten tabs. It now shows the studios as one segmented control with short names (Video, Image, Cartoon, Voice, Upscale) plus Library. On the right: the credit balance (opens Credits), an **Upgrade** button (opens Plans) and the avatar, which opens an account menu with Account, Plans & pricing, Credits & usage, Use with Claude, WhatsApp support and Sign out (keyboard: arrows, Esc).

## 2026-10-13 — Models at cost, 60,000 credits per Rs 5,000

- Every model now costs the customer exactly what CMM Tools pays for it, in credits: **24 credits per rupee of cost**, USD at Rs 280 (6,720 credits per USD) for ArgoLink, AI Gateway, SmartAIPI and fal.ai; Seedance Lite from Rs 40 per 30 s; MiniMax H3 from vgenv's Fast tier. Prices are rounded up to whole credits. The credits-per-USD boxes in Admin are fixed at 6,720.
- Plans keep 50% whatever is generated: **Creator Rs 5,000 = 60,000 credits** (Rs 2,500 of generation), **Studio Rs 10,000 = 120,000 credits**. E.g. Creator ≈ 18 ArgoLink Seedance 2.5 clips (5 s 720p, 3,180 credits), 62 Seedance 2.5 Lite videos of 30 s (960), or 297 MiniMax H3 videos of 10 s (202).
- Voice (Vibi) keeps its per-character rule until its rupee cost is known. Existing customer balances are not converted.

## 2026-10-13 — New plans and WhatsApp support

- Plans follow the pricing rule (a credit is worth Rs 3): **Creator** Rs 5,000 → 1,667 credits, 3 jobs at once; **Studio** Rs 10,000 → 3,333 credits, priority queue, 5 jobs at once; **Enterprise** custom, its button opens WhatsApp. Basic/Pro/Premium are no longer sold; customers who have them keep their limits.
- A WhatsApp "Chat with us" button (+92 300 0499907) sits at the bottom right of the landing page and the studio.

## 2026-10-13 — CMM Tools video viewer

- Library video cards no longer show the browser's player controls: they show a CMM Tools play badge, play silently while hovered (desktop), and clicking anywhere on the video opens the CMM Tools viewer.
- The viewer has its own controls instead of the browser's: play/pause (also clicking the video), seek bar, time, sound on/off, full screen; keys Space/K, ←/→ (5 s), M, F. The player is sized to the video's own shape.

## 2026-10-13 — Jobs interrupted by a worker restart recover

- A MiniMax H3 job stayed in "submitting" because the worker restarted while sending it. Video jobs left in "submitting" for 5 minutes without a provider job are now queued again on vgenv (its requests carry an idempotency key, so no duplicate) or refunded on Vidancee/CreatePulse (a job may already exist there). Logged as `job.requeued` / `job.submit_interrupted`.

## 2026-10-13 — MiniMax H3 videos play from CMM Tools

- MiniMax H3 videos did not load: vgenv keeps them in Alibaba Cloud storage in Shanghai and the site streamed them from there on every play, which took over 10 s and failed (502). The worker now downloads each finished vgenv video once (in the background, two at a time, retried after 10 minutes on failure) and keeps it with the job like ArgoLink videos; existing vgenv videos are copied the same way. Logged as `video.stored` / `video.store_failed`.
- vgenv's links expire 24 hours after a video finishes, so the copy matters. From Hostinger, `fetch()` to that storage fails ("fetch failed"), so the worker retries over plain HTTPS/IPv4 and logs the network cause. Until a video is copied, the player loads vgenv's signed link directly in the browser (redirect; `media-src` allows `*.aliyuncs.com`).

## 2026-10-13 — CMM Tools dialogs

- The browser's confirm/alert boxes in the studio (delete video, image or audio, request a plan, disconnect a Claude app, error messages) are replaced by a CMM Tools dialog: logo, title, message, Cancel and a navy (or red, for deletes) action button; Esc cancels, focus stays inside, works on phones.

## 2026-10-13 — MiniMax H3 at cost + 70%

- MiniMax H3 (vgenv) is now priced at its real cost + 70% profit (×1.7 instead of ×2.5): 768p 0.476 credits/s (10 s = 4.76, was 7), 480p 0.238 credits/s (10 s = 2.38, was 3.5). Other models keep ×2.5.

## 2026-10-13 — Fixed video prices come only from the calculation

- `PRICE_SEEDANCE_*`, `SOURCE_MINIMAX_H3_*`, `PRICE_IMAGE_*` and `CUSTOMER_CREDIT_MULTIPLIER` are no longer read; old values left in hPanel had kept the previous Seedance prices live. Prices are the real source cost in credits (Rs 3 each; USD at Rs 280) × 2.5.
- MiniMax H3 now follows the same calculation from vgenv's Fast tier ($0.0015/s 480p, $0.003/s 768p): 0.35 credits/s at 480p (was 0.375) and 0.7 credits/s at 768p (was 0.75), e.g. 10 s 768p = 7 credits.

## 2026-10-13 — Seedance Lite prices from the real source cost

- Vidancee and CreatePulse charge about Rs 40 for 30 s of Seedance 2.5. At Rs 3 per credit and the 2.5× multiplier, Seedance 2.5 is now 11.11 credits for 10 s (was 15), 16.67 for 15 s (was 22.5) and 33.33 for 30 s (was 35). Seedance 2.0 Fast keeps its 5:6 ratio: 9.26 for 10 s (was 12.5), 13.89 for 15 s (was 18.75). Applies to Video and Cartoon Studio; `PRICE_SEEDANCE_*` still override.

## 2026-10-13 — AI Gateway errors keep Vercel's reason

- Recraft V4 has failed since 05:25 UTC because Vercel AI Gateway answers HTTP 401 (the saved key is refused); it last worked at 05:02. Failures now record Vercel's own message in the activity log (`providerMessage`), and Admin → Provider → Vercel **Check** shows it.

## 2026-10-13 — Seedance moves to the other source when one fails

- Two Seedance 2.5 jobs (05:57 Cartoon Studio, 11:46 Video Studio) failed because CreatePulse answered HTTP 502 when they were submitted; credits were refunded. The worker only switched to Vidancee when a source was out of credits, and only for Cartoon Studio. Now any Seedance job (Video or Cartoon Studio) that Vidancee or CreatePulse refuses for any reason is sent to the other source in the same pass; only out-of-credits errors pause a source for 10 minutes. The switch is logged as `job.submitted` with the first source's error.

## 2026-10-13 — MiniMax H3 renders the resolution that was paid for

- The worker never passed the resolution to vgenv, so 480p MiniMax H3 orders were rendered (and billed by vgenv) at 768p. It now sends 480p or 768p as chosen. Checked against vgenv's price list (Fast tier, the one the app uses): $0.0015/s at 480p and $0.003/s at 768p; the app charges 0.375 and 0.75 credits per second (2.5× the configured source rate).

## 2026-10-13 — HD enhance on/off per ArgoLink video model

- Admin → Provider → **Model names**: each ArgoLink video model has an **HD enhance** box (on by default), saved with the names. Off: Video Studio offers the model's own resolutions (for example 480p, 720p, 1080p), renders exactly that resolution with no fal.ai upscale, and charges ArgoLink's render price only. On: 720p/1080p are rendered lower and upscaled to 1080p as before. Stored in the `argolink_hd_off_models` setting; changes are logged as `argolink.hd_enhance`.

## 2026-10-13 — MiniMax H3 (vgenv) in Video Studio

- Video Studio also lists MiniMax H3 on vgenv ("MiniMax H3 · up to 15 s", 480p or 768p, 4–15 s, up to 6 reference images) at the Cartoon Studio prices. It stays in Cartoon Studio too.

## 2026-10-13 — Seedance on Vidancee/CreatePulse in Video Studio; model names

- Video Studio now also lists Seedance 2.5 and Seedance 2.0 Fast on Vidancee/CreatePulse (shown as "Seedance 2.5 · up to 30 s" and "Seedance 2.0 Fast · up to 15 s") beside ArgoLink's models, with the fixed per-duration prices Cartoon Studio uses, up to 6 reference images and every aspect ratio. The worker picks Vidancee or CreatePulse as it does for Cartoon Studio. They appear in Claude's list_models too. MiniMax H3 stays in Cartoon Studio.
- **Admin → Provider → Model names**: shows each model's API vendor (ArgoLink, Vercel AI Gateway, SmartAIPI, Vidancee / CreatePulse, vgenv) with a vendor filter, and sets the name customers see for any Video, Image or Cartoon studio model (also used in Claude). Names are per studio; an empty box goes back to the source's name. Stored in the `model_display_names` setting; saves are logged as `model_names.saved`.

## 2026-10-13 — Every studio on by default

- Voice Studio is now on for every customer by default, like the other studios. Admin **Users → Sources** still turns any source off per customer. Voice used to be opt-in, so saving a customer's Sources stored "Voice off" unless it was ticked; the first start of this release clears those once (activity log `voice_access.default_on` with the count). Voice still needs the Vibi source active in Admin → Provider.

## 2026-10-13 — Landing page

- Visitors who aren't signed in now see a landing page at `/` (`public/landing.html`): hero with an animated studio preview and SVG characters, the models, the studios, how it works, HD quality, live plans from `/api/config`, FAQ and sign-up. Animations are CSS only and stop for visitors who prefer reduced motion. Signed-in customers (with a `cmm_session` cookie) still open the studio at `/`; the studio is also at `/app`, and `/app?signup=1` opens Create account.

## 2026-10-13 — Images and videos show in the Claude chat

- The Claude connector now shows a CMM Tools card in the chat (MCP App): progress while the job runs, then the image or a video player with a Download button. It refreshes itself, and older cards for the same job step aside for the newest. Claude also receives a small copy of finished images. Details in `docs/CLAUDE_CONNECTOR.md`.

## 2026-10-13 — Fresh workers are no longer stopped mid-job

- An image made from Claude failed with "Generation was interrupted": Hostinger stopped a newly started worker 8 seconds after it started, while it was generating. The same start-then-stop pattern (4–8 s) appears throughout the log. The worker opened its health port only after database setup and the model catalog download, and claimed jobs before that, so Hostinger treated it as a failed start. The health port now opens first (answering `starting: true` until ready); worker health is revision 6 and the stop log line includes the pid and uptime.
- Every Claude connector tool call is logged (`mcp.call`) with what Claude was told.

## 2026-10-13 — Add to Claude button

- Verified with a real Claude account: the connector signed in and Claude read the account and models through it.
- **Add to Claude** button on the Use with Claude page opens Claude's Add custom connector dialog with CMM Tools filled in. The steps now say CMM Tools isn't in Claude's connector search.
- The server reports a description, website and square icon in `serverInfo`. Claude itself shows custom connectors with a generic icon.

## 2026-10-13 — CMM Tools in Claude (MCP connector)

- Customers can add CMM Tools to Claude as a custom connector (`https://cmmtools.site/mcp`), sign in with their CMM Tools account and create videos, images and upscales from chat with their own credits. Tools: get_account, list_models, estimate_cost, create_video, create_image, get_job (waits up to 50 s, 7-day download link), list_jobs, upscale_video, request_image_upload, list_uploads. Jobs go through the same functions as the website (now shared: `submitVideoGeneration`, `submitImageGeneration`, `submitUpscale`, `quoteModelForUser`, `customerMediaCatalog`).
- OAuth 2.1 sign-in with Claude's client metadata documents or dynamic registration, PKCE, consent page, rotating refresh tokens; supports both MCP protocol eras (2025 handshake and 2026-07-28 stateless).
- New **Use with Claude** page for customers (URL, steps, connected apps, Disconnect) and **Admin → Provider → Claude connector** switch. Details in `docs/CLAUDE_CONNECTOR.md`.

## 2026-10-13 — Video preview

- Finished videos have a zoom button (top-right of the card, as on Image Studio) that opens a preview at the video's own shape, with aspect ratio, dimensions, duration, credits, prompt, Download and Reuse prompt. Works in Video Studio, Cartoon Studio, the Upscaler and the Library.
- Browser fullscreen on a card video no longer crops it: the cards' `object-fit: cover` applied in fullscreen too, so a 9:16 video filled a landscape screen with its top and bottom cut off. Fullscreen now shows the whole frame.

## 2026-10-12 — Video jobs wake the worker

- Hostinger stops the idle worker app. The video list the browser polls (`GET /api/generations`) did not wake it (the image list and single-job routes did), so a video job stalled until another job was created; a Seedance 2.5 job sat 17 minutes after ArgoLink had finished. The video list now wakes the worker while a job is running, and the web app also wakes it every minute while any job is queued or running, so jobs finish after the customer closes the tab.

## 2026-10-12 — Seedance references go through ArgoLink storage

- Seedance 2.5 failed every job with our signed reference links, while the same image and settings worked in ArgoLink's Playground, which uploads files to ArgoLink's storage first. Seedance reference files (images, videos, audio) are now uploaded with `POST /v1/media/uploads` and sent as `media_url`; the signed links remain the fallback. Logged as `argolink.upload` / `argolink.upload_failed`. Storage-link signatures (`X-Amz-*`) are masked in the activity log.
- The one retry of a retryable failure again repeats the same request (the 720p step-up was reverted: 480p works on Seedance 2.5).

## 2026-10-12 — One worker acts on a job at a time

- The activity log showed every ArgoLink status read twice and each retry sent twice (two worker processes polled the same job; only job pickup was locked). Polling, retries and the HD-enhancement step now hold a per-job MySQL lock (`GET_LOCK('cmm_job_<id>')`) and work on a fresh copy of the job row, so a second worker skips the job.
- Seedance 2.5 failures (`generation_failed`, retryable) on a valid request with a 1122×1402 PNG reference; the same request succeeds on Seedance 2.0 Mini.

## 2026-10-12 — Activity log and support access

- New `activity_log`: every customer action, job, provider request and reply (including ArgoLink's full error object), retry, upscale, refund and Admin change, with secrets masked. Admin → **Activity** tab with filters and live refresh. A revocable read-only **support key** opens `/ops/activity`, `/ops/generations` and `/ops/health` (emails masked) so problems can be investigated without Admin access. Details in `docs/ACTIVITY_LOG.md`.

## 2026-10-12 — ArgoLink retries safe failures once

- When ArgoLink fails a video and marks the failure `retryable` (nothing consumed, safe to resend), the worker resubmits the same request once before refunding. Every ArgoLink failure is logged with its code and request id. A customer reported "The result could not be generated." (a generic ArgoLink render failure, not the fal upscale); such jobs now get one more attempt when ArgoLink allows it.

## 2026-10-12 — HD enhancement delivers 1080p for both resolutions

- With fal configured, Video Studio's 720p renders at 480p and 1080p at 720p, and both are upscaled to 1080p with fal's default settings (`target_resolution: 1080p`, general preset, high fidelity, fal's frame rate). This replaces the earlier ×1.5 to 720p, which produced 1296×744 output with damaged text. Prices: 480p or 720p render + $0.0072/s upscale.

## 2026-10-12 — 720p rendered natively again

- The first HD-enhanced 720p video (rendered at 480p, upscaled ×1.5) came back at 1296×744 with mangled small text and waxy textures. 720p is now always rendered natively by ArgoLink (its native price). 1080p is still a 720p render upscaled by fal, now with `target_resolution: 1080p` (an exact 1080p frame), the `general` preset and `fidelity: high`, the mildest enhancement. Not yet checked on a paid 1080p job.

## 2026-10-12 — fal.ai upscaling; ArgoLink 720p/1080p with HD enhancement

- **WaveSpeed removed.** The Upscaler tab now runs the ByteDance Video Upscaler on fal.ai (same prices: $0.0072 / $0.0144 / $0.0288 per second for 1080p / 2K / 4K). Prices come from the server (`POST /api/upscales/quote`), and a video already at the chosen size is refused. Admin card: **Upscaler + HD enhancement · fal.ai**; customer Sources: **fal.ai**. Kandinsky 6.0 VSR was considered and left out on request.
- **ArgoLink video models offer 720p and 1080p only.** 720p renders at 480p and 1080p at 720p, then fal upscales (×1.5, `aigc` preset, 24 fps). MiniMax H3 renders 768p (720p as is, 1080p upscaled). The price is the lower render plus the upscale, e.g. Seedance 2.0 5 s 720p = 1,818 credits instead of 3,321. If the upscale cannot run, the render is delivered and the upscale credits are refunded. Without a fal key, 720p is rendered natively and 1080p is offered only where ArgoLink renders it.
- Not verified with paid fal requests. Details in `docs/FAL_UPSCALER.md`.

## 2026-10-12 — Video Upscaler (WaveSpeed)

- New **Upscaler** tab: upscale a finished video (or an uploaded MP4/MOV up to 25 MB) to 1080p, 2K or 4K with ByteDance Video Upscaler on WaveSpeedAI. Every finished video card has an **Upscale** button. Priced per source second ($0.0072 / $0.0144 / $0.0288, at most 600 s) times the WaveSpeed credits-per-USD rate.
- Admin: **Upscaler · WaveSpeed** card (key, switch, max inflight, credits per USD, balance check), WaveSpeed in customer Sources and in Usage & limits. Details in `docs/WAVESPEED_UPSCALER.md`.
- Not verified with a paid WaveSpeed request.

## 2026-10-12 — One set of sources per studio

- **Video Studio:** ArgoLink only (Seedance 2.5/2.0/Fast/Mini, Wan 3.0/Prime, Grok Video 1.5, MiniMax H3). AI Gateway video models are no longer offered; earlier gateway videos still play.
- **Image Studio:** Vercel AI Gateway and SmartAIPI first. When one returns an out-of-credits error (HTTP 402, "insufficient credits"), it is marked for 10 minutes: the job moves to the same model on ArgoLink at the price the customer already paid, new requests go straight to ArgoLink, and the page lists ArgoLink's copy instead. Models with no ArgoLink copy (FLUX, Seedream, Recraft...) are refunded as before. Names are matched by model family, so "Nano Banana Pro (Gemini 3 Pro Image)" matches ArgoLink's "Nano Banana Pro". ArgoLink-only models are always listed.
- **Cartoon Studio:** Vidancee and CreatePulse (Seedance) plus vgenv (MiniMax H3, moved here from Video Studio).
- **Voice Studio:** Vibi. **Prompt enhancer:** Gemini 3.8 Flash.
- **Removed:** Atlas Cloud and Higgsfield (code, Admin cards, settings, customer Sources and usage rows). Jobs still open on them are refunded by the worker. Admin cards are now titled by studio.

## 2026-10-12 — cmmtools.site is the main domain

- `ai.mehroz.online` no longer serves HTTPS, so every link the app gives out now uses `https://cmmtools.site`, even if `APP_URL` still holds the old address: signed reference-image links for providers (CreatePulse, Vidancee, Atlas, AI Gateway, ArgoLink, Higgsfield) and the Higgsfield OAuth return address (a saved old-domain callback is rewritten).
- `/` and `/admin-console` on `ai.mehroz.online` redirect (301) to cmmtools.site without any setting; `CANONICAL_URL` still overrides. API calls, provider links and health checks are not redirected.
- The worker stays at `worker.mehroz.online` (`worker.cmmtools.site` has no DNS record).
- README, `.env.example`, hPanel, handoff, design and SmartAIPI docs now name cmmtools.site. The archived handoff keeps its history.

## 2026-10-12 — ArgoLink source

- New image + video source ArgoLink (argolink.io), set up in Admin → Provider with its own key, switch, max inflight and credits-per-USD rate, plus per-customer access in Sources. 17 models: GPT Image 2 / 2.5 Flare / 2.5 Sunburst, Grok Imagine Image / 2.0, Nano Banana 2 / 2 Lite / 2.1 / Pro, Seedance 2.5 / 2.0 / 2.0 Fast / 2.0 Mini, Grok Imagine Video 1.5, MiniMax H3, Wan 3.0 / 3.0 Prime. Prices come from ArgoLink's public catalog (bundled snapshot, refreshed by **Sync live models**). Reference video seconds are added to the price as ArgoLink bills them. Admin lists the models with their USD prices and a Hide/Show switch; the wallet balance appears in Usage & limits. Details in `docs/ARGOLINK.md`.
- Models with the same name from an existing source (SmartAIPI, MiniMax/vgenv) keep that source; ArgoLink's copy comes before the AI Gateway's.
- Video models now open on their default duration (5 s) instead of the shortest one.
- Not verified with a paid ArgoLink request.

## 2026-10-12 — Ready for cmmtools.site

- `cmmtools.site` and `www.cmmtools.site` are recognised production hosts for waking the worker. New optional `CANONICAL_URL` setting: the old domain's `/` and `/admin-console` redirect (301) to the same page on the new domain; provider image links, API calls, OAuth callbacks, `/health` and `/live` are not redirected. Steps are in `docs/HPANEL_DEPLOYMENT.md` ("Moving to a new domain"). Nothing changes until the settings are made in hPanel.

## 2026-10-12 — AI Gateway Seedance 2.x priced from video tokens

- Seedance 2.5, 2.0, 2.0 Fast and 2.0 Mini on the AI Gateway are billed by video tokens and stayed hidden without an Admin price. They are now quoted from the catalog's token rates using ByteDance's count of width x height x fps / 1024 tokens per second (720p 16:9 at 24 fps = 21,600 tokens/s). Without video input the output is billed at the higher rate; with reference videos, input and output tokens are billed at the reduced rate, and each clip's length is read from its MP4 header (the longest allowed clip is assumed if it cannot be read). Quotes are marked as estimates because minimum token floors are not published. Examples: Seedance 2.5 10 s 720p 16:9 = 2.31 USD; Seedance 2.0 Fast 10 s 720p = 1.21 USD. An Admin per-second price still overrides.
- Not verified against a paid gateway request.

## 2026-10-12 — FLUX 3 aspect ratios

- FLUX 3 (AI Gateway) was limited to 1:1 because the catalog prices it by five square sizes. It now offers 1:1, 16:9, 9:16, 4:3, 3:4, 3:2 and 2:3. The five sizes are treated as resolution classes: a non-square image keeps the class's pixel count (rounded to 16 px, long side at most 4096) and its price, for example 16:9 at 1K = 1360x768 for 0.024 USD. The Resolution list shows the classes as 768 px, 1K, 1.5K, 2K and 4K. Rows from an earlier catalog sync get the shapes without a re-sync.
- Not confirmed with a paid request: the catalog does not say FLUX 3 accepts non-square sizes. If the gateway rejects them, remove the shapes from `FLUX3_SHAPES` in `src/vercel_models.js`; customers are refunded automatically for failed jobs.

## 2026-10-12 — Model picker closed itself on phones

- Every picker closed on any window resize. Opening the model picker focused its search box, which raises the phone keyboard; the keyboard resizes the window, so the picker closed immediately (also when the address bar hid). Reproduced by tapping the picker and then shrinking the viewport: the old code closed all three model pickers, the new code keeps them open. Resizing now only re-places small dropdowns, and on touch screens the search box is no longer focused automatically (tap it to type), so the keyboard does not cover the list.

## 2026-10-12 — Dropdowns on short phone screens

- Checked every picker (video/image/cartoon model, aspect ratio, duration, resolution, quality, image size) at 390x844 and 360x640 with the live model list. Model and aspect-ratio pickers were fine. Small dropdowns chose their direction from the form panel's edges, but on phones the panel is taller than the screen, so a field near the bottom opened its list below the visible area (Video Studio duration, Cartoon Studio model at 360x640). The direction now uses the panel and the visible screen together, the list height is capped to the available room (it scrolls inside), and if there is no room either way the field is scrolled to the middle first.

## 2026-10-12 — One MiniMax H3 in Video Studio

- The AI Gateway's MiniMax H3 is hidden while the direct MiniMax (vgenv) source offers MiniMax H3 to the customer, the same one-entry-per-name rule used for GPT images. It appears again when the direct source is off or unassigned.

## 2026-10-12 — Seedance only in Cartoon Studio

- Video Studio no longer lists Seedance 2.5 and Seedance 2.0 Fast from Vidancee/CreatePulse; those sources are used through Cartoon Studio. A video request for them without a cartoon style is refused with "Seedance is available in Cartoon Studio." Seedance models from other sources (Higgsfield, AI Gateway) are unaffected. Existing Seedance videos stay in the gallery.

## 2026-10-12 — Provider usage and a compact SmartAIPI card

- Admin → Provider starts with **Usage & limits**: per provider, the remaining balance where one is reported, plus last-24-hour jobs, 30-day completed/failed jobs, 30-day provider cost (as recorded on each job) and customer credits, and jobs in progress (`GET /admin/provider-usage`, `src/provider_usage.js`).
- Balances: Vidancee from its jobs feed (credits minus reserved), saved by the worker at most once a minute so Admin never logs in a second time; Vercel from `/v1/credits`; SmartAIPI from the OpenAI-compatible `/dashboard/billing` routes if it offers them (otherwise "not reported"). CreatePulse, MiniMax, Atlas Cloud, Higgsfield and Vibi have no balance route in this integration, so they show consumption only. A source skipped by Cartoon Studio for lack of credits is flagged with the time it will be tried again.
- The SmartAIPI per-model price editor is folded into a closed "Model prices" section with one compact row per model; floating-point noise (0.10549999999999998) is rounded for display. Saved prices are unchanged.

## 2026-10-12 — Cartoon Studio

- New customer tab for cartoon videos. The customer picks a style (3D Animation, Anime, 2D Cartoon, Claymation or Comic), describes the scene, optionally adds one character image and chooses Seedance 2.5 or 2.0 Fast, duration and ratio. Prices are the normal Seedance prices. The tab appears when Vidancee or CreatePulse is active for the customer.
- The customer's prompt is stored as written; `src/cartoon.js` adds the style direction only when the job is sent to the provider. The job keeps `studio: "cartoon"` and the style in `generation_options`. Cartoon jobs show in Cartoon Studio and the Library, not in the Video Studio gallery; Reuse prompt returns to Cartoon Studio.
- Cartoon jobs run only on Vidancee or CreatePulse, whichever has provider credits. Each worker pass reads Vidancee's balance (credits minus reserved); Vidancee is used only if it covers the job (about 0.6 credits per second, from observed charges), otherwise CreatePulse. If a source rejects a job for lack of credits it is skipped for 10 minutes and the job is sent to the other source instead of being refunded. CreatePulse has no balance endpoint, so it is detected only by such a rejection. If both are out, the job waits in the queue. Video Studio routing is unchanged.
- Not verified with paid provider requests from this environment; the out-of-credits detection matches common wording (insufficient, not enough credits, balance, 402).

## 2026-10-12 — Gallery order

- Galleries used CSS columns, which fill each column top to bottom, so new items appeared down the first column. They now use a grid that fills row by row, newest first from left to right. Cards in a row align to their top; a short card leaves space below it.
- A completed image whose model is no longer offered to the account showed the raw ID (for example `gpt_image_2_5_flare_studio`). It now shows a readable name (GPT Image 2.5 Flare).

## 2026-10-12 — Faster Admin console

- The console loaded in a chain: the page, then two stylesheets, then the stats (to check the token), then the same stats again, then the config. Each step costs about a second from Pakistan; the server itself answers in about 0.25s. The login check's stats are now reused, stats and config load together, and the server inlines `brand.css` and `admin.css` into the admin page at startup, so the page renders after one request.
- The header logo was a 1200x408, 200 KB PNG shown about 135 px wide. Admin and the customer dashboard now use `assets/cmmtools-logo-sm.png` (360 px, 6 KB). The original file is kept.

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

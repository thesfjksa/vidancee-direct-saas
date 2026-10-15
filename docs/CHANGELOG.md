# Changelog

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

# CMM Tools Web App Documentation

Updated 11 October 2026. Operational handoff for the project owner and the next developer.

CMM Tools is a deployed, multi-user application for video generation, image generation and voice tools. Customers use the CMM Tools dashboard; the application manages provider access, generation queues and customer credits on the server. This document describes the current implementation, deployment and operating procedures.

## 1 Current checkpoint

| Item | Current value |
| --- | --- |
| Customer application | https://cmmtools.site |
| Private admin interface | https://cmmtools.site/admin-console |
| Generation worker | https://worker.mehroz.online |
| GitHub repository | https://github.com/thesfjksa/vidancee-direct-saas |
| Application branch | main |
| Application revision | Vercel AI Gateway integration, based on main 701f13b; use the current Git commit for the exact deployment revision |
| Runtime | Node.js 20 or later, CommonJS |
| Persistence | Shared MySQL database |
| Hosting | Two Hostinger Node.js applications |

The customer web application and generation worker are deployed separately. The customer application runs `server.js` with `WORKER_ENABLED=false`. The worker runs `worker.js` with `WORKER_ENABLED=true`. Both use the same database and encryption settings.

The application is beyond the initial connector milestones. Customer accounts, persistent queues, credit accounting, plans, provider controls and generation workspaces already exist. The previous accumulated milestone handoff is retained in `docs/archive/PROJECT_HANDOFF_2026-10-09.md`; use that file for history rather than current operating instructions.

### Continuing this project in another chat

Provide this handoff and access to the repository. Use this instruction:

> Continue the existing CMM Tools app in thesfjksa/vidancee-direct-saas. Read the current main branch before editing. Preserve the separate Hostinger web and worker applications, existing customer accounts, credit ledger and Admin-managed credentials. Use this handoff as the current checkpoint and the archived handoff only as history. Verify any changed deployment or provider assumptions before acting.

The reviewed revision identifies the application code behind this documentation. Always use the current branch head when continuing this integration. Recheck the branch and any pending local changes before publishing a future update.

## 2 Customer workspaces

Video Studio lists ArgoLink's video models and Seedance 2.5 / 2.0 Fast on Vidancee or CreatePulse (fixed per-duration prices; the worker picks the source) and MiniMax H3 on vgenv. Admin → Provider → Model names sets the name customers see for any model, per studio.

Signed-out visitors see the landing page (`public/landing.html`) at `/`; the studio is at `/app` and also at `/` for anyone with a session cookie. `/app?signup=1` opens Create account. The landing page shows the live plans from `/api/config`.

The customer interface uses the supplied CMM Tools logo and icon, light surfaces, deep-blue headings and turquoise accents. Workspace navigation is a sticky horizontal row beneath the header. It scrolls horizontally on narrow screens; there is no workspace sidebar column. Long generation histories remain reachable through normal page scrolling.

### Use with Claude

Customers can connect Claude to their account (`https://cmmtools.site/mcp`) and create videos, images and upscales from chat with their own credits. The page shows the URL, setup steps and connected apps with Disconnect. See `docs/CLAUDE_CONNECTOR.md`.

### Video Studio

The video composer accepts a prompt and model-specific settings. Adding image references selects the appropriate reference-driven generation path. The backend validates the selected model, duration, aspect ratio, resolution and references before reserving credits.

Static Seedance models use the shared ratios 9:16, 16:9, 1:1 and 4:3. MiniMax H3 supports durations from 4 to 15 seconds and selectable 480p or 768p resolution. Seedance 2.5 has configured 10, 15 and 30 second options; the optional 20 second entry appears when its source-cost setting is positive. Seedance 2.0 Fast has 10 and 15 second options.

Dynamic models receive their capabilities from the synced catalog. Their available durations, resolutions and reference roles can differ from the static models. Required reference slots and upload limits follow the selected model; the server enforces the same restrictions as the UI.

Customers can review generation status, play completed videos, download results, delete finished or failed records, and reuse a prompt. Reuse restores saved settings and available owned references. Reference thumbnails support removal and reordering. Playback elements are preserved during status updates so polling does not restart a playing video.

### Image Studio

Image Studio supports text generation and reference-based generation. Model selection controls the available aspect ratios, quality options, reference limits and displayed credit estimate. The aspect-ratio picker uses a popup containing vector shapes. SmartAIPI models expose Low, Medium and High when those qualities have configured prices.

Clicking a completed image opens a large floating preview. It has a pale viewing canvas, white details panel, saved prompt, selected quality and ratio, actual loaded pixel dimensions, and credits used. Download image saves the original output. Reuse prompt closes the preview and restores the image composer without creating a job or charging credits. Missing saved references are reported so the customer can upload them again.

On mobile, the details sit beneath the image and the prompt is collapsible. The whole image remains visible without cropping. Escape, the close button and a backdrop click dismiss the preview. Closing returns focus to the image card; a delayed close event cannot clear a newly opened preview.

### Voice Studio

Voice generation and cloning use the Vibi adapter. Voice choices and model choices are fetched from that API. Text-to-speech supports its ElevenLabs and MiniMax choices. MiniMax voice clones belong to the customer who created them. The public navigation and customer result URLs use CMM Tools rather than provider account details.

Voice access requires the global source to be active and the customer's Voice Studio assignment to be enabled. The TTS text limit is 10,000 characters; clone samples are limited to 20 MB. Generation runs through the persistent queue and standalone worker. Audio is played and downloaded through an authenticated same-origin media route. Existing audio elements are preserved while the page polls status, preventing periodic gallery refreshes from cutting off playback.

MiniMax H3 video uses the vgenv adapter. MiniMax voices use Vibi. A voice job therefore should not be expected in the vgenv video dashboard.

### Accounts plans and credits

Customers can register, sign in, sign out, view their credit ledger and change their password. Password changes rotate the active session. The dashboard includes generation statistics, a library, plan requests and account information. Provider availability and customer assignments determine which models and workspaces the customer can use.

## 3 Backend sources and model availability

These names are operational details for the owner and developer. Customer generation responses and UI avoid exposing provider credentials and internal output URLs.

### Sources by studio

| Studio | Sources |
| --- | --- |
| Video Studio | ArgoLink at 720p/1080p (Seedance 2.5/2.0/Fast/Mini, Wan 3.0/Prime, Grok Video 1.5, MiniMax H3); rendered lower and upscaled by fal.ai. Seedance 2.5 renders on fal.ai while ArgoLink is out of credits |
| Video Studio (Wan 3.0, Wan 2.7) | Yotta Labs: 480p native; 720p/1080p rendered lower and upscaled by fal.ai. See `docs/YOTTA.md` |
| Image Studio | Vercel AI Gateway and SmartAIPI first; ArgoLink takes over a model while its source is out of credits, and ArgoLink-only models are always listed |
| Cartoon Studio | Vidancee and CreatePulse (Seedance, whichever has credits), vgenv (MiniMax H3) |
| Upscaler and Video Studio HD enhancement | fal.ai (ByteDance Video Upscaler). See `docs/FAL_UPSCALER.md` |
| Voice Studio | Vibi |
| Prompt enhancer | Google Gemini 3.8 Flash |

Atlas Cloud and Higgsfield were removed on 12 October 2026; jobs still open on them are refunded by the worker.

| Source | Implemented role | Configuration method |
| --- | --- | --- |
| Vidancee | Seedance video generation through its authenticated website HTTP protocol | Admin login email and password |
| CreatePulse | Compatible Seedance overflow and routing | Admin API key |
| vgenv | MiniMax H3 video generation | Admin API key |
| SmartAIPI | GPT image generation and reference edits | Admin API key and model pricing |
| Vercel AI Gateway | Image Studio (its video models are no longer offered) | Admin API key, model eligibility and positive USD pricing |
| Yotta Labs | Video Studio Wan 3.0 and Wan 2.7 | Admin API key; prices from Yotta's public catalog. See `docs/YOTTA.md` |
| ArgoLink | Video Studio, and Image Studio backup when Vercel or SmartAIPI run out of credits | Admin API key and wallet balance; prices from ArgoLink's public catalog. See `docs/ARGOLINK.md` |
| Vibi | Text-to-speech and MiniMax voice cloning | Admin API key |
| Google Gemini | Optional image and video prompt enhancement in the web process | Admin API key |

Vidancee integration uses server-side login, cookies and CSRF tokens. Generation submits to `POST /api/generate.php`; status comes from `GET /api/jobs.php`. Image-to-video uses multipart `images[]` and `max_retries=3`. The project owner's authorization statement is preserved in `docs/VIDANCEE_PROTOCOL.md`. Keep evidence of that authorization with the project owner's business records.

Legacy Seedance routing can use Vidancee as primary and CreatePulse as overflow where the selected job is compatible.

A source can provide models only when it is configured, globally enabled and permitted for that customer. Dynamic catalog entries also need their own model switch enabled. Server-side cost and submission checks enforce this hierarchy. Queued work may wait when its source, model or customer assignment has been disabled. Switching a source off prevents new starts; already submitted jobs are handled according to their provider lifecycle.

### Vercel AI Gateway

The integration seeds 83 official media entries (39 video and 44 image, including Gemini image-generating language models) from the 11 October 2026 catalog. Admin can sync current models, show/hide entries and set USD estimates where fixed catalog prices are missing. The initial snapshot has 55 models with usable published prices. Only supported, priced, enabled, available models from an assigned and configured source enter customer selectors. Specialized vector, upscale and motion-control entries remain in Admin with a workflow notice.

Images use image-generation/edit APIs or multimodal chat completions. Videos use the gateway asynchronous start/status protocol, persist the opaque operation in shared MySQL and download the completed MP4 into chunked database storage. Vercel has an independent worker loop. See `docs/VERCEL_AI_GATEWAY.md` for setup, native Node 20 transport and verification limits.

## 4 SmartAIPI models sizes and quality

The adapter uses `https://api.smartaipi.com/v1`. Text requests use `/images/generations`; a reference uses `/images/edits`. Output is requested as PNG. One optional PNG, JPEG or WebP reference of up to 20 MB is supported. The current UI does not expose masks or multiple SmartAIPI references.

| Display model | API model ID | Supported ratios |
| --- | --- | --- |
| GPT Image 2.5 Flare | gpt-image-2.5-flare | Eleven custom-size presets |
| GPT Image 2.5 Sunburst | gpt-image-2.5-sunburst | Eleven custom-size presets |
| GPT Image 2 | gpt-image-2 | Eleven custom-size presets |
| GPT Image 1.5 | gpt-image-1.5 | 1:1, 3:2, 2:3 |
| GPT Image 1 | gpt-image-1 | 1:1, 3:2, 2:3; requires configured positive prices |
| GPT Image 1 Mini | gpt-image-1-mini | 1:1, 3:2, 2:3 |

An implemented adapter entry does not guarantee that the model is currently offered to every customer. Admin model switches, configured positive quality prices and customer source access determine the visible catalog.

| Aspect ratio | Requested width by height |
| --- | --- |
| 1:1 | 1024 x 1024 |
| 3:2 | 1536 x 1024 |
| 2:3 | 1024 x 1536 |
| 16:9 | 1536 x 864 |
| 9:16 | 864 x 1536 |
| 4:3 | 1280 x 960 |
| 3:4 | 960 x 1280 |
| 4:5 | 1024 x 1280 |
| 5:4 | 1280 x 1024 |
| 3:1 | 1536 x 512 |
| 1:3 | 512 x 1536 |

The adapter sends the selected size and an explicit canvas instruction alongside the provider prompt, even when enhancement is off. A 4:5 request specifies a portrait canvas 1024 pixels wide and 1280 pixels high. The saved customer prompt remains unchanged by the canvas instruction.

Returned PNG dimensions are checked from the image bytes. A result with a different resolution is accepted only if the aspect ratio matches, allowing one pixel of rounding, and the dimensions meet the enforced image bounds. A wrong shape produces `IMAGE_ASPECT_RATIO_MISMATCH`, fails the job and refunds the reserved customer credits. The app does not accept it as a completed result or start an automatic paid regeneration. A provider may still have charged for that unsuccessful result.

The enforced custom-size bounds are 655,360 to 8,294,400 pixels, a maximum edge of 3840 pixels and a maximum ratio of 3:1. Existing completed images are unchanged. Provider size documentation: https://smartaipi.com/blog/gpt-image-2-now-available and https://smartaipi.com/blog/gpt-image-2-5-now-available.

## 5 Customer credit accounting

There are separate billing rules by source. The former universal description of a 2.5 multiplier does not apply to every generation.

| Source family | Customer credit rule |
| --- | --- |
| Seedance (Vidancee/CreatePulse) and vgenv video | Real source cost in credits (Rs 3 each; USD at Rs 280) × 2.5, rounded to two decimals, calculated in src/pricing.js |
| SmartAIPI images | Estimated source USD multiplied by the direct customer-credits-per-USD setting, then rounded up to a whole credit |
| Vibi TTS | Conservative submission estimate, followed by reconciliation to reported source credits multiplied by the shared multiplier |
| Vibi cloning | Configurable customer clone cost in Admin |
| Prompt enhancement | No customer credit deduction; Google may charge the owner's API account |

The exact generation quote is reserved when the job is created and saved on that job. Later pricing edits do not change an existing reservation or its refund amount. Debits, refunds, plan grants and manual adjustments are written to the credit ledger. User-balance changes and queue creation use MySQL transactions and row locking. Failed jobs use `refunded_at` to prevent a repeated refund.

### SmartAIPI conversion

The default factor is `160 / 0.0265`, approximately `6037.735849` customer credits per source USD. It replaces the earlier 9,400 conversion. It is applied directly to SmartAIPI images without adding the shared 2.5 multiplier.

For the selected canvas, the source estimate is its configured square quality price multiplied by width times height divided by 1024 squared. The final quote is the ceiling of that estimate multiplied by the direct conversion factor. This is an estimate of upstream cost; input tokens and provider metering may add charges. Admin can change the square quality prices and conversion factor.

The pricing revision is `gpt2-medium-160`. Saved conversion settings from earlier revisions are superseded. An Admin override saved with the current revision persists. Existing queued reservations retain their saved quote.

SmartAIPI's official square pricing was rechecked on 11 October 2026: https://smartaipi.com/pricing.

| Model | Low source USD | Medium source USD | High source USD | Low / Medium / High customer credits at default factor |
| --- | --- | --- | --- | --- |
| GPT Image 2 | 0.003 | 0.0265 | 0.1055 | 19 / 160 / 637 |
| GPT Image 2.5 Flare | 0.003 | 0.0265 | 0.1055 | 19 / 160 / 637 |
| GPT Image 2.5 Sunburst | 0.003 | 0.0265 | 0.1055 | 19 / 160 / 637 |
| GPT Image 1.5 | 0.0045 | 0.017 | 0.067 | 28 / 103 / 405 |
| GPT Image 1 Mini | 0.0025 | 0.0055 | 0.018 | 16 / 34 / 109 |

These rows describe 1024 x 1024 output. Every source price in this table comes from the official pricing link above. GPT Image 2 and its two 2.5 variants currently have identical listed square rates, so equal quality and canvas choices intentionally have equal credit quotes. The application still supports model-specific Admin overrides.

At the default factor, a Medium GPT Image 2 at 4:5 is 200 credits; 3:2 or 2:3 is 240 credits. The 160-credit baseline applies to the square Medium image. A 40,000-credit balance funds 250 such square images at that baseline. These examples are credit arithmetic, not a promised monthly plan.

### Vercel conversion

Vercel has its own editable USD-to-credit factor, initially `160 / 0.0265`. Positive catalog image prices or duration tiers supply the quote. Token-priced or unpriced models require an explicit Admin image/quality or per-second estimate. Estimates are labeled in the UI. Existing SmartAIPI rates are never reused as Vercel source prices. The saved quote and model settings stay on the generation when pricing or the catalog later changes. The global 2.5 multiplier is not added to Vercel quotes.

### Voice reconciliation

TTS initially reserves an estimate based on the text length. After Vibi supplies `credits_deducted`, the worker reconciles the debit to the reported source amount times the shared multiplier. A customer refund and an upstream provider refund are different transactions; returning CMM Tools credits does not guarantee the owner receives provider credits back.

## 6 Plans and purchase workflow

| Plan | Advertised monthly price | Credits per approved purchase | Concurrent active jobs | Queue priority |
| --- | --- | --- | --- | --- |
| No paid plan | No paid plan price | Existing balance only | 1 | 0 |
| Basic | PKR 1,500 | 500 | 2 | 10 |
| Pro | PKR 4,500 | 1,500 | 3 | 20 |
| Premium | PKR 12,000 | 4,000 | 5 | 30 |

These are the definitions in `src/plans.js`, also returned by `/api/config`. There is no automatic checkout, recurring billing or scheduled monthly credit grant in the current code. Credits are granted on an approved plan request. Model availability still depends on source permissions and configuration even when a plan describes broad model access.

The customer requests a plan in Plans. Admin verifies payment externally and approves or rejects it under Admin Plans. Approval updates the plan and adds the saved request's included credits in one transaction. Rejection leaves the user's plan and balance unchanged. An already decided request cannot be approved again. A customer can have one pending request.

The active-job limit counts queued, submitting, submitted and processing records across video, image and voice generations. Higher queue priority is selected first, then earlier creation time. Priority cannot override provider capacity, a disabled source, required references or insufficient credits. Voice-clone tasks use their separate clone workflow.

## 7 Prompt enhancer

Image and video composers each have an optional Prompt enhancer switch, initially off. The configured model is Google `gemini-3.8-flash`, using thinking level `low`. It enhances still-image composition or video action and camera instructions while preserving the user's subject, language, quoted text and constraints.

The enhancer receives text and limited context such as ratio, video duration and reference counts. Uploaded media and filenames are not sent, so it cannot inspect the reference contents. A successful enhancement is placed into the prompt field and then submitted through the normal generation flow.

### Enabling and checking it

In Admin Provider, save the Gemini key, enable the enhancer source and enable the global Allow paid provider calls setting. Blank key input preserves the saved key; Clear saved API key removes it. Test saved connection checks metadata for the exact model without generating text. It does not verify remaining generation quota.

### Request recovery and limits

The current UI starts an async enhancement with a random UUID request ID. The initial acknowledgement has a 30-second client deadline. Status reads allow 20 seconds each. If the acknowledgement is lost, a read-only lookup by request ID finds the accepted job; a missing request is checked for up to 45 seconds. A retry of the same request ID and identical input resumes the existing job without a second provider call.

The upstream enhancement has a shared 120-second deadline covering the response headers, body and bounded retry delays. Only an explicit HTTP 503 rejection is automatically retried, up to twice with 2 and 4 second delays; a numeric Retry-After may increase a delay to at most 15 seconds. Timeouts, ambiguous connection failures and other upstream errors are not automatically retried. There is no model or provider fallback.

Background enhancement records live in the web process. They are capped at 1,000 entries and retained for ten minutes after completion or failure. They do not survive a restart and are not shared between web instances. Limits are six starts per minute per user, one concurrent request per user and eight concurrent requests overall.

If enhancement fails, the image or video job is not submitted and the prompt and references remain available. Turning enhancement off allows generation with the current prompt. A successful enhanced result can be reused after a generation-submission failure when the text and context are unchanged. Public config revision 5 identifies this recovery implementation.

An HTTP 503 message alone is not proof of low API credits. The app also returns an unavailable response when the enhancer is disabled, unconfigured or globally paused. Upstream billing, access, quota and service errors are categorized separately. Google error reference: https://ai.google.dev/gemini-api/docs/api-errors.

## 8 Queue and worker lifecycle

Creation validates ownership, source access, settings, required references, credit balance and the customer's active-job limit. A successful request saves a local queued generation and reserves the quote before the worker starts provider submission.

The standalone worker reads shared MySQL settings, checks source capacity, claims eligible work, submits it and persists provider state. Asynchronous providers are polled until completion or failure. Results appear in the customer's history through short status reads. A queued label describes local work waiting for eligibility or pickup; it does not prove that another customer is using the platform.

SmartAIPI returns synchronous image bytes, so slow image API work runs in the standalone worker. It has its own queue loop, starting about half a second after worker startup and normally polling every five seconds. Slow video polling does not hold up that loop. Claims use a MySQL advisory lock and configured inflight limits. The image bytes and completion state are saved together in `generation_image_outputs`, so separate Hostinger filesystems do not need a shared image-output folder.

SmartAIPI requests time out after five minutes. Ambiguous paid requests are not automatically submitted again. Local persistence retries reuse received bytes. If the worker exits during a request, processing image jobs older than ten minutes are marked interrupted and refunded on the next eligible worker check. A provider charge may still have occurred.

The web process sends a non-blocking, read-only wake request after saving video, image or voice work. Active image-status reads may repeat it at most every 15 seconds. The default for this domain is `https://worker.mehroz.online/live`; an explicit blank WORKER_WAKE_URL disables it. No prompt, reference, customer cookie or provider credential is sent to that endpoint.

Polling timers keep the worker process alive until shutdown and are cleared on SIGTERM or SIGINT. Process restarts and upstream queue delays still need operational monitoring. A successful health response shows reachability, not a guarantee that every provider can generate.

## 9 Admin operating guide

Open `/admin-console` and enter the private ADMIN_TOKEN. Admin API calls use `X-Admin-Token`; the UI keeps the token in browser sessionStorage. It is separate from a customer's sign-in session.

The admin can inspect users, enable or disable accounts, add or subtract credits by user ID or email, view the ledger, monitor generations, manage plan requests and edit provider settings. Credit adjustments reject a negative resulting balance.

### Provider settings

API keys and provider passwords are encrypted in MySQL. The encryption root is SETTINGS_ENCRYPTION_KEY, falling back to ADMIN_TOKEN. The same root must be supplied to both Hostinger applications. Admin read responses report whether a secret is configured and do not return its saved value. A blank secret input keeps its current value; explicit clear controls remove it.

Provider settings include Vercel credentials, catalog controls and USD price overrides, base URLs, global enable switches, inflight limits, Seedance routing, SmartAIPI model and quality prices, the direct SmartAIPI conversion factor, Gemini enhancement, and Vibi clone pricing.

### Customer source assignments

Use Admin Users and the Sources action to grant or remove access to ArgoLink, Vercel AI Gateway, SmartAIPI, Vidancee, CreatePulse, vgenv and Voice Studio. Every studio is on by default, Voice included; turn a source off per customer here. The source assignment is checked on the server as well as in the customer catalog.

Use the connection checks appropriate to the source. A successful model-list or account-read check proves only the checked read operation. It does not demonstrate a paid generation, provider queue speed or sufficient quota for every model.

## 10 Deployment and environment

| Hostinger setting | Customer web app | Generation worker |
| --- | --- | --- |
| Domain | cmmtools.site | worker.mehroz.online |
| Framework | Other | Other |
| Node version | 20.x or compatible later version | Same compatible version |
| Branch and root | main and ./ | main and ./ |
| Build command | npm run build | npm run build |
| Entry file | server.js | worker.js |
| WORKER_ENABLED | false | true |
| APP_URL | https://cmmtools.site | https://cmmtools.site |

`npm run build` is a lightweight no-bundle command. Hostinger starts the configured entry file. Do not place `npm run worker` in the build-command field. Keep CommonJS compatibility with Hostinger LiteSpeed; do not add an ESM graph with top-level await to the entry without changing the hosting runtime.

Hostinger supplies PORT. The server supports `process.env.PORT` with a fallback; do not override the supplied production port without a hosting-specific reason. For a local check, set a local port and `WORKER_ENABLED=false`. Both apps must use the same MySQL database. Keep APP_URL on the worker pointed at the customer domain for callbacks and signed reference URLs.

| Variable group | Purpose |
| --- | --- |
| NODE_ENV=production | Production cookie and runtime behavior |
| DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME | Shared MySQL connection; default DB_PORT is 3306 |
| ADMIN_TOKEN | Private admin access and optional encryption fallback |
| SETTINGS_ENCRYPTION_KEY | Preferred shared encryption root for saved provider secrets |
| PROVIDER_ASSET_SECRET | Signing temporary provider-accessible reference URLs; admin token fallback exists |
| WORKER_ENABLED | false on the web app, true on the worker |
| WORKER_POLL_MS | Queue polling interval; default 5000 ms |
| WORKER_WAKE_URL | Web-side wake endpoint for the separate worker |
| ALLOW_SIGNUPS, STARTING_CREDITS, SESSION_DAYS | Account setup; default starting credits 0 and session lifetime 30 days |

Provider credentials belong in Admin settings. Legacy provider environment values can seed settings when a corresponding database value is missing. Infrastructure secrets remain in Hostinger environment settings. Do not replace an established encryption root casually; existing encrypted provider values depend on it.

Recommended deployment sequence: inspect the current branch, make a scoped change, run checks appropriate to it, publish the intended files, wait for both deployments where needed, then check web liveness, database health, live assets and worker polling. Back up the MySQL database before schema changes. Avoid interrupting an in-progress synchronous paid image request during a deployment.

## 11 Data and access boundaries

| Table | Main responsibility |
| --- | --- |
| users | Customer identity, role, status, balance and plan |
| sessions | Hashed opaque customer-session tokens and expiry |
| generations | Video, image and voice records, state, selected settings, saved cost and internal provider metadata |
| credit_transactions | Debits, refunds, grants and admin adjustments |
| generation_images | Owned image-reference bytes and order |
| generation_media | Capability-driven media references and roles |
| generation_image_outputs | Stored image-output bytes |
| generation_video_outputs and generation_video_chunks | Durable MP4 metadata and 1 MiB chunks with authenticated HTTP Range playback |
| app_settings | Admin-managed provider and configuration settings |
| provider_models | Synced model catalog and capability metadata |
| user_provider_access | Per-customer source assignments |
| plan_requests | Pending, approved and rejected plan purchases |
| user_voice_clones | Customer-owned voice clones and sample data |

`src/db.js` creates and updates the schema at startup. Monetary and credit columns support fractional values. MySQL timestamps are stored in UTC; operational times in this handoff are labeled where local time is used.

Passwords use salted scrypt hashes. Customer sessions use opaque tokens; only their SHA-256 hashes are stored in MySQL. The `cmm_session` cookie is HttpOnly and SameSite=Lax, with Secure enabled in production. Authenticated media and reference routes verify ownership.

Temporary provider asset routes use signed URLs because some upstream APIs must fetch references from the customer domain. These are separate from normal customer download routes. Provider passwords, OAuth tokens, API keys and raw internal output URLs stay server-side. Deleting a generation removes its associated local data according to database relationships; it is not a provider-side cancellation request.

## 12 API reference

The following are operational route groups. Customer routes require a valid customer session unless identified as public. UUID and numeric placeholders represent identifiers, not literal path segments.

| Method and route | Purpose |
| --- | --- |
| GET / | Customer application |
| GET /admin-console | Admin interface |
| GET /live | Lightweight web liveness |
| GET /health | Web database and service diagnostics |
| GET /api/config | Public configuration and customer-aware model catalog |
| POST /api/auth/register | Create customer account |
| POST /api/auth/login | Create customer session |
| POST /api/auth/logout | End customer session |
| GET /api/me | Current customer |
| GET /api/dashboard | Customer generation statistics |
| GET /api/credits | Balance and ledger |
| POST /api/account/password | Change password and rotate session |
| GET /api/plan-status | Current plan and pending request |
| POST /api/plan-requests | Request a plan |

| Method and route | Generation purpose |
| --- | --- |
| POST /api/model-cost | Live dynamic model credit quote |
| GET or POST /api/generations | List or queue video generations |
| GET or DELETE /api/generations/:id | Read detail or delete eligible video record |
| GET /api/generations/:id/media | Authenticated video or poster media |
| GET /api/generations/:id/reference-images/:referenceId | Owned saved image reference |
| GET or POST /api/image-generations | List or queue image generations |
| GET or DELETE /api/image-generations/:id | Read image detail or delete eligible image record |
| GET /api/image-generations/:id/media | Authenticated stored image output |
| GET /api/voice-options | Available TTS models and voices |
| POST /api/voice-cost | Conservative TTS estimate |
| GET or POST /api/voice-generations | List or queue TTS jobs |
| DELETE /api/voice-generations/:id | Delete eligible TTS record |
| GET /api/voice-generations/:id/media | Authenticated generated audio |
| GET or POST /api/voice-clones | List owned clones or queue cloning |

| Method and route | Enhancement purpose |
| --- | --- |
| POST /api/prompts/enhance | Start enhancement; async true selects background mode |
| GET /api/prompts/enhance/:jobId | Read enhancement state |
| GET /api/prompts/enhance/requests/:requestId | Recover a lost acknowledgement |

Admin routes require `X-Admin-Token`. Key groups include GET /admin/stats, GET /admin/config, GET /admin/users, POST /admin/users/credits, PATCH /admin/users/:id, source-assignment routes, GET /admin/generations, GET /admin/credits and plan-request approval or rejection. Provider settings support GET and POST or PUT /admin/provider-settings. Connection checks include /admin/provider/check, /admin/vibi/check, /admin/smartaipi/check and /admin/prompt-enhancer/check. Vercel routes are POST /admin/vercel/check, POST /admin/vercel/sync and POST /admin/vercel/models/:id/price; model visibility updates accept provider=vercel.

Use the current `server.js` route handlers when implementing an API client; this summary does not define every request field. The worker exposes GET /health and /live at its separate origin. Call the worker paths without query strings in the current implementation.

## 13 Troubleshooting

### Site offline or HTTP 503

Start with https://cmmtools.site/live, then https://cmmtools.site/health. Liveness does not depend on MySQL or providers. If liveness fails, inspect Hostinger routing, deployment status, entry file and runtime logs. If liveness works but database.connected is false, check MySQL configuration and availability. Repeated PID changes, low uptime or SIGTERM logs indicate restarts that need hosting investigation. The Admin Overview "Server health" panel (from `GET /admin/diagnostics`) lists recent web and worker starts, the longest event-loop freeze and slow requests; if the site was unreachable but no start was recorded and no freeze appears, the outage was outside the application (for example Hostinger's edge firewall). Ask the person to retry on another network such as mobile data: if that works, their IP was blocked at the edge. Browser actions use POST only, because the edge firewall has challenged PUT requests. Check the exact customer's browser error and network as well; a successful check from another location does not explain every regional connection failure.

### A job stays queued with no other users

Check the worker's WORKER_ENABLED setting, increasing uptime and recent polling timestamps. For SmartAIPI, inspect imagePolling.enabled, sourceReady, lastStartedAt, lastFinishedAt, lastSuccessfulAt and activeTasks. Then check global paid calls, source configuration, model switch, customer assignment and inflight limits. Also verify that web and worker use the same database and encryption key. A queued job may be waiting locally before any provider request exists.

### Prompt enhancer unavailable or status unreadable

Confirm the enhancer switch, saved Google key and global paid-call setting. Refresh an older dashboard so it uses revision 5. A metadata connection check does not prove generation quota. Read the classified error: unavailable configuration, upstream credentials or billing, quota, temporary service failure and interrupted status recovery require different actions. A web restart can remove in-memory jobs. The prompt and references should remain; retry explicitly or turn enhancement off. Do not describe every 503 as low credits.

### Image has the wrong shape or matching model costs

The 4:5 API request must be 1024 x 1280. Review the preview's actual dimensions and current deployed canvas validation. A newly rejected wrong-size output should fail and refund, without a paid automatic retry. Earlier completed images keep their existing shape. Equal GPT Image 2 and GPT Image 2.5 Flare quotes are expected at their current identical source rates. Check quality, canvas size and Admin overrides before treating equal costs as a pricing bug.

### Video or audio stops after a few seconds

Verify the page is using current assets and that polling preserves the active playback element. Compare the authenticated media request and underlying output duration; a truncated provider file and a browser element replaced by polling are separate causes. Voice work is handled by Vibi, so inspect that voice source and worker flow rather than the vgenv video queue.

### A model or saved reference is missing

Check the global source switch, customer Sources assignments, model switch and configured prices or catalog sync. Reuse can restore only references still stored for the same owner. Deleted or unavailable reference data must be uploaded again. Dynamic models may reject roles or media types they do not support.

## 14 Verification and implementation limits

On 11 October 2026 at approximately 10:59 PKT, the customer page, public config, web health and worker health returned HTTP 200. Web health reported a configured and connected database. Worker health revision 4 reported an enabled worker, recent general and image polling timestamps, image source readiness and zero active SmartAIPI tasks at that instant. The served customer HTML matched the reviewed application revision.

The public configuration listed the three static video models and four enabled GPT image models: Image 2.5 Flare, Image 2.5 Sunburst, Image 2 and Image 1.5. Its square GPT Image 2 family credit quotes were Low 19, Medium 160 and High 637; Medium 4:5 was 200. Customer-specific catalogs can differ. Prompt enhancer visibility is deliberately false without an active customer session; an anonymous response does not establish its signed-in availability.

Earlier image-canvas implementation checks on 9 October recorded 42 automated tests passing. Image preview browser checks covered seven desktop, mobile and landscape viewport sizes with portrait, landscape and square images, long prompts, download, reuse, keyboard and backdrop close, focus restoration, fast reopening and image-load errors. Those checks used mocked provider APIs. The current documentation update does not claim a new paid generation or a live Gemini enhancement test.

Automatic payments, recurring plan renewal, Google customer sign-in, a multi-instance persistent enhancer queue and generalized provider cancellation are not implemented in the reviewed code. Adding those features requires explicit engineering work. Provider subscriptions, source credits, external model access and upstream queue speed remain separate from CMM Tools credit balances and local queue health.

## 15 Developer file map and maintenance

| Path | Responsibility |
| --- | --- |
| server.js | HTTP routes, authentication, public config, admin routes and media serving |
| worker.js | Standalone worker host and health endpoint |
| src/worker.js | Base queue and provider lifecycle |
| src/worker_admin_settings.js | Runtime Admin settings, provider lanes, voice and SmartAIPI handling |
| src/worker_wakeup.js | Non-blocking wake requests |
| src/settings.js | Encrypted settings and source-access configuration |
| src/db.js | MySQL pool and schema creation or migration |
| src/generations.js | Video records, owned references, queue validation and refunds |
| src/image_generations.js | Image records and stored output |
| src/voice_generations.js | Voice queue records |
| src/pricing.js | Static Cartoon Studio video pricing |
| src/smartaipi_images.js | GPT IDs, sizes, quality estimates and direct conversion |
| src/billing.js and src/plans.js | Shared conversion and plan definitions |
| src/prompt_enhancer.js | Gemini request, async records, limits and error handling |
| src/vercel_models.js and src/vercel_queue.js | Gateway model normalization, validation, pricing and independent recovery loop |
| src/provider/vercel.js and src/provider/vercel_catalog.json | Native gateway transport and initial official catalog snapshot |
| src/video_outputs.js and src/image_canvas.js | Durable video playback and output-canvas validation |
| src/provider_models.js | Dynamic model metadata and capability handling |
| src/provider | Individual backend adapters and signed asset utilities |
| public/index.html and public/studio.css | Customer UI and responsive workspaces |
| public/landing.html | Landing page for signed-out visitors (inline CSS, SVG and script) |
| public/admin.html and public/admin.css | Admin UI |
| public/brand.css and public/assets | Shared branding and supplied logo or icon |
| test | Parser, API, pricing, enhancement and worker checks |

Use `npm install` to install dependencies, `npm start` for a local web process, `npm run worker` for a separately configured worker, and `npm test` for automated tests. Routine checks must not create paid provider generations. Change the CSS version key when publishing style updates that need a cache refresh.

Keep future changes scoped to the intended files. Inspect the remote branch before publishing, and preserve other pending edits. Document a provider or pricing change with its official source, date, configured estimates and verification boundary. Confirm the live page and worker after a deployment. The feature-specific documents in this package provide deeper operating detail.

## 16 Reference documents and official sources

Repository documents: `docs/CLAUDE_CONNECTOR.md`, `docs/HPANEL_DEPLOYMENT.md`, `docs/ADMIN_PROVIDER_SETTINGS.md`, `docs/SMARTAIPI.md`, `docs/VERCEL_AI_GATEWAY.md`, `docs/PROMPT_ENHANCER.md`, `docs/CMM_UI_DESIGN.md`, `docs/PLANS.md`, `docs/VIDANCEE_PROTOCOL.md` and `docs/CHANGELOG.md`. Historical milestone detail is in `docs/archive/PROJECT_HANDOFF_2026-10-09.md`.

Claude connectors: https://claude.com/docs/connectors/building and https://claude.com/docs/connectors/building/authentication. MCP specification: https://modelcontextprotocol.io/specification. Official SmartAIPI source pricing: https://smartaipi.com/pricing. GPT Image 2 size documentation: https://smartaipi.com/blog/gpt-image-2-now-available. GPT Image 2.5 documentation: https://smartaipi.com/blog/gpt-image-2-5-now-available. Gemini API errors: https://ai.google.dev/gemini-api/docs/api-errors. Gemini thinking controls: https://ai.google.dev/gemini-api/docs/generate-content/thinking#thinking-levels.

All customer-credit examples in this handoff describe the reviewed application settings or explicitly identified defaults. Before changing commercial pricing, check the current Admin settings and the provider's current official prices.

# SmartAIPI GPT images

Deploy this version to both the web application and the standalone worker. Both
must use the same MySQL database and settings encryption secret. Startup creates
`generation_image_outputs` automatically; the database user needs CREATE TABLE
and ALTER TABLE permissions. Startup adds nullable `generations.image_quality`;
existing queued jobs use Medium. No new npm dependencies or provider environment
variables are needed.

In Admin → Provider → GPT images · SmartAIPI:

1. Keep the API base URL `https://api.smartaipi.com/v1`.
2. Enter the SmartAIPI API key, enable the source, and save settings. Keys use the
   existing encrypted settings storage and are never returned by the settings API.
3. Customer credits per USD defaults to 160 ÷ 0.0265 (approximately
   6,037.735849). Credits are estimated source USD × this multiplier, rounded
   up to whole credits: $0.0265 → 160 credits. This directly sets customer pricing
   for every SmartAIPI image model, quality and size.
4. Review the Low, Medium and High square source-price estimates. Published
   estimates are prefilled. GPT Image 1 starts at zero because its per-image price
   was not listed; configure each quality to expose it. A zero rate hides that
   quality; all-zero rates or unchecked models hide the model. Existing saved
   Medium prices are preserved; initial Low/High prices scale proportionally to
   those overrides. Review them in Admin before enabling paid generations.
5. Click Test saved connection. This calls GET `/v1/models`, reports which exact
   image IDs are listed for the account, and does not generate paid images.
6. Existing global paid-generation controls and Admin → Users → Sources apply.
   A disabled source or denied customer cannot submit or start new SmartAIPI jobs.

Supported explicit model IDs:

| API model | Low square USD | Medium square USD | High square USD |
| --- | ---: | ---: | ---: |
| gpt-image-2.5-flare | 0.003 | 0.0265 | 0.1055 |
| gpt-image-2.5-sunburst | 0.003 | 0.0265 | 0.1055 |
| gpt-image-2 | 0.003 | 0.0265 | 0.1055 |
| gpt-image-1.5 | 0.0045 | 0.017 | 0.067 |
| gpt-image-1 | Configure | Configure | Configure |
| gpt-image-1-mini | 0.0025 | 0.0055 | 0.018 |

Pricing references: https://smartaipi.com/pricing and https://smartaipi.com/docs,
checked 2026-10-09. These are estimates, not exact token settlement. Variable text
and reference-image input charges may increase actual upstream costs. Admin can
adjust each quality’s square estimate to account for those costs. Other sizes use
an approximate pixel-area factor: width × height / 1024². The fixed landscape and
portrait sizes retain the existing 1.5× estimate. SmartAIPI does not publish exact
per-image prices for every custom shape.

SmartAIPI currently publishes identical Low/Medium/High square rates for GPT
Image 2, GPT Image 2.5 Flare and GPT Image 2.5 Sunburst. Their credit quotes are
therefore intentionally identical for the same quality and canvas. For Medium
1024×1024 each lists $0.0265, corresponding to 160 customer credits at the default
conversion. Model-specific Admin overrides remain available; no speculative
price difference is applied.

SmartAIPI customer credits equal ceil(estimated source USD × customer credits per
USD), with a default factor of 160 / 0.0265 (approximately 6,037.735849).
No additional CUSTOMER_CREDIT_MULTIPLIER applies to these image jobs. The same quote is shown before submission and
reserved in the existing credit transaction. A queued job keeps its selected
quality and reserved quote if prices or UI choices change.
The `gpt2-medium-160` pricing revision supersedes previously saved conversion
rates, including 9,400, on deployment. Admin can then save a different direct
multiplier; saving it records the revision so that override persists. Legacy
`smartaipi_credits_per_usd` values are ignored. Existing reservations retain their
original quote and refund amount.
Other provider pricing retains its existing conversion and markup.

GPT Image 2 and both 2.5 models expose these aspect-ratio presets:

| Ratio | API size |
| --- | --- |
| 1:1 | 1024×1024 |
| 3:2 | 1536×1024 |
| 2:3 | 1024×1536 |
| 16:9 | 1536×864 |
| 9:16 | 864×1536 |
| 4:3 | 1280×960 |
| 3:4 | 960×1280 |
| 4:5 | 1024×1280 |
| 5:4 | 1280×1024 |
| 3:1 | 1536×512 |
| 1:3 | 512×1536 |

Custom-size documentation: https://smartaipi.com/blog/gpt-image-2-now-available
and https://smartaipi.com/blog/gpt-image-2-5-now-available. Presets use dimensions
divisible by 16, 655,360–8,294,400 pixels, maximum edge 3840 and maximum ratio 3:1.
GPT Image 1, 1.5 and 1 Mini retain their three fixed sizes: 1:1, 3:2 and 2:3.
The server and API adapter enforce these model-specific options.

Each SmartAIPI request includes the selected `size` and an explicit canvas
instruction appended to the provider prompt, even when the prompt enhancer is
off. For 4:5 this is a portrait canvas, 1024 pixels wide by 1280 pixels high. The
original saved customer prompt stays unchanged. Reference-image dimensions and
conflicting prompt framing must not override the selected canvas.

The adapter requests PNG output and checks the actual image's IHDR dimensions,
not response labels. A different resolution is accepted only if its aspect ratio
matches, allowing one pixel of rounding; dimensions must also fit the documented
image bounds. A wrong shape is failed with a specific customer error and the
existing idempotent refund. It is never stored as a completed image, stretched,
cropped or automatically regenerated. This prevents accepting horizontal output
for a 4:5 request; it does not guarantee that the upstream provider will honor
every custom size on every attempt. Upstream charges may still occur when the
provider returns a wrong-size image. Existing completed images are unchanged.

Image Studio offers Low, Medium and High quality, defaults to Medium when priced,
and produces one result per job. Quality appears on the generated-image card and
preview. Text requests use `/v1/images/generations`. One optional PNG/JPEG/WebP
reference of up to 20 MB uses `/v1/images/edits` with a JSON base64 image and the
same selected size and quality. Provider documentation conflicts on multiple
references and masks, so those capabilities are intentionally not exposed.

A saved image job first appears as `queued` while the standalone worker claims it; this does not indicate other customers ahead of it. GPT images have their own polling loop, starting about half a second after worker startup and repeating at the configured WORKER_POLL_MS interval (five seconds by default). Slow or unavailable video-provider checks cannot delay that loop. Existing source, model, user-access and inflight limits still apply. Once claimed, the image is marked `processing` before the upstream API call.

The web app sends a throttled, read-only health request to wake the standalone worker after saving an image/video/voice job. Active image-status reads also wake it so existing queued work can recover when the dashboard is reopened. No prompt, reference, session cookie or provider credential is sent. Job creation does not wait for this request. For ai.mehroz.online the default is https://worker.mehroz.online/live; other deployments should set WORKER_WAKE_URL to their worker health endpoint. Set it to an empty value to disable wake requests. Worker health revision 4 reports workerEnabled, general polling timestamps, independent imagePolling timestamps, and active image tasks. Web health services.queueRevision 1 reports wake-request results; imageCanvasRevision 1 identifies canvas request and output validation.

The provider returns synchronous base64 image data. The worker claims queued jobs
under a shared MySQL advisory lock, obeys inflight limits, and performs slow API
requests in the background while continuing other provider polling. It stores
output bytes and completion together in MySQL, avoiding reliance on shared disk
between worker and web hosts. Existing authenticated ownership checks protect
viewing and download; deleting a generation cascades to its output bytes.

Upstream requests time out after five minutes. Paid requests are never retried
automatically after an ambiguous failure. Failed requests refund reserved customer
credits; local persistence retries do not call the upstream API again. If a worker
exits during an API request, jobs still processing after ten minutes are marked
interrupted and refunded by the next worker poll. A provider charge may still have
occurred. Disabling a source stops new starts; an already started request may finish.
Queued jobs wait while the global source, model or customer permission is disabled.

Verification: `npm test` covers endpoint mapping, edit input, response validation,
timeouts, all supported ratio/quality combinations, estimate conversion, encrypted
settings, HTTP submission and ownership,
worker persistence/refunds/capacity, and interrupted-request handling using mocked
provider and database responses. Local browser QA checks model selection, ratio
and quality quotes, submitted quality, reference limits, admin quality-price
settings and desktop/mobile layouts. Live provider
generation and the production MySQL migration require the configured deployment;
no live provider key was supplied during implementation.

Worker polling timers keep the Node event loop alive until shutdown. They are cleared by `stop()` on SIGTERM/SIGINT, so the consumer cannot exit merely because a request finished and only background polling remained.

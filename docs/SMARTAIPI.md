# SmartAIPI GPT images

Deploy this version to both the web application and the standalone worker. Both
must use the same MySQL database and settings encryption secret. Startup creates
`generation_image_outputs` automatically; the database user needs CREATE TABLE
permission. No new npm dependencies or provider environment variables are needed.

In Admin → Provider → GPT images · SmartAIPI:

1. Keep the API base URL `https://api.smartaipi.com/v1`.
2. Enter the SmartAIPI API key, enable the source, and save settings. Keys use the
   existing encrypted settings storage and are never returned by the settings API.
3. Set source credits per USD to match the application's credit conversion.
   The default is 100; this is an application setting, not a SmartAIPI credit unit.
4. Review each medium-quality square source-price estimate. The five published
   estimates are prefilled. GPT Image 1 starts at zero because its per-image price
   was not listed; set its price to make it visible. Zero prices and unchecked
   models are hidden from customers.
5. Click Test saved connection. This calls GET `/v1/models`, reports which exact
   image IDs are listed for the account, and does not generate paid images.
6. Existing global paid-generation controls and Admin → Users → Sources apply.
   A disabled source or denied customer cannot submit or start new SmartAIPI jobs.

Supported explicit model IDs:

| API model | Square source USD estimate, medium |
| --- | ---: |
| gpt-image-2.5-flare | 0.0265 |
| gpt-image-2.5-sunburst | 0.0265 |
| gpt-image-2 | 0.0265 |
| gpt-image-1.5 | 0.017 |
| gpt-image-1 | Configure in Admin |
| gpt-image-1-mini | 0.0055 |

Pricing references: https://smartaipi.com/pricing and https://smartaipi.com/docs,
checked 2026-10-09. These are estimates, not exact token settlement. Variable text
and reference-image input charges may increase actual upstream costs. Admin can
adjust estimates to account for those costs. Landscape and portrait multiply the
configured square estimate by 1.5. Customer credits equal configured source USD ×
source credits per USD × existing CUSTOMER_CREDIT_MULTIPLIER (default 2.5), rounded
to two decimals. The same quote is shown before submission and reserved in the
existing credit transaction. A queued job keeps its reserved quote if prices change.

Image Studio offers square 1024×1024, landscape 1536×1024 and portrait 1024×1536,
medium quality, one result per job. Text requests use `/v1/images/generations`.
One optional PNG/JPEG/WebP reference of up to 20 MB uses `/v1/images/edits` with a
JSON base64 image. Provider documentation conflicts on multiple references and
masks, so those capabilities are intentionally not exposed in this integration.

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
timeouts, estimate conversion, encrypted settings, HTTP submission and ownership,
worker persistence/refunds/capacity, and interrupted-request handling using mocked
provider and database responses. Local browser QA checks model selection, ratio
quotes, reference limits, admin settings and desktop/mobile layouts. Live provider
generation and the production MySQL migration require the configured deployment;
no live provider key was supplied during implementation.

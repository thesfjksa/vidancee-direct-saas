# Vercel AI Gateway in CMM Tools

Updated 11 October 2026.

## Setup

1. Open `/admin-console` and the **Provider** tab.
2. Paste a Vercel **AI Gateway API key** in the image/video gateway card. Save provider settings. Blank key fields preserve the existing encrypted key; the explicit clear checkbox removes it.
3. Use **Check saved key** to read `/v1/credits`. This is a balance check and does not create a paid generation.
4. Use **Sync live models** to refresh models, capabilities, pricing and account eligibility. Without a key it reads the public catalog; with a key it requests account availability annotations. Incomplete or empty catalog responses leave the previous catalog intact.
5. Set missing model prices, enable the source and generation submissions, and assign Vercel access in **Users → Sources**.

Do not put keys in customer JavaScript, source files, documentation or model settings. API keys are encrypted in `app_settings`. Account access, model visibility and source activation are enforced by the server as well as the customer selectors.

## Catalog and controls

The bundled official snapshot contains **83 media entries: 39 video and 44 image**. It includes language models with image output, which would be missed by filtering only `type=image`.

| Media | Families in the initial catalog |
| --- | --- |
| Image | GPT Image 1 / Mini / 1.5 / 2 / 2.5 variants, Gemini / Nano Banana, Flux, Seedream, Recraft, Grok Imagine, Meta Muse and Prodia |
| Video | Veo, Kling, Wan, Seedance, MiniMax H3, Grok Imagine, Flux Video and HeyGen |
| Specialized entries | Quiver vectors, Topaz upscaling, motion control and certain editing utilities |

All catalog entries are shown in Admin. Specialized entries stay out of customer generation selectors because the current prompt/reference workflow does not implement their required editing, SVG, motion or upscale inputs. A price override cannot bypass that adapter restriction. Unknown future models also require supported workflow metadata before activation; catalog discovery does not promise a universal adapter.

The snapshot has **55 models with usable published generation prices**. GPT token prices, newer Flux models and token-priced Seedance models do not have a complete fixed quote in the catalog and therefore require an Admin USD estimate. A zero or missing rate never becomes a free generation. Sync preserves model Show/Hide choices and separately stored price overrides.

Customers receive only ready, enabled, available models for their assigned and configured sources. Each model keeps a distinct neutral public ID (`studio_gw_...`) so overlapping models do not overwrite SmartAIPI, Higgsfield or legacy routing. Source names remain in Admin controls.

Image controls include supported ratio presets, GPT/Grok quality controls and Gemini/Seedream resolution controls. Video controls use catalog durations, resolutions, ratios, audio support and modes where present. Validation rejects unsupported selections and incompatible reference roles before credit reservation. Use either first/last frames or reference inputs within a video request. Required input files are enforced; audio reference uploads and specialized video editing/extension workflows are not implemented by this baseline.

## Pricing

Vercel uses a separate, editable **customer credits per USD** setting. Its initial value is `160 / 0.0265`, approximately 6037.735849. This does not copy SmartAIPI source prices: each Vercel model uses its own current catalog rate or Admin override. No additional global 2.5 multiplier is applied.

- Fixed image prices and applicable image size/quality tiers supply the image quote.
- Video duration tiers match resolution, mode and generated-audio selection. Voice-control tiers are excluded because the UI does not expose that feature.
- Missing or token-only pricing requires an explicit positive Admin rate. Token floors, reference-video duration and variable input tokens cannot be safely reduced to one guessed fixed rate.
- Image override examples: `{"perImage":0.04}` or `{"low":0.01,"medium":0.04,"high":0.16}`. These are **examples, not published model prices**. Overrides describe a 1024px square image and scale with the requested pixel area. Prefer separate prices for each quality.
- Video overrides specify a positive **USD per second** rate, for example `0.10`. The quote multiplies that rate by duration.
- Blank override fields restore catalog pricing. Estimates are labeled in the customer UI. Variable upstream token costs may differ from the quote; customer credits use the reservation fixed at job creation.

Quotes round up to whole credits. Model settings, options, source USD estimate and customer reservation are saved on the job. Catalog and pricing changes do not alter existing reservations. Failed jobs use the existing transaction/`refunded_at` mechanism to refund once.

## Transport and queue lifecycle

The integration uses native `fetch` on the existing CommonJS / Node 20 runtime. The current published AI SDK 7 / gateway SDK requires Node 22; this change does not install it or change Hostinger runtimes. Image transport follows the official OpenAI-compatible REST contracts. Video transport follows the gateway v4 wire contract verified against `@ai-sdk/gateway@4.0.110`; protocol changes should be checked against the official provider source before upgrading the adapter.

| Operation | Endpoint |
| --- | --- |
| Discover models | GET `https://ai-gateway.vercel.sh/v1/models` |
| Check balance | GET `/v1/credits` |
| Generate/edit image-only output | POST `/v1/images/generations` or `/v1/images/edits` |
| Generate multimodal Gemini image output | POST `/v1/chat/completions` |
| Start video | POST `/v4/ai/video-model/start` |
| Read existing video operation | POST `/v4/ai/video-model/status` |

The worker has an independent gateway loop. A connection-scoped MySQL lock bounds total Vercel inflight work across processes; queued rows are claimed with a compare-and-swap update. Slow image requests run outside polling loops. Video starts carry the local generation UUID as `idempotency-key`. Opaque video operations are persisted in `generations.provider_operation` and resumed after worker restarts. Status retries never start a new generation.

There is no automatic repeat of a paid image request or ambiguous video start. Interrupted submitting rows are refunded after 3 minutes; interrupted image processing after 10 minutes. Active image tasks are exempt from same-process stale recovery. Video polling expires after 45 minutes. Disabling new submissions does not prevent read-only polling of accepted videos when the saved key is present.

References are hosted as signed URLs from `APP_URL`, including `/provider-media/:generationId/:position` for mixed video inputs. Async gateway requests must remain below the documented 300 KiB persisted-request ceiling; binary inputs are not embedded in start requests. Both applications require the same signing/encryption secrets.

## Media persistence and limits

Image outputs are stored in `generation_image_outputs`; output bytes must be PNG, JPEG or WebP and match the requested ratio within provider rounding tolerance. Opposite orientations are rejected, with a refund and no automatic paid retry.

Videos are downloaded from the provider and stored as durable MP4 bytes in `generation_video_outputs` and `generation_video_chunks`. Each database chunk is 1 MiB, avoiding a single large SQL packet. `/api/generations/:id/media` checks ownership and serves exact HTTP byte ranges, supporting playback and seeking without exposing provider links or depending on their expiry. Deleting a generation cascades to its stored output.

Image outputs are limited to 20 MiB and video outputs to 64 MiB. Existing multipart upload limits remain 25 MiB per file and 24 uploaded files per request; model limits can be lower. The gateway adapter caps model inputs at 20 references and applies provider format limits. These are app limits, even when the upstream catalog allows more. Unexpected, expired, oversized or unsupported video outputs remain eligible for read/download recovery until the video deadline, then refund.

## Admin API and diagnostics

| Route | Purpose |
| --- | --- |
| GET/POST `/admin/provider-settings` | Masked settings and encrypted key updates |
| POST `/admin/vercel/check` | Saved key and gateway credit-balance check |
| POST `/admin/vercel/sync` | Live catalog and account eligibility sync |
| GET `/admin/provider-models?provider=vercel` | Full Admin catalog, pricing and setup notices |
| POST `/admin/provider-models/:id` | Set visibility with `{"provider":"vercel","enabled":true}` |
| POST `/admin/vercel/models/:id/price` | Set `{"price":...}` or `{"price":null}` to restore catalog rates |
| POST `/api/model-cost` | Authenticated server quote for selected model/options |

Admin routes require `X-Admin-Token`. Worker health revision **5** adds `gatewayPolling` with enabled/running flags, timestamps, source readiness and active task count. Web health exposes `services.mediaGatewayRevision=1`. Source readiness remains false until key, source enablement and submission enablement are configured.

Automated checks cover catalog selection, model/audio/quality pricing, request mapping, start idempotency, operation recovery, encrypted settings, account/model authorization, credit reservations, private output ownership and byte-range playback. Browser checks use API fixtures and create no paid generations. Live end-to-end image/video generation still requires a configured gateway key, a funded account and provider model access; HTTP health and catalog sync alone do not verify those conditions.

## Official references

- [Live model catalog](https://ai-gateway.vercel.sh/v1/models)
- [Gateway REST and availability API](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api)
- [Image generation and edits](https://vercel.com/docs/ai-gateway/modalities/image-generation/openai)
- [Async video generation and idempotency](https://vercel.com/docs/ai-gateway/modalities/video-generation)
- [Google image settings](https://ai-sdk.dev/providers/ai-sdk-providers/google)
- [ByteDance image/video settings](https://ai-sdk.dev/providers/ai-sdk-providers/bytedance)
- [MiniMax resolution mapping](https://ai-sdk.dev/providers/ai-sdk-providers/minimax)

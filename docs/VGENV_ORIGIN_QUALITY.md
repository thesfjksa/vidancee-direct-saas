# MiniMax H3 Origin Quality handoff — 30 October 2026

## Change

CMMTools already integrated VGENV Base, Cinematic and Origin, but always submitted the Fast tier. The new `minimax_h3_origin_quality` option is labelled **MiniMax H3 Origin Quality** and sends `model: "origin", tier: "quality"` to `POST /v3/videos`.

A distinct persisted model ID keeps the tier tied to its price across queue restarts, retries and prompt reuse. Existing model IDs remain Fast. The shared catalog exposes the option in Video Studio and Cartoon Studio through existing VGENV access controls; no database migration or new credentials are required.

## Price and supported settings

| Resolution | Upstream USD per output second |
| --- | ---: |
| 480p | 0.0077 |
| 768p | 0.015 |

Rates were read from https://www.vgenv.com/pricing on 30 October 2026. Customer credits use the existing `usdToCredits` conversion, whole-credit rounding, and existing account/global price adjustments. Vendor dollars are not customer credits. No existing Fast prices or billing multipliers were changed.

The option keeps the app's 4–15 integer-second range, existing aspect ratios, and existing reference controls (up to six images, one MP4 video and two audio references, with existing file-size/duration validation). This change does not add first/last-frame mode, Turbo or upscaling.

API schema verified read-only at https://api.vgenv.com/docs-json: `CreateVideoV3Dto` accepts `origin`, `quality`, `480p`, `768p`, `reference_images`, `reference_video` and `reference_audios`. The site feature guide and API schema have different limits; the app retains its existing narrower limits. No paid generation was made to verify provider entitlement, output quality or actual billed price.

## Submission and result handling

- The worker derives both model and tier from the saved model ID, rather than trusting a separate client-supplied tier.
- Existing asset uploads and the stable `mehroz-<generation-id>` idempotency key are reused.
- Origin Quality status queries use the existing v3 polling path; completed output storage and failure refunds use the existing pipeline.
- The provider adapter defaults to Fast for legacy callers and rejects an unknown tier before submission.

## Validation and deployment

Focused tests cover all offered Quality prices, preserved Fast defaults, studio catalogs, the worker-to-HTTP Quality request, video/audio references, retry key stability, and invalid tiers. Provider calls are mocked; no live credentials or charged requests are used.

After review and merge, deploy the same revision to both `cmmtools.site` (web) and `worker.mehroz.online` (worker). Deploy the worker before exposing the new web catalog: an older worker does not recognize this new model ID. Verify the deployed revisions, VGENV readiness and model visibility. Use the existing encrypted Admin VGENV key and funded project. Source-code changes and passing tests do not establish a successful live deployment or generation.

For rollback, stop new Quality submissions and drain/reconcile existing Quality jobs before deploying an older worker. Do not rename saved Quality jobs to the cheaper Fast model or replay a paid submission with a new idempotency key.

# Higgsfield API (Wan 3.0)

Video Studio's **Wan 3.0 · up to 30 s** runs on the Higgsfield API (https://docs.higgsfield.ai, base URL `https://api.higgsfield.ai`). It replaced Yotta Labs on 17 October 2026. Customers never see the Higgsfield name.

## Setup

1. Create an API credential in Higgsfield Console (https://console.higgsfield.ai). It has a key ID and a secret.
2. Admin → Provider → **Video Studio · Higgsfield (Wan 3.0)**: paste it as `KEY_ID:KEY_SECRET`, keep the switch on, set **Max inflight** at or below the concurrency limit shown in Higgsfield Console, and save.
3. Saving a new key reads Wan 3.0's prices from Higgsfield (see Pricing). The model stays hidden from customers until that has worked. **Sync prices** reads them again; **Check saved key** tests the key. Neither charges anything.
4. Admin → Users → Sources has a Higgsfield switch per customer. Admin → Provider → Model names (with HD enhance) includes the model.

## Requests

One Video Studio model maps to three Higgsfield endpoints:

| Customer input | Endpoint | Fields |
| --- | --- | --- |
| Prompt only | `alibaba/wan-3.0/text-to-video` | `prompt, duration, resolution, aspect_ratio, generate_audio` |
| Start frame (+ optional end frame) | `alibaba/wan-3.0/image-to-video` | `image_url`, `end_image_url`, `aspect_ratio: "adaptive"` |
| Reference images / videos / sound | `alibaba/wan-3.0/reference-to-video` | `image_urls` (≤10), `video_urls` (≤5, 1–30 s each, 30 s total), `audio_urls` (≤5, WAV/MP3, 30 s total) |

Frames and reference files cannot be mixed in one video; the app refuses that before credits are taken. Prompts cite references as @Image1, @Video1, @Audio1. Durations 2–30 s; ratios 16:9, 9:16, 1:1, 4:3, 3:4.

Reference files are uploaded to Higgsfield's storage first (`POST /files/generate-upload-url`, then a PUT). Higgsfield's storage takes JPEG, PNG, WebP, GIF, WAV and MP4; MP3 and MOV files, or a failed upload, are sent as the app's signed `/provider-media` links instead (logged as `higgsfield.upload_failed`).

Every submission carries `Idempotency-Key: cmm-<job id>`, so a resend after a lost answer returns the same request instead of charging again. The worker polls the saved `status_url` until `completed`, `failed`, `nsfw` or `canceled`. Failed and moderated jobs are refunded (Higgsfield does not charge them either). HTTP 403 means the Higgsfield account is out of credits; the job is refunded with that reason.

Activity log events: `higgsfield.request` (the exact input), `higgsfield.upload`, `higgsfield.accepted`, `higgsfield.status`, `higgsfield.prices_synced`.

## HD enhancement and pricing

As with ArgoLink: 480p is rendered natively; with fal.ai set up, 720p is rendered at 480p and 1080p at 720p, both upscaled to 1080p by fal.ai. HD enhance can be turned off per model in Model names.

Prices come from Higgsfield's `POST /estimate/alibaba/wan-3.0/text-to-video` for a 5 s clip at each resolution, with and without sound, stored as USD per second. Wan 3.0 is sold at cost (`NO_PROFIT_MODELS` in `src/wan_pricing.js`): render + HD upscale, at the Creator plan's credit price. It is not capped against Higgsfield's app prices, because Higgsfield is its source. Reference-route surcharges, if Higgsfield adds any, are not in the estimate; compare the job's price snapshot with the Higgsfield bill after the first reference jobs.

## Not verified

No paid Higgsfield request was made during development; the request shapes follow Higgsfield's published schemas and were tested against mocks. Check the first text, frame and reference jobs in Admin → Activity.

## Code

`src/higgsfield_models.js` (model, references, price sync), `src/provider/higgsfield.js` (API client), `src/higgsfield_queue.js` (worker queue on top of the ArgoLink queue), `src/argo_hd.js` (`wanVideoView`, the HD plan).

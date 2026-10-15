# Yotta Labs in CMM Tools (Wan 3.0, Wan 2.7)

Yotta Labs' AI Gateway (https://gateway.yottalabs.ai/api/maas) supplies two Video Studio models: **Wan 3.0** (2–30 s, 480p/720p/1080p, generated audio on or off) and **Wan 2.7** (2–15 s, 720p/1080p). Customers see them as "Wan 3.0 · up to 30 s" and "Wan 2.7 · up to 15 s" (rename them in Admin → Provider → Model names). ArgoLink's own Wan 3.0 stays listed beside them; hide either one in Admin if only one should show.

## Setup

1. Create an API key in the Yotta dashboard and top up the account.
2. Admin → Provider → **Video Studio · Yotta Labs**: paste the key, keep the switch on, set **Max inflight generations** (default 3), then **Save settings**. **Check saved key** confirms Yotta accepts the key without starting a job; **Sync live models** refreshes settings and prices from Yotta's public catalog (`GET /models/{slug}`, no key needed).
3. Per customer: Users → Sources → **Yotta Labs** (on by default). The key can also come from the `YOTTA_API_KEY` environment variable on first start.

## Resolutions and HD enhancement

| Customer picks | Wan 3.0 renders | Wan 2.7 renders | Then |
| --- | --- | --- | --- |
| 480p | 480p | (not offered) | delivered as rendered |
| 720p | 480p | 720p (it has no 480p) | Wan 3.0: fal.ai upscales to 1080p |
| 1080p | 720p | 720p | fal.ai upscales to 1080p |

This is the HD enhancement already used for ArgoLink (`docs/FAL_UPSCALER.md`): the render is stored, fal downloads it from a signed link and upscales it with its defaults, and the upscale replaces it. If fal is not configured, every resolution is rendered natively. If the upscale cannot run or fails, the customer gets the render and the upscale part of the price back. The **HD enhance** box in Admin → Provider → Model names turns it off per model (then each resolution renders natively).

## Prices

Customer credits = Yotta's USD price for the render × 6,720 (24 credits per rupee), plus fal's $0.0072 per second for the upscale, rounded up. Yotta's prices on 15 October 2026 (discounted rates; the list prices are $0.05 / $0.10 / $0.20 for Wan 3.0 and $0.10 / $0.15 for Wan 2.7):

| 5 s clip | Wan 3.0 | Wan 2.7 |
| --- | --- | --- |
| 480p | $0.175 → 1,176 credits | — |
| 720p | $0.175 + $0.036 → 1,418 (native would be 2,352) | $0.275 → 1,848 |
| 1080p | $0.35 + $0.036 → 2,594 (native would be 4,704) | $0.275 + $0.036 → 2,090 (native 2,772) |

Sync live models picks up Yotta's current prices; a job keeps the price quoted when it was created.

## Requests

- Prompt only: `POST /text-to-video/generations` with `{model: "wan3.0-t2v", parameters: {prompt, resolution, duration, aspect_ratio, generate_audio, enhance_prompt: false}}`.
- Start frame: `POST /image-to-video/generations` (`wan3.0-i2v` / `wan2.7-i2v`) with `first_frame` (the app's signed image link); Wan 3.0 is sent `aspect_ratio: adaptive` so the video takes the frame's shape.
- Reference images (up to 5): `POST /reference-to-video/generations` (`wan3.0-r2v` / `wan2.7-r2v`) with `reference_items: [{url, type: "image"}]`; the prompt can cite them as @Image1, @Image2.
- The key goes in `X-API-KEY`. Success answers have `code: 10000`; `data.request_id` is saved before the first poll, then `GET /{route}/generations/{id}` is polled until `data.status` is `completed` (`data.output_url` is downloaded into the database), `failed` or `cancelled` (refunded with Yotta's reason). Jobs run in their own worker loop (`src/yotta_queue.js`) with the ArgoLink queue's claim, restart recovery and refund rules; a video still running after 3 hours is refunded.

## Not verified

No paid Yotta request was made from the development environment, and Yotta's public docs do not list the Wan image fields. `first_frame` (used by Yotta's other image-to-video models) and `reference_items` (from Yotta's Wan 3.0 guide) were tested against a local mock only. Check the first real text, start-frame and reference jobs in Admin → Activity (`yotta.request` shows the exact body and Yotta's answer on failure).

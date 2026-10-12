# ArgoLink in CMM Tools

ArgoLink (https://argolink.io) resells image and video models behind one API key, billed in USD from a prepaid wallet. CMM Tools uses it as an image + video source next to the Vercel AI Gateway.

## Setup

1. Create an API key in the ArgoLink console and top up the wallet.
2. Admin → Provider → **Images + video · ArgoLink**: paste the key, keep the switch on, set **Max inflight generations** (default 3) and **Customer credits per USD** (default 6037.7, the same rate as the AI Gateway), then **Save settings**.
3. **Check saved key** reads the wallet balance (`GET /v1/usage`). **Sync live models** refreshes models and prices from ArgoLink's public catalog.
4. Per customer: Users → Sources → **ArgoLink** (on by default, like the other sources).

The key can also come from the `ARGOLINK_API_KEY` environment variable on first start.

## Models

On first start the models come from `src/provider/argolink_catalog.json` (catalog snapshot of 12 October 2026). **Sync live models** replaces them with the live catalog (`GET /api/catalog/v1/models`, public).

| Type | Models |
| --- | --- |
| Image | GPT Image 2, GPT Image 2.5 Flare, GPT Image 2.5 Sunburst, Grok Imagine Image, Grok Imagine Image 2.0, Nano Banana 2, Nano Banana 2 Lite, Nano Banana 2.1, Nano Banana Pro |
| Video | Seedance 2.5, Seedance 2.0, Seedance 2.0 Fast, Seedance 2.0 Mini, Grok Imagine Video 1.5, MiniMax H3, Wan 3.0, Wan 3.0 Prime |

Left out: Grok Imagine Image Quality (xAI retires it on 2 November 2026) and Gemini Omni (not in the public catalog). Customer model IDs start with `argo_`.

When another source offers a model with the same name (for example SmartAIPI's GPT Image 2 or Nano Banana 2), that source keeps its place and ArgoLink's copy is not shown. ArgoLink's copy is listed before the AI Gateway's. To use ArgoLink's copy, turn the model off in the other source.

## Video resolutions

Video Studio offers ArgoLink models at 720p and 1080p only: 720p is rendered at 480p and 1080p at 720p, and both are upscaled to 1080p by fal.ai (HD enhancement). See `docs/FAL_UPSCALER.md`.

## Pricing

Customer credits = ArgoLink USD price × credits per USD, rounded up.

- Images: per image by output tier (1K / 1.5K / 2K / 4K). GPT Image sizes are sent as the catalog's pixel sizes, and the ratio is also written into the prompt, as ArgoLink's guide requires.
- Video: per output second by resolution. Reference videos are billed by their length at the same rate (read from the MP4 header). On Seedance 2.5 every second is billed at 0.598 × the rate when a reference video is sent. Reference images are free.

## Requests and queue

- Images: `POST /v1/images/generations`, or `/v1/images/edits` with references sent as signed HTTPS links to the app. The answer is base64. The returned image must match the requested ratio, otherwise the job is refunded.
- Video: `POST /v1/videos/generations` → `request_id` (saved before the first poll), `GET /v1/videos/{id}` until `done`, then `GET /v1/videos/{id}/content` into database storage. `failed`/`expired` jobs are refunded with ArgoLink's reason. Seedance 2.5 and MiniMax H3 frame requests are sent with `aspect_ratio: adaptive` (the video takes the first frame's shape). Grok uses `image` / `last_frame` for frames.
- Jobs run in their own worker loop (`src/argolink_queue.js`), with the same claim, heartbeat, restart recovery and refund rules as the AI Gateway queue. A video is refunded if it has not finished after 3 hours.

## Not verified

No paid request was made from the development environment. The first real image and video jobs should be checked in the Generations tab.

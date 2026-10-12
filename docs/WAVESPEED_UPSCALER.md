# Video Upscaler (WaveSpeed)

The **Upscaler** tab upscales a video to 1080p, 2K or 4K with ByteDance Video Upscaler on WaveSpeedAI (`bytedance/video-upscaler`). It sharpens faces and text, restores colour, and removes noise and compression blur.

## Setup

1. Create an API key at wavespeed.ai and top up the wallet.
2. Admin → Provider → **Upscaler · WaveSpeed**: paste the key, keep the switch on, set **Max inflight upscales** (default 3) and **Customer credits per USD** (default 6037.7, the same rate as the other USD sources), then **Save settings**. **Check saved key** shows the wallet balance.
3. Per customer: Users → Sources → **WaveSpeed** (on by default).

The key can also come from the `WAVESPEED_API_KEY` environment variable on first start.

## For customers

- **From my videos:** any finished video from Video Studio or Cartoon Studio. Each video card also has an **Upscale** button.
- **Upload a clip:** MP4 or MOV, up to 25 MB.
- The tab lists only the user's upscales; they also appear in the Library.

## Pricing

WaveSpeed charges per second of the source video: 1080p $0.0072, 2K $0.0144, 4K $0.0288. A job is billed for at most 600 seconds. Customer credits = billed seconds × rate × credits per USD, rounded up; part seconds count as a full second. Example at the default rate: a 10-second video to 4K = $0.288 = 1,739 credits.

## How it runs

- `POST /api/upscales` (multipart: `resolution`, and `sourceGenerationId` or one `videos` file) reserves the credits and queues a `generations` row with provider `wavespeed` and mode `upscale`.
- The worker's upscale queue (`src/upscale_queue.js`) sends WaveSpeed a signed link to the source: `/provider-outputs/{id}?sig=…` for a library video, `/provider-media/{id}/0?sig=…` for an upload. It saves the prediction id, polls `GET /api/v3/predictions/{id}/result`, and downloads `outputs[0]` (up to 400 MB) into video storage.
- `failed`, `cancelled`, `timeout` or `deleted` refunds the customer with WaveSpeed's reason. A job still unfinished after 3 hours is refunded.

## Not verified

No paid upscale was run from the development environment. Check the first real job in the Generations tab.

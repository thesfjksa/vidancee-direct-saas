# Video upscaling and HD enhancement (fal.ai)

Both features use the ByteDance Video Upscaler on fal.ai (`fal-ai/bytedance-upscaler/upscale/video`). WaveSpeed was removed.

## Setup

Admin → Provider → **Upscaler + HD enhancement · fal.ai**: paste the fal API key, keep the switch on, set **Max inflight upscales** (default 3) and **Customer credits per USD** (default 6037.7), then **Save settings**. **Check saved key** confirms fal accepts the key (fal has no balance API). The key can also come from the `FAL_KEY` environment variable on first start. Customer access for the Upscaler tab: Users → Sources → **fal.ai**.

fal price (per output second, at up to 30 fps): up to 1080p $0.0072, 2K $0.0144, 4K $0.0288. Part seconds count as a full second.

## HD enhancement in Video Studio (ArgoLink)

ArgoLink video models are offered at **720p** and **1080p** only.

| Customer picks | ArgoLink renders | fal upscale |
| --- | --- | --- |
| 720p | 480p | ×1.5 to 720p (`scale_ratio`) |
| 1080p | 720p | to 1080p (`scale_ratio` 1.5) |
| MiniMax H3 720p | 768p (its smallest) | none |
| MiniMax H3 1080p | 768p | to 1080p (`target_resolution`) |

The upscale uses the `aigc` preset at 24 fps. Customer price = ArgoLink's price for the render × ArgoLink credits per USD + fal's price × fal credits per USD. Example at the default rates: Seedance 2.0, 5 s, 720p = 1,600 + 218 = 1,818 credits (rendering 720p natively would be 3,321).

Flow (`src/argolink_queue.js`): ArgoLink renders → the render is stored → fal downloads it from a signed `/provider-outputs/{id}` link → the upscaled video replaces the render and the job completes. If fal is not configured, cannot start, or fails, the job completes with the render, its message says HD enhancement could not be applied, and the upscale part of the price is refunded.

Without a fal key, Video Studio renders 720p natively and offers 1080p only on models that render it.

## Upscaler tab

Customers upscale a finished video or an uploaded MP4/MOV (up to 25 MB) to 1080p, 2K or 4K. The price comes from `POST /api/upscales/quote`; `POST /api/upscales` reserves the credits and queues a `fal` job (`src/upscale_queue.js`). A video already at or above the chosen size is refused. Failed jobs are refunded with fal's reason; a job still running after 3 hours is refunded.

## Not verified

No paid fal request was run from the development environment. Check the first HD job and the first upscale in the Generations tab.

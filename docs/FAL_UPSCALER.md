# Video upscaling and HD enhancement (fal.ai)

Both features use the ByteDance Video Upscaler on fal.ai (`fal-ai/bytedance-upscaler/upscale/video`). WaveSpeed was removed.

## Setup

Admin → Provider → **Upscaler + HD enhancement · fal.ai**: paste the fal API key, keep the switch on, set **Max inflight upscales** (default 3) and **Customer credits per USD** (default 6037.7), then **Save settings**. **Check saved key** confirms fal accepts the key (fal has no balance API). The key can also come from the `FAL_KEY` environment variable on first start. Customer access for the Upscaler tab: Users → Sources → **fal.ai**.

fal price (per output second, at up to 30 fps): up to 1080p $0.0072, 2K $0.0144, 4K $0.0288. Part seconds count as a full second.

## HD enhancement in Video Studio (ArgoLink)

ArgoLink video models are offered at **720p** and **1080p** only.

| Customer picks | ArgoLink renders | fal upscale |
| --- | --- | --- |
| 720p | 720p (768p on MiniMax H3) | none |
| 1080p | 720p (768p on MiniMax H3) | to 1080p (`target_resolution`) |

720p used to be rendered at 480p and upscaled ×1.5. The first real job (12 October 2026, Seedance, 5 s) came back at 1296×744 with mangled small text and waxy textures: a 480p render lacks the detail to rebuild, so the upscaler invents it. 720p is now always rendered natively.

The 1080p upscale uses the `general` preset, `fidelity: high` (the mildest enhancement) and 24 fps. Customer price = ArgoLink's price for the 720p render × ArgoLink credits per USD + fal's price ($0.0072/s) × fal credits per USD. Example at the default rates: Seedance 2.0, 5 s, 1080p = 3,321 + 218 = 3,539 credits.

Flow (`src/argolink_queue.js`): ArgoLink renders → the render is stored → fal downloads it from a signed `/provider-outputs/{id}` link → the upscaled video replaces the render and the job completes. If fal is not configured, cannot start, or fails, the job completes with the render, its message says HD enhancement could not be applied, and the upscale part of the price is refunded.

Without a fal key, Video Studio renders 720p natively and offers 1080p only on models that render it.

## Upscaler tab

Customers upscale a finished video or an uploaded MP4/MOV (up to 25 MB) to 1080p, 2K or 4K. The price comes from `POST /api/upscales/quote`; `POST /api/upscales` reserves the credits and queues a `fal` job (`src/upscale_queue.js`). A video already at or above the chosen size is refused. Failed jobs are refunded with fal's reason; a job still running after 3 hours is refunded.

## Not verified

No paid fal request was run from the development environment. Check the first HD job and the first upscale in the Generations tab.

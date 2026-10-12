# CMM Tools Web App

Deployed multi-user platform for video, image and voice generation, with customer accounts, a credit ledger, plan requests and a private Admin dashboard.

Documentation updated 11 October 2026, including Vercel AI Gateway image and video integration.

## Current features

- Vercel AI Gateway live image/video catalog, encrypted API credentials, per-model pricing and account access.
- CMM Tools branding, light UI and horizontal workspace navigation.
- Video generation with model-specific duration, ratio, resolution and reference controls.
- Image generation with GPT models, quality selection, vector ratio picker and a light floating preview.
- Image and video Reuse prompt, restoring owned references where retained.
- Optional asynchronous Gemini prompt enhancement with request recovery.
- Vibi-backed Voice Studio and customer-owned MiniMax voice clones.
- Persistent MySQL generation queues, transactional credit reservations and idempotent refunds.
- Manual Basic, Pro and Premium plan requests with Admin approval.
- Admin-managed encrypted provider settings, global switches and per-customer source access.

## Production deployment

| Application | URL | Entry | WORKER_ENABLED |
| --- | --- | --- | --- |
| Customer web and API | https://cmmtools.site | server.js | false |
| Standalone worker | https://worker.mehroz.online | worker.js | true |

Both Hostinger applications use `main`, the same MySQL database and the same encryption settings. `APP_URL` remains `https://cmmtools.site` on both. Use `npm run build` as the build command, and the correct entry file for each application. Keep CommonJS runtime compatibility.

Node.js 20 or later is required. Install dependencies with `npm install`. Start the web app using `npm start`; a separately configured worker uses `npm run worker`. Run automated checks with `npm test`.

Health routes are `/live` and `/health` on the web app, and `/health` on the worker. Worker health revision 5 includes independent SmartAIPI image polling and Vercel gateway polling, readiness and active task diagnostics. Recent polling timestamps matter in addition to HTTP reachability.

## Admin and billing

The private Admin interface is https://cmmtools.site/admin-console and uses `ADMIN_TOKEN`. Provider API keys and passwords are managed in Admin and stored encrypted in MySQL. Infrastructure secrets remain in Hostinger environment settings.

Pricing has source-specific rules: legacy source units use the shared multiplier, and SmartAIPI, Vercel and ArgoLink use separate direct USD-to-customer-credit factors. The SmartAIPI default is `160 / 0.0265`; a Medium 1024 x 1024 GPT Image 2 is 160 credits, and a Medium 4:5 image is 200 credits. The global 2.5 multiplier is not added to SmartAIPI or Higgsfield quotes. See the handoff and SmartAIPI document for estimates, Admin overrides and refund behavior.

Video Studio uses ArgoLink; Image Studio uses Vercel AI Gateway and SmartAIPI with ArgoLink as the out-of-credits backup; Cartoon Studio uses Vidancee, CreatePulse and vgenv; Voice Studio uses Vibi. Gemini enhancement runs in the web process. Source configuration and customer permissions determine what is available; implementation alone does not guarantee live access to every model.

## Documentation

Start with [the current project handoff](docs/PROJECT_HANDOFF.md). It covers current features, pricing, architecture, deployment, data, APIs, troubleshooting and the continuation checkpoint.

- [Hostinger deployment](docs/HPANEL_DEPLOYMENT.md)
- [Admin provider settings](docs/ADMIN_PROVIDER_SETTINGS.md)
- [SmartAIPI image integration](docs/SMARTAIPI.md)
- [Prompt enhancer](docs/PROMPT_ENHANCER.md)
- [CMM Tools UI](docs/CMM_UI_DESIGN.md)
- [Plans and credit rules](docs/PLANS.md)
- [Vidancee protocol](docs/VIDANCEE_PROTOCOL.md)
- [Changelog](docs/CHANGELOG.md)
- [Historical milestone handoff](docs/archive/PROJECT_HANDOFF_2026-10-09.md)

The archive contains superseded milestone instructions. Use the current handoff when continuing development. Real passwords, API keys, OAuth tokens, cookies and database credentials must stay outside documentation and the repository.

See [Vercel setup](docs/VERCEL_AI_GATEWAY.md) for API-key setup, the 83-model initial catalog, price overrides and current workflow limits.

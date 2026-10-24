# CMM Tools Web App

Deployed multi-user platform for video, image and voice generation, with customer accounts, a credit ledger, plan requests and a private Admin dashboard.

**Current development / incident checkpoint: 25 October 2026.** Read [the full recovery and implementation handoff](docs/PROJECT_HANDOFF_2026-10-25.md) **before deploying or modifying production**. GitHub `main` includes all changes through PR #37 (`089d08f`), but the latest Hostinger deployment for that revision **failed at cloning**; last screenshot-confirmed live web commit was `316e103`. The shared MySQL database `u449234337_saas` was **over quota (3,143 / 3,072 MB)** with denied write operations; an owner-held local SQL export and emergency selective new-database restore are **not yet verified/executed**. **No videos were confirmed deleted and Google Drive is not yet connected.** Production worker commit unknown.

The October 11 architectural documentation below is supplemented by the dated handoff and the later provider/storage docs.

## Current features

- Vercel AI Gateway, SmartAIPI and ArgoLink image catalogs; ArgoLink/Higgsfield/Sluice/vgenv and optional 888API video providers, subject to Admin switches and per-customer access.
- CMM Tools branding, light UI and horizontal workspace navigation.
- Video generation with model-specific duration, ratio, resolution and reference controls.
- Image generation with GPT models, quality selection, vector ratio picker and a light floating preview.
- Image and video Reuse prompt, restoring owned references where retained.
- Optional asynchronous Gemini prompt enhancement with request recovery.
- Vibi-backed Voice Studio and customer-owned MiniMax voice clones.
- Persistent MySQL generation queues, transactional credit reservations and idempotent refunds.
- Manual Creator (PKR 5,000 / 60,000 credits) and Studio (PKR 10,000 / 120,000 credits) purchase requests with Admin approval; custom Enterprise, legacy Basic/Pro/Premium honored for existing accounts.
- Admin-managed encrypted provider settings, global switches and per-customer source access.

## October 2026 additions

- **888API** (PRs #20–#34): model import, video/image integrations, **¥1 source cost = 1 customer credit**, per-request vs per-second tags, idempotent status polling, protected activity logs, Admin task checks, refunds and optional restricted media downloads; **disabled by default / Admin opt-in**. See [888API](docs/API888.md).
- **Google Drive** (PRs #36–#37): private Drive video output after successful OAuth connection, authenticated playback, verified background MySQL video migration, and **Admin → Storage** OAuth Client ID / Secret entry (encrypted in shared MySQL). **Not yet connected in verified production screenshots.** See [Google Drive](docs/GOOGLE_DRIVE_STORAGE.md).
- **MySQL existing-table permissions** (#35): read-only table probes avoid unnecessary CREATE attempts; quota-induced write suspension is a separate emergency.
- **Recovery:** GitHub/Hostinger clone failure + database quota need remediation **before** activating Drive migration. See [25 Oct handoff](docs/PROJECT_HANDOFF_2026-10-25.md).

## Production deployment

| Application | URL | Entry | WORKER_ENABLED |
| --- | --- | --- | --- |
| Customer web and API | https://cmmtools.site | server.js | false |
| Standalone worker | https://worker.mehroz.online | worker.js | true |

Both Hostinger applications use `main`, the same MySQL database and the same encryption settings. `APP_URL` remains `https://cmmtools.site` on both. Use `npm run build` as the build command, and the correct entry file for each application. Keep CommonJS runtime compatibility.

Node.js 20 or later is required. Install dependencies with `npm install`. Start the web app using `npm start`; a separately configured worker uses `npm run worker`. Run automated checks with `npm test`.

Health routes are `/live` and `/health` on the web app, and `/health` on the worker. Worker health includes provider polling, readiness and active task diagnostics; confirm **actual deployed revision and recent polling timestamps** rather than relying on HTTP 200 alone. Recent polling timestamps matter in addition to HTTP reachability.

## Admin and billing

The private Admin interface is https://cmmtools.site/admin-console and uses `ADMIN_TOKEN`. Provider API keys and passwords are managed in Admin and stored encrypted in MySQL. Infrastructure secrets remain in Hostinger environment settings.

Pricing has source-specific rules: legacy source units use the shared multiplier, and SmartAIPI, Vercel and ArgoLink use separate direct USD-to-customer-credit factors. The SmartAIPI default is `160 / 0.0265`; a Medium 1024 x 1024 GPT Image 2 is 160 credits, and a Medium 4:5 image is 200 credits. The global 2.5 multiplier is not added to SmartAIPI or Higgsfield quotes. See the handoff and SmartAIPI document for estimates, Admin overrides and refund behavior.

Video Studio uses ArgoLink, Higgsfield (Wan 3.0) and MiniMax H3 on vgenv; Image Studio uses Vercel AI Gateway and SmartAIPI with ArgoLink as the out-of-credits backup; Cartoon Studio uses vgenv (MiniMax H3); Voice Studio uses Vibi. Gemini enhancement runs in the web process. Source configuration and customer permissions determine what is available; implementation alone does not guarantee live access to every model.

## Documentation

Start with [the current project handoff](docs/PROJECT_HANDOFF.md). It covers current features, pricing, architecture, deployment, data, APIs, troubleshooting and the continuation checkpoint.

- [Hostinger deployment](docs/HPANEL_DEPLOYMENT.md)
- [Admin provider settings](docs/ADMIN_PROVIDER_SETTINGS.md)
- [SmartAIPI image integration](docs/SMARTAIPI.md)
- [Prompt enhancer](docs/PROMPT_ENHANCER.md)
- [CMM Tools UI](docs/CMM_UI_DESIGN.md)
- [Plans and credit rules](docs/PLANS.md)
- [Changelog](docs/CHANGELOG.md)
- [Historical milestone handoff](docs/archive/PROJECT_HANDOFF_2026-10-09.md)

The archive contains superseded milestone instructions. Use the current handoff when continuing development. Real passwords, API keys, OAuth tokens, cookies and database credentials must stay outside documentation and the repository.

See [Vercel setup](docs/VERCEL_AI_GATEWAY.md) for API-key setup, the 83-model initial catalog, price overrides and current workflow limits.

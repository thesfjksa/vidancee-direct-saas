# CMM Tools Web App

Deployed multi-user platform for video, image and voice generation, with customer accounts, a credit ledger, plan requests and a private Admin dashboard.

**Historical 25 October checkpoint (superseded for current operation).** Start with [the comprehensive, updated recovery and implementation handoff](docs/PROJECT_HANDOFF_2026-10-25.md) before production work. GitHub `main` includes 888API PRs **#43–#45**, checkpoint `f82b02c0` ([281 passing post-merge tests](https://github.com/thesfjksa/vidancee-direct-saas/actions/runs/40170975215)). The owner-provided read-only 888API audit confirmed **64 live account-returned IDs, 115 saved historical IDs, 0 missing imports, 27 implemented at that pre-upgrade snapshot**. The exact-account **Seedance 2.5 G5-V2** model is now in code for **30 image + 10 video + 10 audio inputs**, 720p, 5–30s, **¥7 / 7 credits per request**. Its G5-specific upstream request body still requires a controlled paid validation. **GitHub merges do not prove a live Hostinger web/worker deployment, database recovery or real video generation**: the previous screenshots showed a clone failure and MySQL **3,143 / 3,072 MB** quota problem. Verify again rather than assuming those historical problems persist or are fixed. Preserve the owner's SQL backup and financial records.

**Current operational checkpoint: 6 November 2026.** Start with [the new full handoff](docs/PROJECT_HANDOFF_2026-11-06.md). GitHub `main` includes the AIVID Premium integration and customer visibility fix through PR #145 (`7759a443`), with Windows agent v2.1.0 and all related CI checks passing. Customer-visible Premium models require AIVID to have been configured and customer source access granted. They stay listed but are unavailable when offline or disabled; the actual paid service still needs Hostinger deployment, live connection and model-specific successful generations to be verified. The older 25 October checkpoint above and below is retained solely for incident history; do not treat its commit, prices or pending items as current.

The October 11 architectural documentation below is supplemented by the dated handoffs and later provider/storage docs.

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

- **888API** (PRs #20–#45): key-scoped catalog audit/import, video/image adapters including Seedance 2.5 **G5-V2 three-media references**, **¥1 source cost = 1 customer credit**, protected polling/media downloads, exact per-model reference controls, model-level **disabled-by-default-on-new-support** Admin opt-in and per-customer access. **The owner reported the global provider source ON** in the last Admin audit; do not silently change it. No end-to-end paid G5-V2 result verified. See [888API](docs/API888.md).
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

Start with [the current 6 November project handoff](docs/PROJECT_HANDOFF_2026-11-06.md) for the AIVID Premium source-control checkpoint, model visibility fix, deployment checklist and live verification boundary. The [25 October handoff](docs/PROJECT_HANDOFF_2026-10-25.md) and [original project handoff](docs/PROJECT_HANDOFF.md) retain earlier incident and architectural history.

- [Cloud storage (Cloudflare R2)](docs/CLOUD_STORAGE.md)
- [Hostinger deployment](docs/HPANEL_DEPLOYMENT.md)
- [Admin provider settings](docs/ADMIN_PROVIDER_SETTINGS.md)
- [SmartAIPI image integration](docs/SMARTAIPI.md)
- [Prompt enhancer](docs/PROMPT_ENHANCER.md)
- [CMM Tools UI](docs/CMM_UI_DESIGN.md)
- [Plans and credit rules](docs/PLANS.md)
- [Customer API, developer keys and deployment migration](docs/CUSTOMER_API.md)
- [Changelog](docs/CHANGELOG.md)
- [Minimax Beast (vgenv Origin Quality model)](docs/MINIMAX_BEAST.md)
- [Historical milestone handoff](docs/archive/PROJECT_HANDOFF_2026-10-09.md)

The archive contains superseded milestone instructions. Use the current handoff when continuing development. Real passwords, API keys, OAuth tokens, cookies and database credentials must stay outside documentation and the repository.

See [Vercel setup](docs/VERCEL_AI_GATEWAY.md) for API-key setup, the 83-model initial catalog, price overrides and current workflow limits.

# AIVID browser pilot

Choose **Windows RDP** in **Admin → Provider → AIVID connection**, save settings,
and generate a pairing code for the portable Windows agent. Sign in manually
with `AIVID-Login.exe`, close its Chrome windows, then start `AIVID-Agent.exe`.
The agent uses your existing RDP and sends work over outbound HTTPS.
See [docs/AIVID_RDP.md](docs/AIVID_RDP.md) for setup and recovery.
The optional [Browserless transport](docs/AIVID_BROWSERLESS.md) remains available
with its key saved in Admin. Customer catalog registration now exists for the three AIVID Premium models. A configured source remains visible in Video Studio if it goes offline, but paid Generate stays blocked until Admin enables the source, sets a source-credit ceiling and the agent/session is ready. **Production deployment, actual paid model-specific AIVID generations and live reference uploads have not been verified.**


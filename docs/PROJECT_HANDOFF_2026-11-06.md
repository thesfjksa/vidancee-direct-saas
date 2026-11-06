# CMM Tools — current project / AIVID Premium handoff
**Checkpoint:** 6 November 2026 (Asia/Karachi)  
**Repository:** [thesfjksa/vidancee-direct-saas](https://github.com/thesfjksa/vidancee-direct-saas), private, default branch \`main\`  
**Last feature/fix code checkpoint inspected:** \`7759a443284590cac7fe7dc5888d6837f1dafeaf\` (PR #145). Documentation commits after this checkpoint do **not** imply any production change.

> **Read this before work on CMMTools.** This is the current handoff and supersedes the *status and next-step* guidance in \`PROJECT_HANDOFF_2026-10-25.md\` and \`PROJECT_HANDOFF.md\`. Those files remain useful for history, architecture and old incidents. The GitHub code is the authority for current model mappings and prices. Never infer that merging to GitHub deployed either Hostinger application.

## 1. Release state, known vs unverified

| Area | Verified in repository | Still NOT verified |
| --- | --- | --- |
| AIVID 2.0 Mini, 2.0, 2.5 Premium models | Model registry, Video Studio catalog, Admin customer access and quote/queue routing merged | Successful paid *live* generation, references, source price and output for each individual model |
| AIVID customer visibility | PR #145 keeps choices visible for a *configured* AIVID provider even if RDP becomes offline; disabled model shows Unavailable and disables Generate | Whether Hostinger deployed #145, customer refresh and Admin permissions on the affected live account |
| Public visibility | Browser form sets Public **before reading price** and outgoing generation request guard checks Public | Current live AIVID page/selector/API compatibility across all three models |
| Wallet and queue | Read-only preflight, credit reservation, price/cost limits, refund-before-click and held/manual reconciliation of ambiguous paid clicks | Live price parity, 24/7 worker/RDP reliability, actual provider acceptance and media playback |
| Windows agent | Full portable v2.1.0 ZIP built and Windows/Node/MySQL CI passed (PR #143) | Installed v2.1.0 on the owner's RDP, paired and active against production, or live source credits available |
| Existing 888API and other sources | No intentional migration or removal by the AIVID PRs; existing providers retain their routes | Current provider account balances, production imports and live model availability |
| Infrastructure | GitHub \`main\` includes patches | Hostinger web and worker deployment revision, MySQL write capacity, connected media storage |

**Important user-reported symptom, 6 Nov:** *“no aivid model has shown yet on user end”*. The cause **found in source** was a readiness gate that omitted all AIVID models when the RDP heartbeat went stale, source was disabled or max source credits were zero. PR #145 changes visibility for a *configured source*. The exact cause of the owner's **live** UI symptom was not observed in production, and may additionally be stale Hostinger deployment or a customer-level source switch. Do not describe it as proven fixed on the live website.

## 2. November 6 source-control chronology

| PR / issue | Merged commit / status | What changed |
| --- | --- | --- |
| [#141](https://github.com/thesfjksa/vidancee-direct-saas/pull/141) | \`a4e198629caa651051e80afd8eef152a61975617\` | Force **Public** AIVID visibility before quoting and generating; independently verify submission privacy |
| [#142](https://github.com/thesfjksa/vidancee-direct-saas/issues/142) | Integration tracking issue; inspect current status | Three Premium models, model-specific preflights, billing, RDP, tests, outstanding live acceptance |
| [#143](https://github.com/thesfjksa/vidancee-direct-saas/pull/143) | \`14b694a871a5af82090f6660fd4a24a36662c386\` | AIVID models become first-class customer Video Studio entries, Admin source grants, Public-mode live quote, queue handling, full RDP v2.1.0 packaging, automated tests |
| [#144](https://github.com/thesfjksa/vidancee-direct-saas/pull/144) | \`570d0d613e5342ae3846956c88f646e96a33a0ef\` | Prevent RDP price checks from blocking public Pricing page; show customer warning about Public visibility |
| [#145](https://github.com/thesfjksa/vidancee-direct-saas/pull/145) | \`7759a443284590cac7fe7dc5888d6837f1dafeaf\` | Keep configured AIVID models visible offline/disabled with Unavailable warning; disable paid Generate; tests |

PR #143 passed **four** relevant CI checks (Node, admin browser, MySQL RDP, Windows package). PR #145 passed **three** checks (Node, MySQL RDP, Windows package). The Windows agent package was produced by GitHub Actions [run 42209575242](https://github.com/thesfjksa/vidancee-direct-saas/actions/runs/42209575242), artifact **\`aivid-rdp-agent-windows\`**, artifact ID \`13497413369\`, package version **2.1.0**. Artifacts are retained only for a limited period: if expired, rebuild using the workflow; never download an old 2.0.5 agent and assume it contains the Premium model registry.

The separate 888API Seedance 2.5 dynamic-model changes in preceding commits (including #139 and #140) are unrelated to AIVID IDs and pricing. Do not confuse AIVID 2.5 with 888API's various 2.5 SKUs. Other older model/price claims in October handoffs can have been superseded; read current \`src/api888_models.js\`, \`src/billing.js\` and \`docs/CHANGELOG.md\` first.

## 3. AIVID customer model contract (source-level, NOT live-certified)

| Customer UI | Public ID | Current adapter ID | Source-defined candidate range |
| --- | --- | --- | --- |
| Seedance 2.0 (Mini) · Premium | \`aivid_seedance_2_0_mini\` | \`seedance-2.0-mini\` | 4–15 seconds |
| Seedance 2.0 · Premium | \`aivid_seedance_2_0\` | \`seedance-2.0\` | 4–15 seconds |
| Seedance 2.5 · Premium | \`aivid_seedance_2_5\` | \`seedance-2.5\` | 4–30 seconds |

Current local adapter **advertises** 480p/720p, aspect ratios 16:9 / 9:16 / 1:1, optional reference media (image/video/audio) and different per-model maxima (\`src/aivid_models.js\`). **These are provisional source-code limits, not independent proof of what the live account currently supports.** AIVID may offer different max durations, model names, UI selectors or request fields. Live preflight and request guards fail closed on mismatch. Validate model by model before offering paid access broadly.

AIVID is a **separate provider** from 888API, Sluice and vgenv. The vgenv \`seedance_2_0_mini\` **CMM Mini** alias is not the AIVID model \`aivid_seedance_2_0_mini\`. Do not replace either provider's model IDs, merge their billing currencies or rewrite historical jobs.

### Model visibility vs paid readiness

- Server: \`server.js\` → \`sourceMediaCatalog()\` → \`src/aivid_settings.js\` → \`src/aivid_models.js\` → \`customerCatalog(config)\`; per-customer \`user_provider_access.aivid\` is honored.
- \`aividConfigured(config)\` is true when AIVID is enabled **or** a paired RDP device exists **or** a saved Browserless connection exists. For customers assigned the source, all three Premium models then remain **listed** even when the agent drops offline, the source is paused, or the ceiling becomes zero. A never-configured source does not insert three unrelated choices.
- \`aividReady(config)\` additionally checks the Admin enabled flag, positive \`maxSourceCredits\`, and transport session/heartbeat. Unready models have \`unavailable: true\`, a warning, an **Unavailable** price and a disabled Generate button in \`public/index.html\`.
- There is a subtle status difference: the *catalog* currently treats an online RDP heartbeat status \`busy\` or \`ready\` as available, but the *worker* admits **new** paid submits only with status \`ready\`. Busy pricing or submissions can therefore be deferred/rejected temporarily. This is a non-paid reliability edge to revisit if reported.
- If an individual customer's AIVID source access is explicitly false, the models **do not** appear for that customer. Admin → Users → Manage → Model sources → AIVID Premium.
- \`GET /api/config\` builds the Video Studio \`pricing\` list from MySQL settings and customer access. A GitHub merge, admin connection badge or RDP login alone cannot guarantee models appear in a previously deployed website.

### Pricing, charging and fail-closed protections

- Admin → Provider → AIVID chooses \`rdp\` vs \`browserless\`, \`enabled\`, \`maxSourceCredits\`, and \`customerCreditsPerSourceCredit\`. The conversion factor's **code default is 480 CMM customer credits per one AIVID source credit**; this is an **owner-adjustable initial assumption, NOT verified actual AIVID source cost**. Confirm the real economics before enabling paid customers.
- \`quoteAivid()\` requests a read-only preflight against the signed-in AIVID page **after selecting Public**, obtains the displayed AIVID **source credit** price, enforces a positive ceiling, and converts to customer credits. Normal per-user markup/price-rate then applies in billing. Do **not** interpret AIVID credits as 888API CNY or assume 1:1 conversion.
- Customer cost endpoint: \`POST /api/model-cost\`. Submit path: \`submitVideoGeneration()\` → \`createGenerationForUser()\` → provider \`aivid\` → \`AividQueue\`. The server reserves wallet credits transactionally; the worker validates AIVID's **actual** observed source price against the saved \`quotedSourceCredits\` and current ceiling before clicking Generate. If it changed **before the click**, the local job is refunded instead of silently charging more.
- The browser enforces Public in both visible toggle and outgoing guarded mutation; checks that the job/model/inputs match; permits **one** expected \`POST /v2/generations\` after a durable reservation; unexpected mutating requests are blocked. **No silent automatic repeat** of a possibly paid submit.
- If outcome after reservation/click is uncertain, the queue **holds** the job for manual verification against real AIVID account history. Admin reconciliation may attach a **verified existing** provider ID or refund only when *non-submission is confirmed*. Do not delete agent receipts or force-refund ambiguous provider jobs.
- Source preflight typically does not upload all of the customer's selected references before showing an estimate. Reference-sensitive costs and model support therefore remain **acceptance-test items**; never promise an exact payable price or fully tested multimodal support from the catalog alone.
- Public generation may mean the upstream video is discoverable by other AIVID users; the customer warning is intentional. Do not change it to Private merely to hide the AIVID provider.

## 4. Deployment + rollout runbook (not executed or verified here)

| Service | URL | Hostinger entry | Required setting |
| --- | --- | --- | --- |
| Customer web, API and admin | https://cmmtools.site | \`server.js\` | \`WORKER_ENABLED=false\` |
| Independent generation worker | https://worker.mehroz.online | \`worker.js\` | \`WORKER_ENABLED=true\` |
| Owner's Windows RDP | Owner-managed Windows host | \`AIVID-Agent.exe\` | Paired, signed into AIVID, running with dedicated Chrome profile |

**Release sequence:**
1. Preserve the current private repository, live database export, balance/ledger and \`SETTINGS_ENCRYPTION_KEY\`; do not alter secrets or customer rows just to make the model picker populate. Older Hostinger clone and over-quota MySQL observations in the October handoff are **historical and not independently rechecked** in this release.
2. In Hostinger hPanel **redeploy both services** from current GitHub \`main\`, not only the web or only the worker. Check both deployments' *actual Git commit*, current \`/live\`, \`/health\`, logs and MySQL write health. \`/health\` 200 or GitHub CI alone does not prove deployed revision, provider login or generation.
3. On the RDP use the complete **AIVID Agent 2.1.0** package from the GitHub Actions artifact (rebuild after expiry). **Stop** the existing agent before replacement. Preserve \`.aivid-agent.json\`, \`.aivid-rdp-profile\`, \`receipts/\` and any pending-job history; extract the whole new package without wiping them. Sign in with \`AIVID-Login.exe\` and start \`AIVID-Agent.exe\` once. Only one agent/browser should drive the dedicated profile.
4. Admin → Provider → AIVID: choose Windows RDP, Save, pair if not already paired (one-time code), verify status \`ready\` and a fresh heartbeat. Configure \`maxSourceCredits > 0\`, review the Admin conversion factor, and enable jobs only when appropriate. A source ceiling of 0 prevents paid submissions.
5. Admin → Users → relevant customer → **Model sources**: verify **AIVID Premium** is ON. This grant is independent of 888API and of the global AIVID switch.
6. Refresh the signed-in Studio with Ctrl+Shift+R. Verify all 3 distinct AIVID IDs under Video Studio, Premium labels, duration/ratio controls and visible status. When offline they should be displayed but disabled; when online and enabled, price requests may run. Do not use a public pricing-page appearance as proof of provider readiness (those AIVID models are intentionally excluded from the public pricing examples).
7. Conduct controlled **read-only** Admin \`/admin/aivid/check\` preflight on Mini, review balance, Public and quote; no Generate click during read-only checks. The initial Admin Check is Mini-specific; model-level UI quote preflights check the other model IDs.
8. With explicit owner authorization for any **paid** request, execute one low-cost video per model, checking actual selection, real source credits, prompt, duration, Public, upstream job ID, polling, MP4 download/storage, customer wallet delta, refund/idempotency and credit ledger; then separately test each supported reference mode. Refuse/halt on unknown selector, schema or surprising price.
9. After acceptance, monitor multiple queued jobs, agent outage, worker restart and pending-receipt reconciliation. No auto-retry after an ambiguous click. Only then describe live paid generation as operational.

**No Hostinger/RDP production access, live redeploy or paid video was performed during the GitHub merges and this handoff.** The next owner/operator must record real deployed commit and proof of a successful generation here before changing that statement.

## 5. Missing AIVID models — exact triage

First check whether \`main\` **and both Hostinger applications** are at least \`7759a443\` (or a later revision containing #145). Previous GitHub commits \`14b694...\` and \`570d0d...\` still had the readiness-based **disappearance** bug.

1. **All three missing:** review \`/api/config\` (as the affected logged-in user), the \`pricing\` array for IDs starting \`aivid_\`, \`catalogError\`, and \`providerAccess.aivid\`. If provider access is false, change the customer's Admin Models sources grant. If the source was **never configured**, pair an RDP or save the browser connection; source code deliberately does not list never-configured providers. If access/config are correct but no IDs appear, check the actual deployed revision and server logs for \`catalog.config_failed\` / \`catalog.source_failed\`.
2. **IDs present in config but absent from picker:** hard-refresh /app; inspect stale JS/HTML, browser cache/service worker, and authenticated session. \`renderConfig()\` uses \`config.pricing\` directly to populate \`#model\`.
3. **IDs visible but Unavailable:** Admin enabled flag, positive source-credit ceiling, latest RDP heartbeat \`ready\` (or browserless valid session), and agent running. Do not bypass readiness just to allow paid clicks.
4. **Quote says busy or times out:** RDP/source advisory lock held by other work, agent not responding, disabled global paid submissions, mismatched model form or source price. There is no safe automatic retry of a paid request.
5. **Submission held for review:** compare \`receipts/\` with the exact AIVID account-history job, then use the protected Admin reconcile endpoint. Do not start a replacement paid request for that job.

Safe browser-console diagnostic **while signed in** (reports only model metadata, no credentials):
\`\`\`js
fetch('/api/config', { credentials: 'include' })
  .then(r => r.json())
  .then(c => console.table({
    catalogError: c.catalogError,
    aividAccess: c.providerAccess?.aivid,
    modelIds: (c.pricing || []).filter(m => m.id.startsWith('aivid_'))
      .map(m => ({ id: m.id, ready: m.ready, unavailable: m.unavailable })),
  }));
\`\`\`

## 6. Major project inventory + preservation obligations

Existing core platform: account/password login, manual plans and Admin approval, wallet/ledger, access assignments, prompt/reference-aware Video/Image/Cartoon Studios, Vibi Voice Studio, personal library, worker/polling/refunds, R2/cloud media storage and optional Drive migration, per-provider Admin source switches, 888API dynamic catalog, ArgoLink, Higgsfield, Sluice, vgenv MiniMax, Vidancee, fal.ai image/upscaler, SmartAIPI, Vercel and Gemini prompt enhancement. Refer to the code and individual source docs for active support and pricing; this is **not** a claim every integration is live or funded.

**Non-negotiable preservation:** keep customer accounts, \`users.credits\`, plan purchases/approvals, \`credit_transactions\`, generation states, media ownership, encrypted \`app_settings\`, password/auth credentials, model source grants, existing 888API jobs and AIVID receipts. Web and worker must use the *same* DB and encryption root. Never overwrite the MySQL database, rotate a key without migration, empty paid queues or re-submit an uncertain provider request just to recover a deployment.

**Historical unresolved infrastructure evidence (not reconfirmed today):** earlier Hostinger private-repo clone failure, MySQL 3,143/3,072 MB quota / denied writes and Google Drive not connected; see 25 October handoff. Treat as hypotheses until an operator checks current hPanel and database state.

## 7. Developer pointers and acceptance gate

| File | What to inspect |
| --- | --- |
| \`server.js\` | \`/api/config\`, source/customer catalog, \`/api/model-cost\`, video submit, Admin status |
| \`src/aivid_models.js\` | AIVID public/provider IDs, advertised capabilities, visibility/readiness, live quote |
| \`src/aivid_settings.js\` | RDP/Browserless, source ceiling, credit-conversion configuration |
| \`src/provider/aivid.js\` | Model selection, Public toggle, form validation, guarded outbound POST, download |
| \`src/aivid_queue.js\` | MySQL source lock, actual-price check, charged-job creation, hold/refund/reconcile |
| \`src/aivid_rdp.js\`, \`src/aivid_rdp_http.js\` | Pairing, device heartbeat, command relay, signed reference/content integrity |
| \`scripts/aivid-rdp/\` | Full Windows portable runtime, DPAPI pairing, local receipts and ZIP builder |
| \`public/index.html\`, \`public/admin.html\`, \`public/aivid-admin.js\` | Studio dropdown/disabled state, user entitlement, source configuration |
| \`src/api888_models.js\`, \`src/provider/api888.js\`, \`src/billing.js\` | Distinct 888API models/price rules; do not cross-wire to AIVID |
| \`test/aivid_models.test.js\`, \`test/aivid_visibility.test.js\`, \`test/aivid_rdp*.test.js\` | No-model disappearance regression, source controls and durable RDP flows |
| \`docs/HPANEL_DEPLOYMENT.md\`, \`docs/AIVID_RDP.md\`, \`scripts/aivid-rdp/README.md\` | Deployment and RDP setup details |

**Acceptance for declaring customer availability:** both actual production service revisions verified; DB read/write healthy; Admin configured and customer source allowed; AIVID agent online; all 3 models visible; real non-paid preflights pass; **one authorized successful paid generation per model** with video saved/downloadable, correct wallet/ledger entries and no unexpected or duplicate AIVID charge. Record proof and timestamps without secrets.

**Continuation instruction for the next developer:** read current GitHub \`main\` and this document, inspect outstanding issue #142 and production evidence, preserve all working providers and records, resolve deployment/visibility first, then carefully validate each AIVID model using safe read-only probes before *owner-authorized* paid tests. Keep this handoff, changelog and operator runbooks updated with new PRs, actual deploys and verification boundaries.

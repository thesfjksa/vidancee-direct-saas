# CMM Tools — comprehensive implementation and recovery handoff
**Checkpoint: 25 October 2026 (Asia/Karachi). Documentation only; no production operation executed by this handoff.**

> **READ THIS FIRST.** This file supersedes the stale 11 October checkpoint at `docs/PROJECT_HANDOFF.md` for subsequent production/recovery work. Old documents describe earlier implementations and are historical unless cross-checked against current `main`. The last GitHub source revision verified while preparing this handoff is **`089d08fb86a818cdcaf495d3d6997967b18eb1f7`** (PR #37, merged 24 October UTC). **GitHub source being merged ≠ code actually running in Hostinger.**

## A. Current, verified operational condition — urgent

**P0: Production MySQL quota exceeded; application reliability is compromised.**

- Hostinger hPanel screenshot: database `u449234337_saas` uses **3,143 MB / 3,072 MB**, about **71 MB beyond** the per-database allowance. Two separate databases, `u449234337_ai` and `u449234337_cmmtools`, showed **~1 MB** each; they were not shown to contain the active app data. Do **not** mistake either for a pre-existing application replacement.
- The active database is shared between `cmmtools.site` and `worker.mehroz.online`. Screenshots show errors including `CREATE command denied` on `app_settings`, and phpMyAdmin **MySQL error 1142, UPDATE denied** on `credit_transactions`. Hostinger's database-user permissions UI nonetheless showed SELECT/INSERT/UPDATE/DELETE/CREATE checked. This mismatch is **consistent with Hostinger restricting writes after quota exhaustion**, rather than necessarily missing permission checkboxes; verify against the live service and Hostinger's policy. The cleanup SQL **stopped on its very first UPDATE**, so there is no evidence that any of its DELETE steps executed.
- The owner stated they **already downloaded/exported the entire database to their local computer**. Backup filename, integrity, size, compression and restoration viability **have not been verified**; this is not a license to delete the original. Preserve a separate untouched copy before any destructive action. Never ask for raw customer records, database passwords, service keys or provider secrets in chat.
- Admin → Storage, on the **last confirmed successful deployment**, showed **106 MySQL video outputs totaling about 1.07 GiB**, **0 videos on Google Drive**, `Not connected`, `Migration: Paused` and `Default for new videos: MySQL`.
- A proposed **emergency restore to a new separate MySQL database**, importing only essential data from the local export and leaving behind video blobs, was explained to the owner; **it has NOT been executed or verified**. No live database tables have been deleted by the assistant. No new DB connection has been configured through the assistant.
- **P0: Source deployment broken separately.** Hostinger screenshot: web deployment for **`089d08f` failed at “Cloning repository”**, before dependencies/install/build. The last screenshot-confirmed **Completed / Current** web deployment was **`316e103`** (PR #36), as of 24 October 2026. A prior build at `d6e4046` also showed failure. A Hostinger GitHub App installation screenshot showed **“All repositories”** allowed, and the private repository was reachable through ChatGPT's separate GitHub connection. Thus **Hostinger's repository clone authorization/fetch is unresolved**, even though the app appears installed with broad repo access. Do not claim it is fixed or that latest code is deployed. Web and standalone worker may be at **different revisions**; **worker revision unknown**. Hostinger build is `npm run build` (no actual bundle step); client/worker use Node 20+.
- The current GitHub head includes the **Admin-managed Google OAuth key entry form** (PR #37), but it **does NOT appear in the last live Admin screenshot** because the clone of that commit failed. The owner will not find those fields until the web deployment succeeds. Do not tell them to enter Google keys in Hostinger env variables; the latest code supports encrypted Admin entry. **OAuth credentials were not saved or connected**, and no Drive migration was performed.
- A Google Cloud project for CMM Tools was configured, External audience and Testing status shown, a Google OAuth Web Client created, and an **OAuth Client Secret was visible in a screenshot/chat**. Treat that secret as compromised. **Rotate/revoke it and enter only the replacement through the deployed Admin form**. Do not copy client ID, secret, API keys or emails into repository docs. The user’s Google OAuth consent/production readiness is **unverified**.
- **No live production cleanup, restore, OAuth consent, Google Drive upload/migration or Hostinger redeploy has been performed from this GitHub documentation session.** GitHub pull-request tests are mocked and do not prove live external API/storage behavior.

### Fastest safe recovery sequence (operator action; none completed yet)

1. Preserve the **full local SQL export** and create another safety copy. Confirm it can be read and that it contains user/settings/financial tables. Record table names, foreign keys, backup date and whether the dump contains `CREATE DATABASE` / `USE` statements. Treat the export as sensitive private customer data.
2. Keep `u449234337_saas` unchanged; do not DROP the database, remove all tables, disable foreign-key checks, wipe `credit_transactions` or reset Admin encryption settings. Current database exceeds the 3,072 MB limit and writes may be blocked by Hostinger. Because user explicitly agreed that video generations are expendable, **only video media and terminated video jobs** are candidates for deletion, after backup and proper write access are confirmed. **Do not cancel/delete queued, submitted or processing paid jobs without settling/reserving/refunding credits.**
3. If an immediate return to service is needed and Hostinger keeps the original read-only, **create a separate fresh MySQL database in Hostinger** with enough remaining quota and restore essential data **selectively**, omitting bulky historical video BLOB tables, then switch the web and worker DB variables together. The prior suggested minimal tables were `users`, `app_settings`, `provider_models`, `user_provider_access`, `plan_requests` and `user_voice_clones`. **Important qualification:** this minimal restore deliberately omits historical credit ledger entries, sessions, media, OAuth connections and generation history, and may not be appropriate for production financial/audit retention. Prefer also preserving `credit_transactions` (with generation references reconciled), plus any needed plan/audit records, if possible and compliant. Investigate import order/foreign keys with a test restore; do not import a full >3 GB backup into another 3 GB database. If skipping `sessions`, users must sign in again. Restore core schema safely, not merely rows from six tables; confirm `users.credits`/`plan_code`, payment approvals and transaction consistency. Keep the same `SETTINGS_ENCRYPTION_KEY` (or compatible encryption root/`ADMIN_TOKEN`) across both apps or saved provider secrets will be unreadable.
4. Hostinger database env names: `DB_HOST`, `DB_PORT` (default 3306), `DB_USER`, `DB_PASSWORD`, `DB_NAME`. The actual hostname/port must come from Hostinger, **not assumed**. Web uses `server.js` and `WORKER_ENABLED=false`; worker uses `worker.js` and `WORKER_ENABLED=true`; both share `APP_URL=https://cmmtools.site` and the same new DB/config. Restart/redeploy appropriately after updating values. Test sign-in, accounts, plans, correct credit balances and refunds, Admin credentials, ability to perform a tiny safe write, video/image catalogs, worker `/health` and actual fresh queued job pickup before declaring recovered.
5. Recover Hostinger's **private GitHub clone integration** separately (inspect deployment “Cloning repository” logs, application/repo selection, reauthorization or Hostinger support). Merely increasing DB capacity does not repair git cloning. Reapply no secrets in GitHub. Deploy **`089d08f` or later** to **both** independent apps. Confirm actual deployed revision via Hostinger deployment record and `/live` timestamps. Do not trust a recent GitHub merge as evidence of deployment.
6. Only after the app is writable and the newer web/worker deployment is confirmed, rotate the exposed Google secret, enter Google Client ID and **replacement secret** in Admin → Storage, click **Save Google credentials securely**, then **Connect Google Drive** and approve the Google account. Verify connected/access before enabling/continuing migration. The current code starts historical migration on the standalone worker after consent and checks Drive size/checksum before deleting database chunks.
7. Monitor database quota throughout; deleting InnoDB rows does **not guarantee an immediate reduction in Hostinger's accounted physical footprint**. `OPTIMIZE TABLE` may itself need extra space and DDL rights; do not run blindly on a full database. If writes are blocked, ask Hostinger for a quota grace period/upgrade or use a tested selective restore instead.

### Next operator/developer verification checklist

- [ ] Local SQL backup checked and protected; test a restore into a disposable DB.
- [ ] Old DB quota and DML permissions reconfirmed (do not infer from grants checkbox alone).
- [ ] Select the recovery mode: selective new DB (fastest without Hostinger write relief) vs DB quota relief plus cleanup.
- [ ] Reconcile accounts/credit balances/refunds and audit requirements in restored DB.
- [ ] Hostinger repo clone fixed; web and worker updated to matching commit.
- [ ] Google OAuth client secret rotated; Google Drive API enabled, External testing consent user/access verified.
- [ ] Admin Storage has actual Client ID/Secret entry form; credentials saved encrypted; Google consent works.
- [ ] New video saves use Drive; customer playback/range/permissions tested, and MySQL BLOBs do not grow.
- [ ] Existing videos migrated/confirmed or explicitly discarded by owner, never silently “recovered”.
- [ ] Re-evaluate risky 888API MiniMax source models before customer re-enablement.

## B. Repository, architecture and current application features

| Item | Confirmed source / role |
| --- | --- |
| Repo | Private GitHub `thesfjksa/vidancee-direct-saas`, default `main` |
| Last GitHub head before this documentation | `089d08fb86a818cdcaf495d3d6997967b18eb1f7` (#37) |
| Web | `https://cmmtools.site`; `server.js`; Hostinger Node app |
| Admin | `https://cmmtools.site/admin-console`; `ADMIN_TOKEN` |
| Worker | `https://worker.mehroz.online`; `worker.js`; separate Hostinger Node app |
| DB | Shared MySQL, currently `u449234337_saas` until explicitly switched |
| Runtime | Node.js >=20, CommonJS; `npm start`, `npm run worker`, `npm test`; build prints “No build step required” |
| App callback | `https://cmmtools.site/admin/google-drive/callback` |
| Health | Web/worker `/live` and `/health`; HTTP 200 alone is not proof of functioning provider jobs |
| Account storage | MySQL users, sessions, plans, manual plan requests, credit ledger, source access, queued jobs |
| Providers | ArgoLink, Higgsfield Wan, Sluice Lite, vgenv MiniMax H3, SmartAIPI, Vercel AI Gateway, fal.ai upscaling, Vibi voice, optional Gemini enhancer, optional 888API |
| Claude integration | Customer-facing MCP endpoint `https://cmmtools.site/mcp` (NOT the GitHub/ChatGPT connection) |
| Design | Light UI, blue/turquoise branding, horizontal responsive navigation, Video/Image/Cartoon/Voice/Library workspaces |

Current `src/plans.js` public plans: **Creator PKR 5,000 / 60,000 credits / 3 simultaneous** and **Studio PKR 10,000 / 120,000 credits / 5 simultaneous** plus custom-contact Enterprise. Legacy Basic, Pro and Premium are honored for existing accounts **but no longer sold publicly**. Purchases are **manual requests with Admin approval**; no recurring billing or automatic checkout. `docs/PLANS.md` contained a stale 11 October plan table until this handoff work. CMM credits and refunds are separate from provider charges. Provider API keys are saved encrypted in MySQL Admin settings, not the browser.

Source of truth: use **current code and Git HEAD** for prices, model support and switches. 11 October handoff references to retired Vidancee/CreatePulse, Yotta, old Higgsfield lifecycle, older plan names and provider models are superseded. References uploads support image/video/audio roles and @ mentions; video with supported audio models generates audio by default (PR #19).

## C. Implementation history — **merged code**, not necessarily deployed

### 20 October 2026, prior stage
- **#16 `96c4b84`**: removed Vidancee and CreatePulse provider paths after refusal/unavailability.
- **#17 `9681f3d`**: introduced Sluice for Seedance Lite.
- **#18 `2d184e3`**: expanded Admin user plan/credit/generation management.
- **#19 `2be9694`**: server automatically includes audio when selected model supports it.
- Prior related commits include Higgsfield Wan replacing Yotta, ArgoLink/Higgsfield video reference handling, @mentions, fal upscaling, 50,000-character prompt limits and pricing previews. See detailed `docs/CHANGELOG.md` and respective provider docs.
- Hostinger hPanel **manual Redeploy is required** in observed setup; pushes to `main` have not consistently automatically deployed the apps.

### 23–24 October 2026: 888API import, pricing and generation failures
- **#20 `afe80a2`**: integrated `https://888api.xin`: Admin API key, model discovery, video/image adapters, worker queue, tests; initial implementation used USD estimates and 3.5× customer multiplier, **later superseded**.
- **#21 `7216707`**: diagnosed/explained an empty Video Studio selector, separated model eligibility/provider errors.
- **#22 `58bdaa1`**: supported Seedance catalog activation/list.
- **#23 `0d7db52`**: supported non-Seedance video families and full Admin model inventory; initially user saw only Seedance entries.
- **#24 `96e95df`**: **final 888API-only billing rule: provider ¥1 = customer 1 credit**. Distinguish fixed **per request** from duration-dependent **per second** models, e.g. ¥0.065/s × 5s = 0.325 credits; supersedes earlier USD×3.5. Other providers' billing remains unchanged.
- **#25 `2425d34`**: protected logging of HTTP 400 provider rejection details; validates required MiniMax H3 reference images.
- **#26 `25214cf`**: resolves handling of oversized base64 JSON returned by 888API 4K image result.
- **#27 `4700bd4`**: fixes Go API contract: send video `seconds` as **JSON string**, not numeric `5`; original error `json: cannot unmarshal number into Go struct field .Alias.seconds of type string`. Fixed-price video `duration` remains numeric.
- **#28 `cb4ead3`**: idempotent GET video status polling (60-second timeout, bounded retry for transient failures), safe network diagnostics; **never retry paid POST on ambiguous interruption**. Original worker log `888API request interrupted. Paid operations are not retried automatically.` appeared during GET status checks, and jobs stuck Processing.
- **#29 `b521e78`**: Admin → Generations → **Check 888API** (read-only GET by saved provider task ID), returns upstream/local state without paid job creation; fallback task-status normalization.
- **#30 `00c040e`**: explicit Admin recovery for completed upstream videos that timed out/refunded locally; retrieve original task and save its MP4 while **preserving** customer refund and credit ledger. Not a general automatic retry.
- **#31 `b963eeb`**: authenticated `GET /v1/videos/{id}/content` fallback for expired direct result URLs; protected error stage `video.status` / `video.download` / `video.storage`.
- **#32 `d1def9a`**: normalizes relative/media redirect URLs and HTTPS upgrade for ordinary public DNS links; introduces privacy-safe error classification.
- **#33 `c8c26a8`**: deterministic unretrievable output handling: if both video links are rejected as unsafe raw-IP/custom-port URLs, mark failed and refund locally rather than showing an endless spinner. Provider charges may remain.
- **#34 `a261c2b`**: explicitly opt-in/disabled-by-default 888API and limited handling of **public IPv4 provider video results**. Inspect current `src/provider/api888.js` and its `publicIpv4` security restrictions before making claims about remaining blocked URLs; private/local IPs still must not be fetched. This later commit supersedes blanket older documentation stating *all* IPv4 downloads are blocked. Never disable SSRF protections indiscriminately.

**Concrete reported 888API incident:** MiniMax H3 480p T, 5 seconds, customer cost **0.325 credits**, generation UUID `c2ebddd1-ab9b-4d25-805e-3f8d2c9c9627`, saved upstream task `task_D7HzxBNPpUpDmpWa38UjhusJLkJe8gVK`. Admin showed local **failed/timed out and refunded**, but read-only 888API status **completed (100%)**. Repeated recovery initially failed with generic download errors, then classified both direct and authenticated /content redirects as `shape=absolute, scheme=http, target=ip, port=custom`. Later #34 added constrained public IPv4 handling, but **no screenshot confirms final MP4 recovery**, and the original customer requested **stop recovery/cancel**. Do not resurrect this paid operation; honor request and keep refund. Subsequent Video Studio screenshot again showed Processing but **generation ID was not provided**, so do not assume it was the same job. Another earlier request showed MiniMax error 400 (`seconds` wrong type), while an unrelated GPT image 4K request failed size limits. Treat these as distinct incidents.

**Security:** 888API support/activity keys and a Google OAuth client secret were displayed in previous chat materials. Do **not** copy them into source/docs. Rotate any exposed long-lived secrets and use Admin secure entry. Operator Activity is available with a read-only support key (not capable of mutation). Admin Activity offers sanitized `job.poll_failed`, `job.video_output_unavailable`, `api888.video_recovery_failed` events.

### 24 October 2026: database, storage and deployment changes

- **#35 `d6e4046`**: `src/settings.js` and `src/db.js` probe existing tables via read-only `SELECT ... LIMIT 0` before DDL; avoid unconditional `CREATE TABLE IF NOT EXISTS` requiring CREATE privilege even when table exists. A genuinely absent table still requires DDL access. This code change **does not** bypass Hostinger's storage-quota write lock; `d6e4046` deployment was observed failed during cloning.
- **#36 `316e103`**: **Google Drive video storage**. New generated videos can default to private Drive after successful OAuth connection; marker `gdrive:<file_id>`. Google `drive.file` scoped user OAuth; encrypted refresh token in `app_settings`; 4 MiB resumable upload; size/MD5 validation. Customer playback routed through authorized CMM backend with Range support. `worker.js` implements background historical MySQL `db:video` → Drive migration one video at a time, with MySQL named lock, verify-before-delete and transactional switch of `generations.output_url`/deletion of `generation_video_chunks` and `generation_video_outputs`. Pause/resume/status in Admin Storage. On customer delete, tries to remove Drive object; failed cleanup logged.
- **#37 `089d08f`**: owner-requested **Google OAuth ID + secret fields directly under Admin → Storage**, with password masking and **encrypted/transactional settings save**; callback + web + worker read the same shared settings, legacy env values only fallback. No Google OAuth env variables necessary. Rotating a secret for the existing OAuth Client ID is supported; switching ID after connection is blocked to protect existing Drive file access. **Hostinger failed to clone this commit**, so the form was not yet visible in last confirmed live site.

**Google Drive limitations:** Google external `Testing` mode may give non-persistent refresh tokens (often 7 days for requested Drive scopes); ensure OAuth publishing/compliance for long-running use. Owner created Google Cloud branding/client and saw External/Testing; client secret was exposed and must be rotated. **No authorized/connected Google Drive, migrations or verified live Drive upload yet.** Migration only moves database-stored `db:video` chunks, not expired external provider video URLs. Google Drive storage/quota is separate from MySQL and not infinite.

## D. Current MySQL data model, size and cleanup semantics

Primary tables in `src/db.js`: `users`, `sessions`, `generations`, `generation_video_outputs`, `generation_video_chunks`, `generation_image_outputs`, `generation_image_thumbnails`, `generation_images`, `generation_media`, `credit_transactions`, `plan_requests`, `user_provider_access`, `activity_log`, `app_settings` (settings schema in `src/settings.js`), `provider_models`, `connector_uploads`, OAuth tables, runtime boot data and voice clones.

- Video output bytes are held in `generation_video_chunks.video_data`, with lengths in `generation_video_outputs`; image BLOBs, reference media and potentially other tables also use storage. Customer video output may be `db:video`, `gdrive:<file-id>` after Drive connection, or remote provider URL. Inspect live DB instead of assuming all 3.14 GB are video outputs.
- **Deletion has financial dependencies.** `credit_transactions.generation_id` may reference `generations.id`; preserve ledger rows by setting `generation_id=NULL` before deleting finished generation rows. Keep balances and refund transactions. Other children (`generation_media`, `generation_images`, outputs/thumbnails/chunks) have dependent FKs; some older database versions may not have all `ON DELETE CASCADE` constraints despite current `CREATE TABLE` declarations. Existing individual deletion code in `src/generations.js` and `src/image_generations.js` intentionally performs child cleanup.
- The owner explicitly authorized **removal of all video generations** as disposable, including stored videos, but **NO database deletion was completed** through this chat. Attempted bulk cleanup in phpMyAdmin failed at the first SQL statement: `UPDATE credit_transactions ...` with `#1142 UPDATE denied`. No successful later DELETE was shown. If resuming this operation, take a verified backup, check actual FK structure, and **exclude running paid jobs** until refunds are reconciled; use small batches if near DB disk limits.
- Running deletion can free *logical* MySQL content but may not immediately shrink table allocation or hPanel quota. Avoid expensive blocking `OPTIMIZE TABLE` on a full DB without a backup, privileges and space. Hostinger UI showed quota alarm and all user grant checkboxes selected concurrently; investigate host account restrictions.
- If choosing a **selective new-database restore** instead of freeing old quota, make a deliberate decision about the credit ledger, generation history and OAuth state; importing only six minimal tables is **not a full financial/audit-preserving restore**. Do not restart paid generation until correctness checks pass.

## E. Safe next work — high-impact priorities (not yet implemented)

1. **P0: Re-establish MySQL writability and web/worker uptime** by verified new-database restore or Hostinger quota relief. Preserve and validate local SQL backup; test carefully with dummy/test database. Keep production original intact for rollback.
2. **P0: Fix Hostinger Git clone** for private repo. The GitHub app's Installation permissions screenshot showed “All repositories”; nevertheless Hostinger deployment failed at first “Cloning repository” stage. This is Hostinger's GitHub authorization/cache/fetch context, **not evidence of a Node build or source-code syntax error**. Retry/reconnect or obtain Hostinger support if needed. GitHub Actions for #37 passed node syntax + unit tests.
3. **P1: Google OAuth and Drive connection:** get the new Admin form deployed; rotate exposed Google client secret; configure through Admin, confirm testing user/consent/Drive API, then test one small upload and authenticated customer playback. Keep workers on same code revision/encryption root.
4. **P1: Verify historical video migration** and disk reclamation; honor customer choice to discard old videos instead if requested. Never migrate and delete old data without verified backup and Drive checks.
5. **P1: 888API end-to-end verification** after database is writable; confirm last #34 behavior on the current worker. Do not run new paid MiniMax H3 experiments or enable 888API for customers without checking safe media delivery and credit refund policy.
6. **P2: Keep documentation consistent**: earlier `docs/PROJECT_HANDOFF.md`/`docs/PLANS.md`/`README.md` contain old provider/plan wording. Treat this dated handoff and current `src/plans.js` / `src/settings.js` as more current. Continue updating `docs/CHANGELOG.md` after further PRs.

## F. Code/document map

| File | Responsibility |
| --- | --- |
| `server.js`, `public/admin.html` | Web, Admin routes/forms, Google OAuth callback, Drive status and authenticated media |
| `worker.js`, `src/worker.js`, `src/worker_admin_settings.js` | Separate worker host, polling/dispatch, background Drive migration |
| `src/settings.js`, `src/db.js` | Encrypted settings, provider toggles, MySQL schema/setup, Admin OAuth credential storage |
| `src/google_drive.js` | Google OAuth, Drive API/resumable upload, video streaming and deletion |
| `src/google_drive_migration.js` | Verify/migrate older MySQL video chunks and migration stats |
| `src/video_outputs.js`, `src/generations.js` | Durable video outputs, deletion, refund/financial references |
| `src/provider/api888.js`, `src/api888_models.js`, `src/api888_queue.js` | 888API transport, catalog, pricing/feature quotes and polling |
| `src/api888_recovery.js` | Admin-only recovery of already completed/refunded provider output |
| `src/plans.js`, `src/billing.js` | Current public plans, credits and source conversion |
| `docs/API888.md` | Provider details, source pricing and recovery troubleshooting (some history superseded by #34) |
| `docs/GOOGLE_DRIVE_STORAGE.md` | OAuth/setup, migration, integrity and quota limits |
| `docs/HPANEL_DEPLOYMENT.md` | Web/worker deployment and MySQL troubleshooting |
| `docs/PROJECT_HANDOFF.md` | Original 11 October handoff, retained for deep architectural history; points here |
| `docs/CHANGELOG.md` | Accumulated change history, supplemented by this 25 October checkpoint |
| `test/google_drive*.test.js` and `test/api888*.test.js` | Mocked protocol, storage and refund tests |

## G. Safety, confidentiality and evidence rules for future developers

- No production mutation can be assumed just because a GitHub PR merged, CI passed, a Hostinger status badge appeared, or a troubleshooting script was printed. Cite/log **which exact environment, revision, worker, database and generation ID** were actually observed.
- Do **not** put API tokens, OAuth client secrets, MySQL passwords, signed media URLs, support access keys or customer email addresses in repo/commits. Rotate exposed secrets.
- Never automatically retry an ambiguous paid provider POST; status GET queries of saved IDs can be retried safely.
- Customer credit balances, financial transactions and refunds must remain accurate through migrations, video deletion and recovery; settled jobs must not be double-charged.
- Never disable media SSRF protections wholesale; #34 implemented a limited public IPv4 exception for 888API's specific completed-video issue, which deserves targeted review/testing.
- If the owner has deleted or chosen not to recover old videos, do not silently recreate paid jobs or attempt an unapproved restoration.
- All prior dates and observations are 23–25 October 2026 unless stated; last known **production** web commit `316e103` and **GitHub source** commit `089d08f` are distinct. Hostinger status after these screenshots is **unknown**.
- Continue work by first reading this file, then `docs/HPANEL_DEPLOYMENT.md`, `docs/GOOGLE_DRIVE_STORAGE.md`, `docs/API888.md`, `docs/CHANGELOG.md`, and finally **actual latest `main` source**. Run tests and create PRs before merging. Verify live web *and worker* after any deploy.


## H. Subsequent 888API model import audit investigation (25 October 2026)

The owner reported seeing **115 imported model IDs / 64 present in the last successful sync / 13 Video Studio ready / 4 Image Studio ready**, while a separate import confirmation said **31 supported adapters**. These are **not contradictory**: \`syncProviderModels('api888')\` sets \`available=0\` on previously stored rows before upserting currently returned IDs, so the saved table is a historical union, not an account entitlement list. The implemented request adapters and CNY pricing are conservative allowlists in \`src/api888_models.js\`. Models without verified route/contract/rate are Admin-only; per-customer 888API access and global provider switch are separately opt-in. This does **not** establish that every current provider model is implemented, or that successful imports will generate working media.

The follow-up PR adds **read-only Admin → 888API → Verify live import** to reconcile the **current exact upstream IDs** against saved MySQL inventory and list missing, stale, misclassified, disabled and unsupported entries separately. Its result is the proper verification of account-scoped import parity; it does not submit paid tasks or mutate quotas. **This feature must deploy and be run in production before claiming actual current parity.** At the time of this investigation, the MySQL over-quota and Hostinger Git clone incidents described above remain unverified as resolved.


## I. 888API multimodal inputs and ratio regression discovered 25 October 2026

Follow-up report: although the 888API catalog documents some models accepting image, video and audio input, CMM Tools customer Video Studio showed image uploads only and appeared to omit usable aspect-ratio choices. Inspection confirmed the shared front-end already contains generic video/audio reference widgets and a ratio selector, but **888API model capabilities advertised image-only** and \`src/provider/api888.js\` explicitly rejected every non-image reference. The 888API model snapshot supplied only generic aspect ratios, even where provider docs list more.

The follow-up PR updates verified model-specific caps, signed-reference request-body arrays (\`videos\`, \`audios\`, or \`metadata.audios\` for 1080p 930), per-model ratio lists, client/server total-reference validation, and regressions for unsupported uploads/ratios. It preserves fixed-vs-dynamic yuan parity, never starts a test paid task and keeps unsupported model contracts out of the customer picker. See \`docs/API888.md\` for covered model IDs and exact per-model limits. **Not live until deployed and Admin 888API catalog re-import succeeds.** Old full-DB write restrictions and Hostinger clone failure must be cleared first. New reference files are still stored in MySQL, not migrated to Drive automatically.

## 25 October 2026 — Seedance video/audio controls still hidden after initial multimodal merge

The owner reported that even after PR #40, no Seedance model in Video Studio appeared to offer an **Add Video** or **Add Audio** control.

### Confirmed code defect and follow-up fix
- The old client displayed **one combined upload picker**, not distinct audio/video upload actions. \`public/index.html\` now has **Add image**, **Add video**, **Add audio** buttons wired to existing per-type upload handlers and displayed only where \`capabilities.image/video/audio.supported\` is true; combined drag/drop remains.
- **More importantly, persisted \`provider_models.options_json\` is a snapshot.** PR #40 added verified 888API multimodal mapping to code but only Admin → Import all accessible models refreshed the stored model options. Hostinger MySQL was reported quota-locked, so re-import could fail. \`serializeProviderModel()\` now overlays **current audited local input capabilities, media roles, supported operation IDs, aspect ratios, and upload transport field names** for already adapter-supported 888API video models at read time. This avoids any DB writes and affects both customer \`GET /api/config\` and the server/worker's per-model lookup. It preserves DB \`enabled\`, \`available\`, account source entitlement, prices and adapter readiness; it does **not** activate new/unsupported models or perform paid generation.
- The changed code still **must be deployed** to the website and standalone worker; no source edit can correct an old live Hostinger revision. A browser hard refresh reloads the UI, but cannot fix a server still running the old commit.
- **Not all Seedance models accept audio/video:** 888API's official docs explicitly say the low-cost \`seedance2.5-900-wool\` and related Wool variants accept reference images but **not reference videos or audios**, and 2.0 per-second stable/basic variants accept no reference materials. For actual multimedia input use the documented supported Seedance 2.5 models such as \`ss-2.5-720p-v1\` or \`s2-2.5-720p-v3\`/\`v4\`; \`s2-2.5-480p-v2\` supports audio but not video.
- PR #40's HTTP payload, max input counts and price validations remain unchanged. Current reference videos/audio are stored as BLOB inputs in MySQL even if the finished video output is saved on Drive: do **not** encourage uploads while the old production DB is over quota. No paid production generation or live site update was done in this follow-up.
- Source: https://888api.xin/docs.


# CMMTools — AIVID Premium / RDP / Cloud Storage Full Handoff

**Checkpoint:** Saturday, 7 November 2026 (Asia/Karachi).  
**Repository:** `thesfjksa/vidancee-direct-saas`, branch `main`.  
**Scope:** preserve all confirmed findings from the owner's 7 November AIVID incidents, pull requests, storage error, customer cleanup, and Admin Activity screenshot; updated with the later AIVID collection, Admin history, and retry fixes (#182–#186). This is the current operational handoff; [6 November handoff](PROJECT_HANDOFF_2026-11-06.md) retains architecture, earlier integration work, pricing, and setup.

## Standing workflow for CMMTools changes

The owner authorizes the assistant to push and merge every owner-requested repository change into `main` without a separate confirmation. Update this handoff in the same pull request on every change or push. Record what changed, which checks ran, and what still needs deployment or live verification. Wait for applicable CI before merging, verify the result on `main`, and report any unresolved blocker. See [repository instructions](../AGENTS.md).

## Recent changes in Image Studio and Library

- [#189](https://github.com/thesfjksa/vidancee-direct-saas/pull/189) adds reference uploads for compatible fal.ai Image Edit variants. The existing fal.ai GPT Image 2, GPT Image 2.5 Flare and Sunburst, GPT Image 1.5, and GPT Image 1 Mini selections each accept one optional reference. Attaching an image selects the matching edit endpoint and uses the same estimated edit price for the preview and the credit reservation.
- The ready fal.ai image worker checks for queued jobs every two seconds instead of five. This reduces pickup delay when a slot is free. The 512 passing local tests cover catalog pairing, reference validation, quote and charge agreement, signed asset delivery, and pickup timing. The production benchmark below measures the time to a visible image.
- For future catalog refreshes, use **Admin → Provider → fal.ai → Sync fal.ai image models** or the worker's scheduled sync. Confirm the customer options in the live catalog. The rollout result is recorded below.
- [#188](https://github.com/thesfjksa/vidancee-direct-saas/pull/188) merged at `123b6ea`. The signed-in Library's **Download backup** action exports the customer's complete video history for completed jobs and the corresponding prompts in one ZIP. GitHub's Node and browser checks passed. Production deployment remains unverified.

### GPT reference rollout after the catalog sync timeout

- The production Image Studio HTML matched the version merged in #189, and the standalone worker reported fal.ai ready. The Admin sync hit Hostinger's request timeout. The public catalog still listed 139 fal.ai models and no reference options at the time of the check.
- [#190](https://github.com/thesfjksa/vidancee-direct-saas/pull/190) merged at `f717f53`. Existing enabled, available catalog rows for the five verified fal.ai GPT Image endpoints load the checked edit contract and estimated edit price directly when they predate edit discovery. A complete live import takes precedence. A full import that cannot retrieve the schema for a listed GPT pair keeps the saved catalog.
- **Production verified at 10:26 PM PKT on 7 November.** Admin Activity recorded successful worker catalog syncs at 10:23:24 and 10:24:37 PM PKT. [The live catalog](https://cmmtools.site/api/config) then listed 185 fal.ai models, 62 with reference support. All five named GPT models reported one optional reference and an estimated edit price.

### Paid production image benchmark

- One customer Studio request completed on 7 November at 11:04 PM PKT. The fal.ai GPT Image 2.5 Flare request used one synthetic reference, a 1:1 canvas, Low quality, and the prompt enhancer switched off. The 1,024 × 1,024 image appeared in Studio and the credit debit matched the 148.05-credit estimate.
- From the Generate click, Studio first showed Queued at 2.2 seconds, Processing at 3.5 seconds, and a loaded result at 28.9 seconds. These are browser observations. Provider queue wait, inference, storage, and delivery were not timed separately. Studio checks active status every five seconds, which can add up to five seconds before it notices a completed job. This run establishes a baseline for one request.
- The completed preview showed Default quality because the fal.ai route stored the Low selection in the provider quote without setting the history column. The worker uses the saved quote to build the fal.ai request. The accompanying change persists the quality for new jobs and reads it from saved quotes for older fal.ai jobs. The focused fal.ai tests cover the provider payload and older history rows. Production verification of the history fix is pending.

## Executive status — distinguish code from live service

- **Merged on GitHub:** PRs #175–#186, including documentation-only #181, are merged into `main`. Latest inspected AIVID code checkpoint: PR #186 merge `6aa2ccb9437562fc8c94c2eb3330b4fe78036376` (7 November 2026, 13:17 UTC).
- **CI:** #179 and #180 each passed Node tests, AIVID RDP agent package checks (Windows / real Chrome and MySQL integration), and AIVID Admin browser checks. **Passing CI does not mean the owner's Windows RDP generation succeeds.**
- **Production:** Admin History confirmed that a production AIVID job was accepted and its MP4 was saved at 10:02 PM PKT. The exact deployed Hostinger and managed RDP revisions remain unverified. The later reference failure is documented below.
- **Earlier user reports:** one no-F12 attempt displayed `The video request could not be prepared. Credits were refunded.` Later, AIVID finished jobs that CMMTools showed with `[collection_download]`. PRs #182–#186 address collection diagnostics, transfer, retry feedback, and a history asset-ID mismatch.
- **Owner's Activity screenshot:** from 7 November 2026 about **4:13:11–4:13:47 PM** as displayed in Admin Activity, repeated `POST /api/aivid-rdp/poll → 200` entries every ~2–3 seconds, taking ~3–7 ms. These establish that the RDP polling endpoint was answering; they **do not establish** an accepted generation, correct agent release, healthy cloud storage, or a successful customer job. Screenshot showed no relevant job-specific error; entries were dominated by normal info-level request polling.

## 7 November user-reported symptoms (chronological)

1. Three reference images uploaded and Generate was clicked. Without F12, AIVID's managed Chrome tab moved to `about:blank#cmmtools-worker` and the expected generation did not appear to finish. Pressing **F12 immediately after clicking Generate** sometimes allowed upstream AIVID generation to proceed. Opening DevTools **before** starting sometimes instead caused a CMMTools `[browser_check] The AIVID operation failed. Inspect Chrome and the Agent window; no automatic resubmission is allowed. Credits were refunded.`
2. `Cloud storage rejected the upload (HTTP 500).` was reported during work. The exact string comes from `src/object_storage.js:ObjectStore.put` after an S3-compatible bucket responds 500 to PUT. This is a **cloud-storage error**, separate from the AIVID POST-guard. A transient remote failure, storage service condition, or infrastructure/configuration issue is plausible; root cause not verified. Do not infer it was caused by the Chrome guard.
3. User requested deletion of all generations for `ranno@gmail.com` to free space. Admin already offers account-scoped **Delete finished generations** via `src/admin_generation_cleanup.js`. The assistant did **not** run a live deletion or directly access the production DB. Actual reclaimed bytes remain unverified.
4. After the merged interception changes, user reported `The video request could not be prepared. Credits were refunded.`, without any apparent upstream submission. The exact message was the generic catch in `src/aivid_queue.js:AividQueue.submit` when a pre-reservation exception lacks an AIVID diagnostic code. Possible failures include saved reference retrieval/hydration, malformed options, RDP bridge, or reservation precheck. **No definitive cause yet.**
5. Admin Activity screenshot (as above) contained successful RDP poll requests only; successful polling alone does not prove AIVID worker submission or file delivery.
6. In later attempts, the owner observed AIVID's own site had successfully generated the videos while CMMTools still reported `[collection_download] The worker could not download and validate the AIVID MP4. The existing video will be checked again after a delay.` This is a **post-generation collection failure**, not proof that paid generation failed; source job IDs must be preserved.
7. The owner clicked **Retry collection** in Admin but saw no obvious response. PR #185 changes the acknowledgment, worker wake-up, and Activity visibility. A button response is not proof of MP4 arrival.

### 11:24 PM PKT production AIVID failure

- Admin → Generations showed a Seedance 2.0 Mini job (`5bc94231`) at 15 seconds and 480p with one video reference. AIVID History recorded `aivid.preparation_failed` at 11:25:22 PM with stage `rdp_dispatch` and code `reference_upload`. The job ended as `submit_error` before the paid submission reservation, had no provider job ID, and received a full refund of 846.72 CMMTools credits.
- The diagnostic identifies reference verification in the RDP browser. The specific failed check remains unresolved among the input lookup, selected file, preview, and upload ID. Admin reported the RDP agent online and ready at 11:30 PM. The preceding AIVID job had an accepted provider ID and a saved MP4 at 10:02 PM.
- Verification used the live Admin job record, uploaded input types, job-specific activity, and provider status. The investigation was read-only. To narrow a recurrence without a paid submission, use the synthetic reference preflight and compare the result with the failed job's single-video input.

## Merged change index and purpose

| PR | Description | Merge commit | Verified boundary |
| --- | --- | --- | --- |
| [#175](https://github.com/thesfjksa/vidancee-direct-saas/pull/175) | Preserve active AIVID upload/command during worker recovery; avoid refunding a live command just because a worker loses its lock | `6a98170b57cdcea5b0d7e2d66b265830b20edf6e` | Code, not production |
| [#176](https://github.com/thesfjksa/vidancee-direct-saas/pull/176) | Allow known AIVID `POST /v2/interactions/likes/bulk` background mutation without failing the submission guard | `1017b2f988616b0106d93a590d421bc679c7e382` | CI passed; live F12 problem persisted |
| [#177](https://github.com/thesfjksa/vidancee-direct-saas/pull/177) | Admin customer-specific deletion of terminal generations/media, with exact email confirmation and protected active jobs | `f165f5adcae78377d8733e3a63005fd41c68b94f` | Tool availability verified in repo, not executed in production |
| [#178](https://github.com/thesfjksa/vidancee-direct-saas/pull/178) | Keep waiting for verified `POST /v2/generations` response after a durable reservation; unrelated blocked POSTs cannot win the failure race | `da444a5aae09fde985ec46613763968637e92dd9` | CI passed; live success not proven |
| [#179](https://github.com/thesfjksa/vidancee-direct-saas/pull/179) | Register `Fetch.requestPaused` handler **before** `Fetch.enable`, avoiding a startup event lost while Chrome interception is being enabled; add `request_guard_setup` diagnostic | `ee7471934fbb41b1bc19bb2f3265936df5c45654` | Node, Windows real-Chrome / agent package, Admin browser CI passed; owner's live RDP failed later |
| [#180](https://github.com/thesfjksa/vidancee-direct-saas/pull/180) | Safe, explicit pre-click diagnosis in queue; `aivid.preparation_failed` Admin Activity entry with stage/code/bounded storage status; regression tests and handoff | `a63444b249176963ebd120fdacdc28bbfe0856ba` | Node, Windows agent, Admin browser/MySQL CI passed; **new diagnostics await deployment and real failure evidence** |

| [#181](https://github.com/thesfjksa/vidancee-direct-saas/pull/181) | Document the 7 November RDP/F12/storage incident; no application logic changes | `3fe380ee59138f82cf9289254c18a159a9b39f55` | Documentation only |
| [#182](https://github.com/thesfjksa/vidancee-direct-saas/pull/182) | Read exact AIVID job from authenticated Generate-page history, then transfer its signed MP4 from verified storage host; no public detail-page download click | `8332c23ac2d12a6d5988157e72d27709e4988963` | Code/fixtures, live collection unverified |
| [#183](https://github.com/thesfjksa/vidancee-direct-saas/pull/183) | Distinguish history lookup, media URL validation, provider transfer, RDP relay and CMMTools output-storage collection failures | `674fce0a7da26fb9af8544fcdbbe6c8670c2f214` | Code diagnostic improvements; production stage not checked here |
| [#184](https://github.com/thesfjksa/vidancee-direct-saas/pull/184) | Add Admin AIVID History job view with activity and provider IDs | `a25048de2c6905873f9523053db2512a84646d1b` | Admin UI/code, live data not independently checked |
| [#185](https://github.com/thesfjksa/vidancee-direct-saas/pull/185) | Confirm/wake existing-video collection retries, make status/errors visible, reject repeated or unsafe retries | `409053515f172a6b5018202bda3eac6bf687ea08` | Merged; no live retry completion verified |
| [#186](https://github.com/thesfjksa/vidancee-direct-saas/pull/186) | Tie authenticated history row to exact generation ID even when MP4 filename uses a different asset ID; retain storage host/path/MP4 checks | `6aa2ccb9437562fc8c94c2eb3330b4fe78036376` | Merged; production MP4 delivery not verified |

## 7 November follow-on: AIVID completed video collection, retry and history (#182–#186)

**Symptom / scope:** AIVID can finish a paid generation while the CMMTools worker fails to retrieve, validate, relay, or store its MP4. The customer-facing `[collection_download]` message is a broad collection symptom; it does **not** justify a new paid video request. Inspect job-specific Admin AIVID History and the fixed collection stage (PR #183) rather than inferring that the source generation is missing.

**#182 — authenticated source-history collection:** The RDP agent uses the signed-in AIVID Generate page's own history GET, identifies the exact provider generation ID (including bounded pagination), then downloads the returned signed MP4 URL directly from an expected media host. It does not open a public detail page, click a download button, or create another generation. Pending/failed status remains distinct. Collection still requires normal origin, URL, transfer, size, and MP4 validity checks.

**#183–#184 — observability:** Collection failures are differentiated by where they happen: history lookup, exact media URL verification, provider MP4 transfer, RDP relay, or CMMTools output storage. Admin's dedicated **AIVID History** provides per-generation/provider-job events, attempts, and fixed failure codes. Read relevant generation/job events (not general `POST /api/aivid-rdp/poll → 200` noise) and avoid logging raw signed URLs or secrets.

**#185 — why Retry collection appeared inert and what changed:**
- **Before:** Admin `resumeAividCollection` called the reconcile endpoint and refreshed Generations on success, with no positive in-page queued acknowledgment. The reconcile route recorded a generic `aivid.reconciled` event and did **not explicitly wake** the standalone generation worker. Thus a click could appear ineffective, even if database retry state had been cleared, and the worker might wait for its normal polling cycle.
- **After:** Admin immediately displays **Queuing…** and on server confirmation `collectionQueued: true` displays **Collection retry queued. The worker will check the existing video on its next poll. Follow the result in Job history.** Errors appear inline; lack of server confirmation is shown as an error rather than falsely implying success. The route calls `wakeGenerationWorker(req)` and logs `aivid.collection_retry_queued` with the specific generation ID and provider job ID.
- **Safety:** `retry_collection` only resumes a **paused** existing AIVID collection with a verified provider ID and allowed `submitted`/`processing` status; refunded, already resumed/repeated, stale, or `review_required`/uncertain submissions are rejected (HTTP 409). Retry clears collection failure/backoff flags but does **not** call AIVID Generate, purchase another video, or charge again. Browser and queue regression fixtures cover success/duplicate rejection/feedback.
- **Interpretation:** `collectionQueued: true` means the server accepted the **collection** retry; it does not mean an MP4 was fetched, uploaded, playable, or confirmed delivered. A real follow-up event/state is required.

**#186 — mismatched MP4 asset ID:** A verified AIVID history row for generation ID `G` may contain a video URL whose MP4 filename has a *different* asset ID `A`. Earlier `inlineVideoUrl` required the filename to end in `-G.mp4`, rejecting that otherwise valid history media even if it came from the exact authenticated row. The fix treats the history row's exact generation-ID match as the association (`jobVerified: true`) and permits that distinct filename while still pinning HTTPS, the expected media hostname, `/generating/` MP4 path, and subsequent MP4 checks. Untrusted hosts are still rejected. This resolves an identified **code-level URL rejection**, not every possible transfer/storage failure.

**Safe operational check for existing completed videos (no paid regeneration):**

1. Confirm **web and standalone worker deploys** include PR #186 and the Windows RDP runtime contains its updated `scripts/aivid-rdp/native.cjs`. GitHub merging alone does **not** prove this. Preserve the agent's existing pairing, receipt, Chrome profile and credentials.
2. In Admin → Generations, locate the **exact** CMMTools generation ID and AIVID provider job ID. Confirm the video completed on AIVID and check its job's **AIVID History** for the latest collection stage. If a generation is ambiguous/review-required, reconcile it instead of retrying.
3. Only for an eligible **paused collection** of that existing provider job, click **Retry collection** once. Confirm the inline queued acknowledgment and `aivid.collection_retry_queued` event; if error/409, refresh and inspect state before further action. Do not repeatedly click or start another paid request.
4. Follow worker activity by that generation ID. Validate a **completed** CMMTools record, stored playable MP4, correct ownership, and unchanged/appropriately reconciled credit ledger. If a collection error persists, classify history vs media URL vs provider transfer vs relay vs output storage; recheck any cloud-storage 500 separately. A worker `/poll` HTTP 200 and a queued acknowledgment alone are insufficient.

**Verification boundary:** PRs #182–#186 are merged in GitHub. Admin History shows completed production MP4 storage at 10:02 PM PKT, with playback and the exact Hostinger and managed RDP revisions still unverified. The later pre-click reference failure is a separate issue.

### How the Chrome worker is intended to behave

- Work tab `about:blank#cmmtools-worker` is an **intentional idle/cleanup URL**. It is not by itself proof of AIVID failure; going there **before** the awaited provider response can interrupt a generation.
- `src/provider/aivid.js:installRequestGuard` intercepts outgoing mutations using the Chrome DevTools Protocol. It verifies **exact** requested model, prompt, seconds, resolution, aspect ratio, Public visibility, source-upload IDs, allowed source price and one durable CMMTools reservation before allowing a **single** paid AIVID POST.
- Unknown mutation requests remain blocked. #176 permits known likes-refresh; #178 prevents unrelated blocked mutations from prematurely aborting an authorized response; #179 repairs request-paused registration timing. None bypasses sign-in, reCAPTCHA, or security warnings, and none authorizes duplicate paid POSTs.
- Pressing F12 is **not** an operational requirement or durable workaround. Do not automatically open DevTools or relax validation. F12-dependent behavior is still **live-unresolved** despite the code-level races fixed.

## Distinguish error families and next inspection step

| CMMTools / Agent error | What it means / where to look |
| --- | --- |
| `[browser_check]` | Generic RDP-side adapter exception; inspect agent console and browser stage. This alone does not identify CDP or AIVID as the cause. |
| `[request_guard_setup]` | CDP session or Fetch interception setup failed; inspect the managed Chrome/Agent, **no paid request allowed**. Introduced in #179. |
| `[reference_database]` | Could not retrieve saved reference records from MySQL. Inspect DB health/permissions/usage. Introduced in #180. |
| `[reference_storage]` | Could not hydrate saved reference objects from R2/S3. Check Admin → Storage, private bucket, relevant object health and any bounded HTTP status. Introduced in #180. |
| `[queue_setup]` | Generation options or early queue preparation failed. Inspect sanitized Activity stage/code. Introduced in #180. |
| `[rdp_dispatch]` | Could not dispatch or complete the RDP bridge command; inspect current agent status, `aivid_rdp_commands`, connection errors and console. Introduced in #180. |
| `[reservation_precheck]` | Submission price or reservation validation failed before the paid POST was authorized. Check source enabled state, source credit ceiling, quoted price, worker and settings. Introduced in #180. |
| `[reference_upload]`, `[submission_...]` | AIVID form-upload or outgoing request validation failed. Respect original code and **do not retry as a second paid request** without reconciling status. |
| `Cloud storage rejected the upload (HTTP 500)` | S3/R2 PUT rejected; inspect storage configuration and service health separately from F12 and CDP. `src/object_storage.js`. |
| `POST /api/aivid-rdp/poll → 200` | Normal agent-to-web polling response. **Not** proof of command claim, generation acceptance or delivery. |

PR #180 logs `aivid.preparation_failed` in **Admin → Activity** with safe `stage`, fixed `code`, and when relevant numeric `storageStatus` (400–599). It avoids copying signed URLs, SQL, prompt bodies, API tokens, cookies, credentials and raw browser errors into customer messages. These new records exist **only for failures after #180 is deployed**, not retroactively for the earlier screenshot.

## Storage cleanup / one user

- Admin Console → **Users → choose exact `ranno@gmail.com` account → Generations → Delete finished generations**. Preview, type the *exact* email, then confirm permanent deletion. Function: `deleteFinishedUserGenerations` in `src/admin_generation_cleanup.js`.
- This deletes completed/failed/`submit_error` video, image and audio generations (in batches of up to five), using existing per-media cleanup and attempting deletion of associated cloud objects. It preserves active/uncertain source jobs, user account, current wallet and credit ledger.
- Storage-object cleanup may fail separately and be logged. Deleted MySQL rows **do not guarantee immediate allocated-disk reduction**; take a DB backup and investigate MySQL quota and maintenance if capacity remains tight.
- **No production deletion was performed by the assistant.** Do not silently delete further users or abandon protected jobs.

## Immediate continuation checklist (no repeated paid test until reconciled)

1. **Confirm actual deployments** of `main` including #186 to **both** Hostinger services: customer/API `https://cmmtools.site` (`server.js`, `WORKER_ENABLED=false`) and standalone worker `https://worker.mehroz.online` (`worker.js`, `WORKER_ENABLED=true`), using the shared MySQL database/settings. Inspect actual deployed revision and worker health; GitHub merge and HTTP 200 do not by themselves prove current code.
2. Confirm the Windows managed RDP agent is connected, using the latest hosted runtime, correct existing private Chrome profile, and a recent ready heartbeat. Avoid replacing credentials or re-pairing unless proven necessary. Preserve `receipts`, saved profile and credentials; never publish them in GitHub.
3. **Before another paid request**, match the failed CMMTools generation ID with AIVID account history and local receipt. If an upstream ID was accepted or is ambiguous, retain it for reconciliation; **never submit a replacement automatically** or refund an already-paid ambiguous source job without confirmation.
4. In Admin → **Activity**, filter by the **specific generation ID**, or search `aivid.preparation_failed`, and inspect the `stage`, `code` and optional `storageStatus`. Turn on the relevant category/level filter. The owner's earlier screenshot was only `request` poll information; avoid interpreting the lack of a visible error in that crop as absence of errors.
5. For `reference_storage`, inspect Admin Storage/bucket and prior 500 evidence; for `rdp_dispatch`, inspect RDP Agent console and server-side command state; for `reservation_precheck`, verify persisted source enabled/price ceiling and wallet state; for `browser_check`, inspect the exact last agent progress stage.
6. Perform **credit-free preflight/diagnostic checks first**. Only after production stages are understood and account history is reconciled should the owner authorize **one controlled no-F12** paid test. Verify provider acceptance ID, CMMTools processing, MP4 collection/storage, playback and credit balances. Do not rely on F12.
7. If the video was generated on AIVID but not delivered, prioritize **collecting the existing accepted ID**; do not regenerate. Collection failures back off and may pause for owner review. Use the PR #185 queued acknowledgment and PR #184 AIVID History; `retry_collection` is only for eligible paused **existing** IDs. Check PR #186 history-row/asset-ID handling in the deployed agent.

## Remaining unknowns

- Whether the latest `main` and managed runtime are running on the owner's actual Hostinger and RDP machines.
- Exact cause of last pre-click generic failure (need stage-coded event from deployed #180, or carefully sanitized server/agent logs).
- Which of the owner's paid AIVID submissions were accepted and await collection versus refunded before click; at least some videos were *reported* completed on AIVID, but matching IDs and CMMTools delivery have not been independently verified.
- Whether R2 HTTP 500 is recurrent, transient, quota-induced or configuration-related, and whether requested customer storage cleanup actually freed space.
- Whether three-reference AIVID videos now complete **without F12**, and whether the PR #185 retry plus PR #186 asset-ID fix run on the owner's actual Windows agent to deliver playable output MP4s to CMMTools with correct accounting.

**Safety:** Do not place API keys, Chrome DevTools URLs, OAuth tokens, secret headers, account cookies, pairing codes, full customer media, raw SQL credentials, or unredacted logs in handoffs. Keep post-click uncertainty for reconciliation rather than silently retrying or refunding a possible upstream accepted job.

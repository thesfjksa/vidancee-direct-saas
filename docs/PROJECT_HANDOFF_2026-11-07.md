# CMMTools — AIVID Premium / RDP / Cloud Storage Full Handoff

**Checkpoint:** Saturday, 7 November 2026 (Asia/Karachi).  
**Repository:** `thesfjksa/vidancee-direct-saas`, branch `main`.  
**Scope:** preserve all confirmed findings from the owner's 7 November AIVID incidents, pull requests, storage error, customer cleanup, and Admin Activity screenshot. This is the current operational handoff; [6 November handoff](PROJECT_HANDOFF_2026-11-06.md) retains architecture, earlier integration work, pricing, and setup.

## Executive status — distinguish code from live service

- **Merged on GitHub:** PRs #175, #176, #177, #178, #179, #180. All are merged into `main`. The most recent code checkpoint before this documentation is PR #180 merge `a63444b249176963ebd120fdacdc28bbfe0856ba`.
- **CI:** #179 and #180 each passed Node tests, AIVID RDP agent package checks (Windows / real Chrome and MySQL integration), and AIVID Admin browser checks. **Passing CI does not mean the owner's Windows RDP generation succeeds.**
- **Production:** Hostinger web and worker deployment of the newest code, managed agent update on the owner's RDP, corrected source submission, media collection, and credits/storage effects **have not been independently verified** during this handoff.
- **Latest reported user outcome:** after the F12/interception fixes, the user received `The video request could not be prepared. Credits were refunded.` and reported that the Generate request **was not even submitted**. This generic pre-reservation exception is the reason for PR #180's diagnostic improvements. Its underlying production exception remains **unknown**; do not claim PR #180 fixed it.
- **Owner's Activity screenshot:** from 7 November 2026 about **4:13:11–4:13:47 PM** as displayed in Admin Activity, repeated `POST /api/aivid-rdp/poll → 200` entries every ~2–3 seconds, taking ~3–7 ms. These establish that the RDP polling endpoint was answering; they **do not establish** an accepted generation, correct agent release, healthy cloud storage, or a successful customer job. Screenshot showed no relevant job-specific error; entries were dominated by normal info-level request polling.

## 7 November user-reported symptoms (chronological)

1. Three reference images uploaded and Generate was clicked. Without F12, AIVID's managed Chrome tab moved to `about:blank#cmmtools-worker` and the expected generation did not appear to finish. Pressing **F12 immediately after clicking Generate** sometimes allowed upstream AIVID generation to proceed. Opening DevTools **before** starting sometimes instead caused a CMMTools `[browser_check] The AIVID operation failed. Inspect Chrome and the Agent window; no automatic resubmission is allowed. Credits were refunded.`
2. `Cloud storage rejected the upload (HTTP 500).` was reported during work. The exact string comes from `src/object_storage.js:ObjectStore.put` after an S3-compatible bucket responds 500 to PUT. This is a **cloud-storage error**, separate from the AIVID POST-guard. A transient remote failure, storage service condition, or infrastructure/configuration issue is plausible; root cause not verified. Do not infer it was caused by the Chrome guard.
3. User requested deletion of all generations for `ranno@gmail.com` to free space. Admin already offers account-scoped **Delete finished generations** via `src/admin_generation_cleanup.js`. The assistant did **not** run a live deletion or directly access the production DB. Actual reclaimed bytes remain unverified.
4. After the merged interception changes, user reported `The video request could not be prepared. Credits were refunded.`, without any apparent upstream submission. The exact message was the generic catch in `src/aivid_queue.js:AividQueue.submit` when a pre-reservation exception lacks an AIVID diagnostic code. Possible failures include saved reference retrieval/hydration, malformed options, RDP bridge, or reservation precheck. **No definitive cause yet.**
5. Admin Activity screenshot (as above) contained successful RDP poll requests only; successful polling alone does not prove AIVID worker submission or file delivery.

## Merged change index and purpose

| PR | Description | Merge commit | Verified boundary |
| --- | --- | --- | --- |
| [#175](https://github.com/thesfjksa/vidancee-direct-saas/pull/175) | Preserve active AIVID upload/command during worker recovery; avoid refunding a live command just because a worker loses its lock | `6a98170b57cdcea5b0d7e2d66b265830b20edf6e` | Code, not production |
| [#176](https://github.com/thesfjksa/vidancee-direct-saas/pull/176) | Allow known AIVID `POST /v2/interactions/likes/bulk` background mutation without failing the submission guard | `1017b2f988616b0106d93a590d421bc679c7e382` | CI passed; live F12 problem persisted |
| [#177](https://github.com/thesfjksa/vidancee-direct-saas/pull/177) | Admin customer-specific deletion of terminal generations/media, with exact email confirmation and protected active jobs | `f165f5adcae78377d8733e3a63005fd41c68b94f` | Tool availability verified in repo, not executed in production |
| [#178](https://github.com/thesfjksa/vidancee-direct-saas/pull/178) | Keep waiting for verified `POST /v2/generations` response after a durable reservation; unrelated blocked POSTs cannot win the failure race | `da444a5aae09fde985ec46613763968637e92dd9` | CI passed; live success not proven |
| [#179](https://github.com/thesfjksa/vidancee-direct-saas/pull/179) | Register `Fetch.requestPaused` handler **before** `Fetch.enable`, avoiding a startup event lost while Chrome interception is being enabled; add `request_guard_setup` diagnostic | `ee7471934fbb41b1bc19bb2f3265936df5c45654` | Node, Windows real-Chrome / agent package, Admin browser CI passed; owner's live RDP failed later |
| [#180](https://github.com/thesfjksa/vidancee-direct-saas/pull/180) | Safe, explicit pre-click diagnosis in queue; `aivid.preparation_failed` Admin Activity entry with stage/code/bounded storage status; regression tests and handoff | `a63444b249176963ebd120fdacdc28bbfe0856ba` | Node, Windows agent, Admin browser/MySQL CI passed; **new diagnostics await deployment and real failure evidence** |

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

1. **Confirm actual deployments** of `main` including #180 to **both** Hostinger services: customer/API `https://cmmtools.site` (`server.js`, `WORKER_ENABLED=false`) and standalone worker `https://worker.mehroz.online` (`worker.js`, `WORKER_ENABLED=true`), using the shared MySQL database/settings. Inspect actual deployed revision and worker health; GitHub merge and HTTP 200 do not by themselves prove current code.
2. Confirm the Windows managed RDP agent is connected, using the latest hosted runtime, correct existing private Chrome profile, and a recent ready heartbeat. Avoid replacing credentials or re-pairing unless proven necessary. Preserve `receipts`, saved profile and credentials; never publish them in GitHub.
3. **Before another paid request**, match the failed CMMTools generation ID with AIVID account history and local receipt. If an upstream ID was accepted or is ambiguous, retain it for reconciliation; **never submit a replacement automatically** or refund an already-paid ambiguous source job without confirmation.
4. In Admin → **Activity**, filter by the **specific generation ID**, or search `aivid.preparation_failed`, and inspect the `stage`, `code` and optional `storageStatus`. Turn on the relevant category/level filter. The owner's earlier screenshot was only `request` poll information; avoid interpreting the lack of a visible error in that crop as absence of errors.
5. For `reference_storage`, inspect Admin Storage/bucket and prior 500 evidence; for `rdp_dispatch`, inspect RDP Agent console and server-side command state; for `reservation_precheck`, verify persisted source enabled/price ceiling and wallet state; for `browser_check`, inspect the exact last agent progress stage.
6. Perform **credit-free preflight/diagnostic checks first**. Only after production stages are understood and account history is reconciled should the owner authorize **one controlled no-F12** paid test. Verify provider acceptance ID, CMMTools processing, MP4 collection/storage, playback and credit balances. Do not rely on F12.
7. If the video was generated on AIVID but not delivered, prioritize **collecting the existing accepted ID**; do not regenerate. Collection failures back off and may pause for owner review. `retry_collection` should target the **existing** ID only.

## Remaining unknowns

- Whether the latest `main` and managed runtime are running on the owner's actual Hostinger and RDP machines.
- Exact cause of last pre-click generic failure (need stage-coded event from deployed #180, or carefully sanitized server/agent logs).
- Whether any of the owner's paid AIVID submissions were accepted and await collection, or only refunded before click.
- Whether R2 HTTP 500 is recurrent, transient, quota-induced or configuration-related, and whether requested customer storage cleanup actually freed space.
- Whether three-reference AIVID videos now complete **without F12**, and whether output MP4s reach customer CMMTools library with correct accounting.

**Safety:** Do not place API keys, Chrome DevTools URLs, OAuth tokens, secret headers, account cookies, pairing codes, full customer media, raw SQL credentials, or unredacted logs in handoffs. Keep post-click uncertainty for reconciliation rather than silently retrying or refunding a possible upstream accepted job.

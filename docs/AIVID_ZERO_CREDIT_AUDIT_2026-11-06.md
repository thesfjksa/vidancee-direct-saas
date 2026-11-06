# AIVID zero-credit customer-flow audit — 6 November 2026

## Scope and evidence

No new live generation, paid enhancement, wallet debit, or live reference-upload diagnostic was run during this audit. Provider writes in tests are mocked. Transaction tests use an isolated database double; CI additionally runs real MySQL locking/relay tests and installed Windows Chrome tests. The owner's existing public video was observed completed in the earlier investigation; transfer into CMMTools remains unconfirmed while the agent is disconnected.

## Findings fixed

| Customer/operator action | Failure found | Fix and regression evidence |
| --- | --- | --- |
| Recover an unavailable agent with an accepted video | Worker held the browser lock awaiting a collect command that could not be claimed | PR #156 skips unready collection, retains the ID and releases the lock; regression covers needs-login, starting, busy and stale heartbeat |
| Start an agent whose saved token was revoked | Agent exits; outstanding videos previously blocked replacement even if safely accepted | server-side offline pairing recovery; fresh Admin code can rotate an offline device with accepted IDs only; live devices, submitting jobs and uncertain IDs remain blocked |
| Switch model/settings during enhancement or upload | Button could re-enable and request could mix old/new selections | Independent in-flight guard and selection checks; actual UI functions exercised in isolated DOM/VM tests |
| Click Generate repeatedly while request is active | Model rendering could undo the button lock | In-flight guard refuses a second submission regardless of button state |
| Edit references while upload is pending | Uploaded files and role arrays could diverge | Stop before posting a generation; preserve edits for explicit review |
| Type the next prompt while the prior request completes | Clearing the previous request could discard new work | Preserve later prompt edits; regression covers completion during edits |
| Stay on a quote for a long time | Cache had no expiry | Premium cache expires after 15 seconds; other dynamic quotes after 30 seconds |
| Price/rate increases after the displayed quote | Fresh wallet charge could exceed the displayed amount | Website sends a maximum customer price; final user-rate calculation checks it before job/wallet writes; failure rolls back with 409 |
| Submit unsupported reference sizes/counts | Failure occurred later in the RDP worker | Validate hydrated/reused references before queuing/debit; 2.5 video/audio counts match the observed three-preview limit |
| An older job requires manual review | It could starve collection of other accepted jobs | Search a bounded active-job batch for collectable IDs; held jobs are preserved and do not prevent other completed videos being collected |

## Existing protections reviewed and regression suite retained

- All three Premium IDs remain distinct from 888API, with per-user access checks and offline/unavailable display.
- Public visibility, exact model/duration/resolution/ratio/prompt, positive price and source-credit ceiling are independently verified before source submission.
- Reference kinds, MIME, limits, preview readiness, byte hashes, presign/storage/save sequence and exact uploaded IDs are checked. Failed/mismatched uploads cannot authorize a paid POST.
- Durable reservation, local receipt, single outbound generation and duplicate-request guard remain intact. Ambiguous paid outcomes are held for reconciliation rather than automatically retried or refunded.
- Queue restarts distinguish preparation from reserved/accepted work. Disabled spending does not prevent collection of already accepted videos.
- Temporary public-page absence remains pending. Completed output must download, pass MP4/size/hash checks, transfer in verified chunks and commit storage before CMMTools reports completion.
- Refunds lock the generation row and check refunded_at; the same wallet credit cannot be returned twice. Completion and refund remain transactional.
- API retries use authenticated idempotency keys; duplicate concurrent API calls debit once. Website in-flight clicks are guarded; an ambiguous network failure still requires checking generation history before a new submission.
- Reused media, generation detail, downloads and deletion are scoped to the owner. Active jobs cannot be deleted. Pairing codes expire, are single-use, and credentials remain encrypted/revoked on replacement.

## Boundaries

This is a concrete regression audit, not proof of every possible future provider or customer behavior. No paid live acceptance was authorized. All three real model outputs, live reference-based generation, real wallet/source reconciliation, sustained RDP uptime, current user's completed download/storage and real production outage recovery still require live observation. A disconnected or rejected-credential Windows process must be restored by the owner; merging server code cannot start it. Do not describe the customer generation as recovered until its CMMTools status is completed and its stored MP4 plays/downloads.

## Server-only delivery

Owner requested no additional Windows launchers or repeated Windows installations.
All installed v2.1.6 files remain unchanged. Server-side pairing recovery can allow
an offline replacement while preserving accepted IDs. For a rejected saved token,
close Agent, rename only .aivid-agent.json to .aivid-agent.old.json in the existing
folder, then restart the same Agent and use a fresh Admin pairing code. This is a
one-time configuration reset; Chrome profile, receipts and program files remain.
Do not automatically trust a revoked token or bypass the Admin pairing code.

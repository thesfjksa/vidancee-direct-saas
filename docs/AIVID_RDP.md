# AIVID on the owner's Windows RDP

Owner setting (6 November 2026): every preflight and generation selects Public.
The form and outgoing request both verify public visibility. Price is read
after the switch, then checked against the saved source-credit ceiling.
Use the complete agent 2.0.5 ZIP for this behavior.

The RDP agent is an alternative transport for the existing AIVID browser
adapter and queue. Select **Windows RDP agent** in Admin and save it to stop
using Browserless for this provider. No database credentials or admin token
are given to Windows, and no public CDP port/tunnel is needed.

See [the portable agent setup](../scripts/aivid-rdp/README.md).

The first pairing creates `aivid_rdp_commands` and `aivid_rdp_chunks`. Existing
installations without CREATE permission can import [AIVID_RDP.sql](AIVID_RDP.sql)
using their database administrator, then retry. Normal reads do not issue DDL.

Admin creates a random single-use pairing code, stored hashed/encrypted with a
ten-minute expiry. Pairing consumes it under a MySQL advisory lock and replaces
the single agent credential. Replacement and transport changes are blocked
while AIVID generations are outstanding. The server stores only the token hash,
encrypted in app_settings; the Windows agent stores the token with current-user
DPAPI protection. Heartbeats are separate records so an old heartbeat cannot
restore a rotated credential. Status responses contain no tokens or Google data.

The agent polls `/api/aivid-rdp/poll` with a dedicated bearer credential.
MySQL compare-and-swap claims each command once across web processes. The
existing AIVID queue keeps its source advisory lock throughout each RPC.
The web process relays commands/results through MySQL, so the worker and web
service do not need to run in the same process or share a disk.

Submission sequence: prepare the browser, persist a local uncertain receipt,
request the server reservation, let the queue recheck submissions/price limits
and persist `click_reserved`, acknowledge that reservation, then click once
under the existing AIVID request guard. Request retries never rerun submission.
Before-click timeouts cancel the RPC before the queue's safe refund; after-click
uncertainty uses the existing held-submission/account-history reconciliation.
A worker crash can require owner reconciliation using the RDP's receipt and
actual AIVID history. It does not permit an automatic duplicate click.

References are served only for the paired device's current submit command;
size and SHA-256 must match the worker's metadata. MP4 transfers use 1 MiB chunks
to avoid database packet limits, enforce a 100 MiB cap, and check chunk order,
length, hash and MP4 header before returning bytes to the existing completion
path. Temporary commands/chunks are consumed on success or pruned after a day.

Preflight never generates or debits a wallet. The default source ceiling is 0,
new submissions are disabled, and customer models stay unregistered pending
a real video/reference test. Existing unrelated providers remain unchanged.

Native Chrome uses an isolated profile and an ephemeral loopback debugging port.
Manual login has no debugging, `--enable-automation`, `--no-sandbox`, security
disabling flags, or regular-profile copying. Closing the Playwright CDP transport
leaves independently launched Chrome running; this is tested on Windows.

The owner confirmed ordinary Chrome Google/AIVID login works on the RDP. That
does not establish that the new dedicated profile, production queue, downloads,
or disconnect/reboot behavior has been verified there. Those need the owner's
actual RDP and a permitted live trial; no RDP credentials are requested in chat.

## Customer model visibility (November 2026)

The three Premium choices (AIVID Seedance 2.0 Mini, 2.0, 2.5) stay visible
in Video Studio for customers whose AIVID source access is allowed, once the
AIVID source has been configured (paired RDP or saved browser session), even if
the Windows agent is offline, the browser session expires, or the source-credit
ceiling is zero. Such models display an **Unavailable** cost and a warning;
the Generate button is disabled for the selected model. A model becomes ready
after the Admin enables AIVID, sets a positive source-credit ceiling, and
brings the RDP agent online with status Ready. Refresh the customer Studio
page to load updated readiness. The price quote and AIVID worker still block
paid submissions when the provider is not ready.

If these choices do not appear at all, verify **both** Hostinger services have
deployed the latest GitHub main revision, refresh the browser without cached
assets, and check the customer's AIVID Source access in Admin → Users.

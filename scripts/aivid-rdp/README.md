# CMMTools AIVID managed worker 3.0.3

## One-time migration

Stop the old Agent. Extract this **complete ZIP into its existing folder**, keeping
`.aivid-rdp-edge-profile`, `.aivid-rdp-profile` (legacy backup), `.aivid-agent.json` and `receipts`. Open **AIVID-Agent.exe**.
If Google sign-in needs attention, close Agent, open **AIVID-Login.exe**, finish
sign-in, close its Microsoft Edge windows, then open Agent again. No extra repair
or update EXE is added. Rejected pairing opens the usual pairing window: obtain
a fresh code from Admin, paste it and Connect. An offline agent with accepted
source IDs can be recovered without generating another video.

## Routine operation

Keep Agent running in your Windows user session. It launches a persistent Microsoft Edge
profile, reuses one work tab, and polls CMMTools for commands. The server owns
waiting queues, charge limits, reservations, collection and retry policy. Up to
20 pending Premium jobs per customer and three default source jobs can coexist;
one browser operation runs at a time.

The stable worker.cjs bootstrap authenticates to the paired CMMTools HTTPS origin,
retrieves a six-file release manifest and verifies exact file names, size, SHA-256
and release identity before atomic activation. It never runs a partial release.
Routine adapter/native/command-handler updates come from the server. Updates are
checked while idle and activated only between jobs. Core protocol/Node/Edge/OS
changes can still require maintenance; this is not an unrestricted updater.
The CMMTools server is trusted to publish the worker code, so keep its Admin and
source repository access protected. Pairing tokens remain in Windows DPAPI and
are never placed in command-line arguments or logs.

## Safety warnings and existing paid videos

A Microsoft Edge security/lookalike warning stops collection and is reported to CMMTools.
The worker never clicks Ignore or disables browser security. Review the warning
manually. Generic collection errors back off and pause after three failures;
security warnings pause immediately. Paid source IDs, receipts and wallets remain
preserved. Retrying collection never creates a replacement video. Server Admin
reconciliation can retry_collection after the cause is reviewed.

Routine program updates do not move the profile or create a new pairing.
Disconnecting RDP must leave the Windows session/process running; signing out or
shutting down Windows stops the worker. This package does not change your Windows
login policy or install an unattended system service.

## Verification boundary

CI verifies bootstrap release integrity, authentication, incomplete/corrupt update
rejection, real Windows Microsoft Edge tab reuse, mocked provider submissions/uploads and
safe warning handling. No new paid generation is performed during this migration.
The owner's existing completed source video still needs a successful transfer
into CMMTools after the managed worker is installed and connected.

Version 3.0.1 fixes the bootstrap restart counter so verified runtime updates activate without stopping the launcher. Close Agent before extracting the complete package into its existing folder. Preserve `.aivid-agent.json`, `.aivid-rdp-profile`, `.aivid-runtime` and `receipts`. Do not copy only the EXE into a new folder.

## Microsoft Edge only

The Windows RDP agent now exclusively uses **Microsoft Edge**. There is no Chrome/Edge selector in Admin. The agent always reports `edge`; the server will not claim a new operation from an older Chrome agent. Browserless connection mode (if separately configured) is not affected.

To sign in, close the agent, install Microsoft Edge on the RDP, launch the current **AIVID-Login.exe**, complete sign-in in its private `.aivid-rdp-edge-profile`, close that Edge login window, then start **AIVID-Agent.exe**. Keep the complete current Windows ZIP in the existing folder. Preserve `.aivid-agent.json`, `.aivid-rdp-edge-profile`, `.aivid-rdp-profile` (old Chrome data), `.aivid-runtime` and `receipts`; do not reset pairing, cancel queued work, or resubmit uncertain paid generations. Check ready status before paid work. The browser engine remains Chromium-compatible, and form/credit/ref/collection workflows are unchanged.

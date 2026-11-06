# CMMTools AIVID managed worker 3.0.0

## One-time migration

Stop the old Agent. Extract this **complete ZIP into its existing folder**, keeping
`.aivid-rdp-profile`, `.aivid-agent.json` and `receipts`. Open **AIVID-Agent.exe**.
If Google sign-in needs attention, close Agent, open **AIVID-Login.exe**, finish
sign-in, close its Chrome windows, then open Agent again. No extra repair
or update EXE is added. Rejected pairing opens the usual pairing window: obtain
a fresh code from Admin, paste it and Connect. An offline agent with accepted
source IDs can be recovered without generating another video.

## Routine operation

Keep Agent running in your Windows user session. It launches a persistent Chrome
profile, reuses one work tab, and polls CMMTools for commands. The server owns
waiting queues, charge limits, reservations, collection and retry policy. Up to
20 pending Premium jobs per customer and three default source jobs can coexist;
one browser operation runs at a time.

The stable worker.cjs bootstrap authenticates to the paired CMMTools HTTPS origin,
retrieves a six-file release manifest and verifies exact file names, size, SHA-256
and release identity before atomic activation. It never runs a partial release.
Routine adapter/native/command-handler updates come from the server. Updates are
checked while idle and activated only between jobs. Core protocol/Node/Chrome/OS
changes can still require maintenance; this is not an unrestricted updater.
The CMMTools server is trusted to publish the worker code, so keep its Admin and
source repository access protected. Pairing tokens remain in Windows DPAPI and
are never placed in command-line arguments or logs.

## Safety warnings and existing paid videos

A Chrome security/lookalike warning stops collection and is reported to CMMTools.
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
rejection, real Windows Chrome tab reuse, mocked provider submissions/uploads and
safe warning handling. No new paid generation is performed during this migration.
The owner's existing completed source video still needs a successful transfer
into CMMTools after the managed worker is installed and connected.

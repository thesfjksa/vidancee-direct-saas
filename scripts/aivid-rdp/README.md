# AIVID Windows RDP runner 1.3

Chrome sandboxing is explicitly enabled for Preflight and Submit. This removes the old `--no-sandbox` launch flag; it does not guarantee that Google will allow account sign-in. Use **AIVID-Login.exe** for manual authentication, then close its Chrome windows before running Preflight. If `--no-sandbox` is still visible, close that old browser and verify the launcher says version 1.3.

This local runner prepares a text-only Seedance 2.0 (Mini) form and can submit one reviewed job. The Windows ZIP contains portable Node.js, Playwright and three EXE launchers. Google Chrome must already be installed; the EXEs require Windows x64 and .NET Framework 4.x.

## Sign in before starting automation

Google may reject authentication inside an automated browser. Version 1.1 adds a manual sign-in stage using installed Chrome, without Playwright, automation switches or remote debugging. It cannot guarantee Google account access and does not bypass an authentication challenge.

1. Extract the whole ZIP into a writable folder. When updating, close the runner and its Chrome first, overwrite the program files in the existing folder, and retain `.aivid-rdp-profile`, `receipts` and `trial.job.json`.
2. Open **AIVID-Login.exe**. Sign in to AIVID using Google yourself in the normal Chrome window. No password is entered into the runner terminal.
3. After AIVID shows you are signed in, close **all** windows of this separate AIVID Chrome profile. Your ordinary Chrome windows can remain open.
4. Open **AIVID-Preflight.exe**. It opens the saved profile with Playwright and allows up to 45 seconds for automatic session restoration. AIVID can briefly show Sign In before the saved account loads; the runner now waits for that to disappear and the generation form to stay ready before continuing. A genuine sign-out or loading timeout leaves the browser open for inspection until you press Enter in the terminal. Use the manual login launcher if a new Google sign-in is needed.
5. Review the local job, selected Mini model, duration, ratio and displayed credit price. Preflight does not click Generate.
6. For an intended paid test, open **AIVID-Submit.exe**, review the visible balance and price and type `SUBMIT`. The runner clicks Generate once.

The manual login launcher and runner use the same separate `.aivid-rdp-profile` folder, or the same `AIVID_RDP_PROFILE` setting. They never copy your ordinary Chrome profile or export session tokens. Keep the folder private on the RDP. If Google still rejects manual sign-in, stop and provide the exact visible error without credentials. Keep the RDP session open during a run.

## Local job and duplicate prevention

Preflight creates `trial.job.json` from the example when missing. Review it locally:

```json
{"jobId":"trial_mini_001","prompt":"A quiet river at dawn","duration":15,"aspectRatio":"16:9"}
```

Before Generate, a private receipt is written to `receipts/<jobId>.json`. A previously attempted job ID is refused even after a crash. Receipts retain the prompt hash, settings, status and recognized provider job ID, without credentials, raw API responses or signed URLs. If submission is uncertain, inspect AIVID My Videos before another attempt. A new job ID is only for an intentionally new generation.

## Checks and source use

Run any EXE with `--check` from a terminal to verify its packaged script/runtime without opening Chrome. For source use, install Node.js 20+ and run `npm install` and `npm test`; use `node login.mjs` first, close that Chrome profile, then `node runner.mjs trial.job.json` or `node runner.mjs trial.job.json --submit`. Installed Google Chrome is used; a separate Chromium download is unnecessary.

Windows build checks cover the three EXE launchers with a local stub, including paths containing spaces and Unicode, dependency checks, missing files and exit-code propagation. Unit tests check manual Chrome launch arguments and prevent duplicate paid submissions. These checks do not prove Google sign-in or a live paid generation works on the RDP.

## Integration status

The runner records submission acceptance/rejection only. CMMTools queue leasing, provider completion polling, MP4 retrieval/upload and transactional credit settlement/refund are not connected. It does not yet run unattended. Complete a verified paid end-to-end job and the durable bridge protocol before enabling a customer model. If a human challenge appears, pause for the owner; do not bypass it. Never commit profiles, receipts, prompts, tokens or signed output links.


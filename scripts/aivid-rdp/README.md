# AIVID visible-browser preflight (Windows RDP)

This is the first, **non-charging** stage of the proposed CMMTools bridge. It prepares one text-only Seedance 2.0 (Mini) form in a visible AIVID browser. It never clicks Generate, solves a CAPTCHA, reads customer queues, settles credits, or downloads output. It is not a live CMMTools provider.

1. On the Windows RDP machine, install Node.js 20+ and run `npm install` in this folder, followed by `npx playwright install chromium`. Run `npm test` to check input guards.
2. Create a local `trial.job.json` in this folder, for example `{"prompt":"A quiet river at dawn","duration":15,"aspectRatio":"16:9"}`. Use only your own test prompt at this stage; do not place production customer jobs in the file.
3. Run `node preflight.mjs trial.job.json` from this folder. Sign in normally in the visible browser if asked and press Enter in the terminal. Review the selected Mini model, prompt, duration, ratio and displayed credit price. Press Enter again to close. The browser profile stays only on that RDP machine in `.aivid-rdp-profile` and is excluded from Git; protect the RDP account and profile.

The site form was inspected on 2 November 2026 while signed out. The script verifies values after filling and stops if controls change. Signed-in behavior, CAPTCHA after Generate, AIVID job status/history, reference uploads, download links, and actual billing have not been validated. No paid request should be automated or retried after an ambiguous response.

For the next stage, map a real signed-in job history/status response and one completed output using the owner account, then implement a durable CMMTools queue handoff with a claim lease, provider job ID, reconciliation state, independent MP4 storage and transactional success/refund. Keep the customer-facing AIVID model disabled until a controlled end-to-end job succeeds and web/worker deployments are verified. Never commit sessions, RDP profiles, prompts, reference media, tokens or signed output links.

## One-job RDP runner (controlled test)

`runner.mjs` is a local, one-job test runner. It uses the Chrome installed on the RDP (`channel: 'chrome'`). The GitHub Actions **AIVID RDP runner ZIP** artifact bundles portable Node.js and local Playwright dependencies: download the ZIP from the successful workflow run, unzip it on the RDP, then double-click `run-preflight.cmd`. This requires no administrator installation or separate Chromium download. If running from source instead, Node.js 20+ and `npm install` in this folder are required. The browser profile is separate from your existing Chrome profile, so sign in to AIVID manually in the Chrome window it opens. Keep the RDP session open while testing.

Create `trial.job.json` locally (it is ignored by Git):

```json
{"jobId":"trial_mini_001","prompt":"A quiet river at dawn","duration":15,"aspectRatio":"16:9"}
```

The ZIP copies `trial.example.json` to `trial.job.json` on the first preflight. Edit the local job file if needed. Double-click `run-preflight.cmd` to prepare the form only; it will not click Generate. To make one real submission, double-click `run-submit.cmd` (or run `node runner.mjs trial.job.json --submit` from source). The script verifies visible AIVID balance and price, asks you to review the form and type `SUBMIT`, then clicks Generate **once**. AIVID may charge credits. The current demo account showed zero credits, so the runner refuses a paid click there. Do not use production customer prompts in this local test.

Before the click, the runner writes `receipts/<jobId>.json`. It refuses to reuse that job ID even if the process crashes or the response is unclear. The receipt stores only the prompt hash, selected settings, HTTP status and recognized provider job ID; it does not store account credentials, prompt text, raw API responses or signed URLs. Keep the profile and receipts private on the RDP. If the result is `submission_uncertain`, inspect AIVID My Videos and reconcile manually before any new attempt. Use a new job ID only for an intentionally new generation, never to retry an ambiguous paid click.

**Current boundary:** this runner records submission acceptance/rejection only. It does not poll for a completed video, download MP4, accept CMMTools customer jobs, upload outputs, settle/refund credits, or run unattended. No visible CAPTCHA was observed in the demo zero-credit test; if a challenge appears in a later paid flow, stop for the owner rather than bypassing it. Keep the CMMTools customer model disabled until a paid end-to-end test and durable bridge protocol are implemented.

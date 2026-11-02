# AIVID visible-browser preflight (Windows RDP)

This is the first, **non-charging** stage of the proposed CMMTools bridge. It prepares one text-only Seedance 2.0 (Mini) form in a visible AIVID browser. It never clicks Generate, solves a CAPTCHA, reads customer queues, settles credits, or downloads output. It is not a live CMMTools provider.

1. On the Windows RDP machine, install Node.js 20+ and run `npm install` in this folder, followed by `npx playwright install chromium`. Run `npm test` to check input guards.
2. Create a local `trial.job.json` in this folder, for example `{"prompt":"A quiet river at dawn","duration":15,"aspectRatio":"16:9"}`. Use only your own test prompt at this stage; do not place production customer jobs in the file.
3. Run `node preflight.mjs trial.job.json` from this folder. Sign in normally in the visible browser if asked and press Enter in the terminal. Review the selected Mini model, prompt, duration, ratio and displayed credit price. Press Enter again to close. The browser profile stays only on that RDP machine in `.aivid-rdp-profile` and is excluded from Git; protect the RDP account and profile.

The site form was inspected on 2 November 2026 while signed out. The script verifies values after filling and stops if controls change. Signed-in behavior, CAPTCHA after Generate, AIVID job status/history, reference uploads, download links, and actual billing have not been validated. No paid request should be automated or retried after an ambiguous response.

For the next stage, map a real signed-in job history/status response and one completed output using the owner account, then implement a durable CMMTools queue handoff with a claim lease, provider job ID, reconciliation state, independent MP4 storage and transactional success/refund. Keep the customer-facing AIVID model disabled until a controlled end-to-end job succeeds and web/worker deployments are verified. Never commit sessions, RDP profiles, prompts, reference media, tokens or signed output links.

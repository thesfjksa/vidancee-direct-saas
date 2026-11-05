# AIVID → CMMTools owner-operated bridge

## What's confirmed and what's missing
AIVID's customer-facing API previously accepted POST https://api.aivid.dev/v2/generations for a paid generation. Its reference-file upload flow used POST /v2/uploads/presigned-url, upload to presigned S3 multipart URL, and POST /v2/uploads/presigned-save. The tested browser requests carried a signed-in session bearer JWT and generation CAPTCHA token.

**Not confirmed:** a permanent service API key, a documented unattended provider contract, and the exact customer job-status GET route. The browser flow observed on a zero-credit demo account showed no on-screen CAPTCHA; the browser request may still carry an automatic anti-bot token. A zero-credit Generate click reached an Out of Energy dialog and did not create a job. Nothing in this branch changes CMMTools billing, switches, models or production worker behavior.

## Recover the read-only status contract safely
1. Log in normally to https://aivid.dev using your own Google account.
2. Open browser Developer Tools → Network → Fetch/XHR and inspect only your own job-history/status GET requests. Write down route paths and response *field names*, not credentials, cookies or signed video URLs.
3. Optionally run Node.js 20+ diagnostic scripts/aivid-readonly-probe.mjs against candidate read routes only. It prints HTTP statuses and JSON field-name shapes, never sensitive values. On Windows PowerShell enter your token without placing it in the command history:

   $secret = Read-Host 'Your own AIVID bearer token' -AsSecureString
   $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
   try { $env:AIVID_SESSION_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
   finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
   node scripts/aivid-readonly-probe.mjs
   Remove-Item Env:\AIVID_SESSION_TOKEN

If you know one of your own completed hexadecimal job IDs, set AIVID_JOB_ID temporarily for an additional read-only check. **Never send bearer tokens, raw HAR exports, customer media or S3 signed URLs to developers, GitHub issues or chat.** If a token was previously exposed, revoke that session via authorized account security controls.

## Integration routes

**Temporary manual fulfillment:** CMMTools queues an order and reserves credits. A trusted operator submits the job at AIVID through the normal website. If the site presents a human challenge, the operator handles it normally. On success, upload the output MP4 to CMMTools-owned storage and settle credits; on failure refund.

**RDP browser bridge (intended next stage):** a runner on the owner's Windows RDP polls a CMMTools HTTPS queue for a leased job, drives the ordinary AIVID UI in a locally signed-in browser, and returns the provider job ID and completed MP4 to CMMTools-owned storage. CMMTools must reserve credits before dispatch and settle or refund exactly once after verified output or failure. AIVID has shown no on-screen CAPTCHA in the observed zero-credit flow, so a human challenge is not a required step per job. If login expires or a human challenge appears, pause the job for an operator; do not bypass the challenge. Never retry an ambiguous paid Generate click without reconciling AIVID history. The runner must authenticate to CMMTools with a restricted, revocable bridge credential; it must not expose RDP or AIVID session secrets. Browser behavior and account credit limits still prevent promising 24/7 unattended success.

**Production provider API:** recover AIVID hosting/backend ownership from registrar/cloud provider using official proof-of-ownership and account-recovery procedures. Domain DNS control alone does not give database access. First back up code, database and storage; move billing, recovery email and organization ownership under your control; then add a documented restricted server API key supporting upload, generate and poll/webhook, with idempotency, rate limits and reconciliation. Build a CMMTools provider queue matching existing adapters, storing secrets encrypted in Admin, persisting outputs to independent storage and refunding failed jobs.

## Required gates before enabling customers
- Confirm exact authenticated GET job-status endpoint and status schema.
- For the RDP bridge, establish a restricted CMMTools-to-runner credential and test lease/heartbeat/claim expiry. A permanent AIVID service API credential is required only for a direct provider API route.
- Test legitimate reference upload, a single accepted paid job, completion/failure, duplicate request prevention, session expiry and credit refund.
- Save finished MP4s promptly: provider S3 output URLs are signed and expire.
- Keep any new provider disabled until the full paid workflow is tested.

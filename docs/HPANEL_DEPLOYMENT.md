# Hostinger hPanel Deployment

The repository is designed to deploy directly from GitHub to Hostinger's Node.js application hosting.

## GitHub repository

```text
thesfjksa/vidancee-direct-saas
```

Use the `main` branch.

## Runtime

```text
Node.js: 20+ (22 is also fine)
Entry file: server.js
Start command: npm start
Build command: none
Output directory: none
```

This milestone has no third-party npm dependencies.

## Required hPanel environment variables

```env
VIDANCEE_BASE_URL=https://vidancee.com
VIDANCEE_EMAIL=YOUR_PROVIDER_EMAIL
VIDANCEE_PASSWORD=YOUR_PROVIDER_PASSWORD
ADMIN_TOKEN=LONG_RANDOM_SECRET
ALLOW_PROVIDER_CHARGES=no
```

Do not commit real values to GitHub.

Hostinger supplies `PORT`; normally do not create your own `PORT` variable unless the platform explicitly requires it.

## First deployment test

After Hostinger reports a successful deployment, open:

```text
https://YOUR_DOMAIN/health
```

Expected shape:

```json
{
  "ok": true,
  "app": "vidancee-direct-saas",
  "milestone": 1,
  "providerChargesEnabled": false
}
```

Then open:

```text
https://YOUR_DOMAIN/
```

Paste the `ADMIN_TOKEN` into the private test console and click **Check Vidancee login**.

A successful result should include provider credits, concurrency, processing count, and returned job history.

## Paid generation test

Only after the provider health test succeeds:

1. Change `ALLOW_PROVIDER_CHARGES` from `no` to `yes`.
2. Redeploy/restart the app.
3. Submit one 10-second test generation.
4. Refresh jobs until the matching provider job reaches `completed` or `failed`.
5. Return `ALLOW_PROVIDER_CHARGES` to `no` if you do not want accidental spending during development.

## Security

Never commit:

- Vidancee password
- PHPSESSID
- CSRF tokens
- ADMIN_TOKEN
- database passwords
- payment secrets

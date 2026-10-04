# Vidancee Direct SaaS

Fresh SaaS project for an authorized server-side Vidancee integration.

## Current milestone

**Milestone 1 — direct provider connector**

Implemented:

- Vidancee login using `GET/POST /login.php`
- PHP session cookie handling
- Studio CSRF extraction from `meta[name="csrf-token"]`
- Text-to-video submission through `POST /api/generate.php`
- Job polling through `GET /api/jobs.php?limit=12&status=finished&with_active=1`
- Provider health/status test
- Admin-only test console
- Provider-credit spending disabled by default
- Hostinger/hPanel deployment documentation
- Project handoff documentation for continuation in another LLM/chat

Not implemented yet:

- customer accounts
- our own credit ledger
- MySQL
- production queue/worker
- image-to-video submission
- payments
- customer-facing dashboard

## Local/production start

Node.js 20+.

```bash
npm start
```

Health check:

```text
GET /health
```

Provider test console:

```text
GET /
```

Configure secrets only through environment variables. Never commit real provider credentials, PHPSESSID values, CSRF values, database passwords, or admin tokens.

See:

- `docs/PROJECT_HANDOFF.md`
- `docs/VIDANCEE_PROTOCOL.md`
- `docs/HPANEL_DEPLOYMENT.md`

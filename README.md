# Vidancee Direct SaaS

Fresh SaaS project for an authorized server-side Vidancee integration.

## Current milestone

**Production SaaS — multi-provider generation platform**

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

Current major capabilities include:

- customer accounts, plans, credits, and MySQL persistence
- production generation queue/worker
- text-to-video and reference-driven video generation
- image generation workspace
- Admin-managed provider credentials and global provider switches
- per-customer provider/source assignments
- dynamic Higgsfield MCP image/video model catalog and capability-driven inputs
- Vidancee/CreatePulse Seedance routing
- MiniMax H3 through vgenv
- Atlas Cloud image generation
- customer-facing model filtering based on source assignment

## Local/production start

Node.js 20+.

Web/API process:

```bash
npm start
```

Standalone generation worker:

```bash
npm run worker
```

### Production Hostinger architecture

Production uses two separate Hostinger Node.js applications:

- `https://ai.mehroz.online` → `server.js` with `WORKER_ENABLED=false`
- `https://worker.mehroz.online` → `worker.js` with `WORKER_ENABLED=true`

Both applications use the same MySQL database and Admin-managed provider settings.

This separation is production-verified: the worker can process queued generations independently while the customer web application remains isolated from provider/queue workload.


Health checks:

```text
Main lightweight liveness: GET /live
Main full health:          GET /health
Worker health:             GET /health on worker.mehroz.online
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

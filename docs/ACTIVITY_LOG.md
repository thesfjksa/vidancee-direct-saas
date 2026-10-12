# Activity log and support access

Every action in CMM Tools is recorded in the `activity_log` table (kept 30 days, pruned hourly by the worker).

## What is recorded

| Category | Events |
| --- | --- |
| request | Every customer action that changes something (POST/PUT/DELETE on `/api`), and any request that fails, with the signed-in user, status, time and error message. Price quotes and status polls are logged only when they fail. |
| generation | Each video, image and upscale job created: model, duration, resolution, price, prompt and the saved plan (render resolution, HD enhancement). |
| provider | Job sent to a provider, the exact ArgoLink request body, ArgoLink accepted (request id), each ArgoLink status change with the full reply (error code, message, `retryable`), retries, fal upscale request/status, Vidancee/CreatePulse/vgenv submissions and results, SmartAIPI results, out-of-credits marks, image jobs moved to ArgoLink, queue errors. |
| refund | Every refund and failure, with the message the customer saw and the amount. |
| admin | Every Admin action; saved settings list what changed. |
| system | Web app and worker start/stop. |

API keys, passwords, tokens, signed-link signatures and media data are masked before anything is stored.

## Reading it

- **Admin → Activity**: filter by level, category, search text or generation ID; click a row for its details; **Live** refreshes every 5 seconds.
- **Support access** (Admin → Activity → Support access): **Create new key** shows a read-only key once. With it, these routes work (send the key in the `x-support-key` header):
  - `GET /ops/activity?limit=&level=&category=&provider=&generation=&user=&q=&minutes=&before=`
  - `GET /ops/generations?status=&provider=&limit=` and `GET /ops/generations/{id}` (job details plus its activity)
  - `GET /ops/health`
  Customer emails are masked; the key cannot change anything or read API keys. Only its SHA-256 hash is stored. **Revoke key** disables it at once.

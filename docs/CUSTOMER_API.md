# CMM Tools customer API

Customers use the website or their own applications with the same account, model permissions, price rate, plans, credit balance, generation queue, refunds and private library. The upstream provider key stays in the existing encrypted Admin settings. Customer keys do not expose it.

The public, branded developer guide is available at `/developers/docs`, linked from the API key dashboard at `/developers`. It includes endpoint and parameter reference, file limits, billing and retry behavior, troubleshooting, and Python/Node.js examples. Both pages use the shared CMM Tools brand stylesheet and logo.

## Customer setup

1. Sign in at `/app` and open **Account menu → Developer API & keys**, or visit `/developers`.
2. Create a named key, expiring in 30, 90 or 365 days. Copy it immediately; only its SHA-256 hash and display prefix are stored. Up to ten unexpired, unrevoked keys are allowed per account.
3. Keep the key in a server environment variable, never a browser frontend. Use `Authorization: Bearer cmm_live_…` on `/v1/*` endpoints.
4. Discover account-enabled models with `GET /v1/models`. Use the exact returned public model ID, supported settings and reference capabilities.
5. Request a quote, then create a job with a unique `Idempotency-Key`. Poll every 5–10 seconds, then download the completed content with the same authorization header.

API generation is asynchronous for both video and images. Creation returns **202** and a job object, not an immediate image array. This is a CMM Tools REST contract, not full OpenAI SDK compatibility. Customer-facing model labels and IDs follow the existing studio catalog.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/v1/models` | Account-enabled video/image models, settings, capabilities and available credit pricing |
| GET | `/v1/balance` | Current shared credits |
| GET | `/v1/usage` | API jobs, reserved/refunded/net credits grouped by customer key |
| POST | `/v1/quotes` | Quote with `mediaType: "video"` or `"image"`; does not reserve funds |
| POST / GET | `/v1/videos` | Create / list video jobs |
| GET | `/v1/videos/{id}` | Read an owned video job |
| GET | `/v1/videos/{id}/content` | Download an owned completed output |
| POST / GET | `/v1/images/generations` | Create / list image jobs |
| GET | `/v1/images/generations/{id}` | Read an owned image job |
| GET | `/v1/images/generations/{id}/content` | Download an owned completed image |

The lists include the customer's studio jobs as well as API jobs. Usage summaries include API-created jobs only, and exclude deleted jobs; the existing `credit_transactions` ledger remains the financial record. Existing Admin credit management, plans, per-user pricing and model controls remain authoritative. No new payment processor is introduced.

## Example

```bash
export CMM_API_KEY='YOUR_CUSTOMER_KEY'
# Save this value. For retries, rerun only curl with this SAME value.
REQUEST_ID=$(uuidgen)

curl https://cmmtools.site/v1/models \
  -H "Authorization: Bearer $CMM_API_KEY"

curl https://cmmtools.site/v1/videos \
  -H "Authorization: Bearer $CMM_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $REQUEST_ID" \
  -d '{"model":"ID_FROM_MODELS","prompt":"A cinematic sunrise","duration":5,"resolution":"720p","aspectRatio":"16:9"}'

# Save the returned id as JOB_ID; poll until completed or failed.
curl "https://cmmtools.site/v1/videos/$JOB_ID" \
  -H "Authorization: Bearer $CMM_API_KEY"
curl -L "https://cmmtools.site/v1/videos/$JOB_ID/content" \
  -H "Authorization: Bearer $CMM_API_KEY" -o video.mp4
```

Use supported duration, resolution and ratio values from the selected model. For images, POST `/v1/images/generations` with `model`, `prompt`, `aspectRatio`, and any supported `quality` / `imageSize`. Supply `Idempotency-Key` for images too.

## References

Use `multipart/form-data` with `images`, `videos` and `audios` file fields. Other fields use the same names as JSON. `referenceOrder`, `videoRoles` and `audioRoles` carry JSON arrays when the model requires roles. Query `capabilities` first. The shared studio parser enforces 24 files / 100 MB total and per-file maximums of 10 MB image, 25 MB video and 15 MB audio; model limits can be lower. JSON reference URLs or client-supplied file objects are rejected. Native API inputs cannot override billing or internal generation metadata.

The existing studio pipeline decides supported modes: this feature does not enable upstream capabilities currently disabled by CMM Tools, including unavailable 888API reference-video transport or image editing. Existing Admin import/sync continues to discover 888API models; unknown, unpriced, disabled or unhealthy routes are not automatically made sellable.

## Retry and billing guarantees

`Idempotency-Key` must contain 8–128 printable non-space ASCII characters. Its namespace is per account, across all customer API keys and both image/video endpoints. The normalized request (including reference bytes and order) is hashed. An identical retry returns the existing job with HTTP 200 and `Idempotency-Replayed: true` when detected before submission. Concurrent first submissions may both return 202, but reference the same job.

The generation transaction locks the user row, rechecks key validity, looks for a prior request, and records the job, credit debit and request mapping together. Identical retries do not charge again even if the balance has since been spent. A different payload returns 409. A deleted job retains a request tombstone and returns 410, preventing accidental resubmission. Rolled-back requests can be retried. Refunded failed jobs retain the same ID; creating a fresh attempt requires a new request ID and can incur a new charge.

Keys are limited to 120 authenticated requests per fixed UTC minute, persisted in MySQL across server processes and restarts. Existing plan concurrency limits also apply. Revocation and expiry block subsequent requests and are rechecked inside the charging transaction. Revoking a key does not cancel already accepted jobs. Keys have full access to the issuing customer's API-visible jobs, models and balance; key-level spending caps and restricted model scopes are not part of this version.

Key creation/revocation endpoints (`/api/developer/*`) accept only a signed-in website session, require a custom management header on mutations and reject foreign Origin headers. A customer API key cannot manage other keys or authenticate to Admin/session endpoints. Keep all traffic on HTTPS.

## Deployment

This is a change to `thesfjksa/vidancee-direct-saas`; it uses the existing Hostinger web/worker architecture and MySQL. No separate Sites deployment is needed.

1. Apply `docs/migrations/20261103_customer_api.sql` with a MySQL account permitted to create tables **before** redeploying if the runtime database account has CRUD-only permissions. `initDb` can create missing tables automatically when its account has CREATE permission.
2. Deploy the same code revision to the web app and worker. No new runtime secrets or provider credentials are required.
3. Confirm `/health` reports the database connected; visit `/developers`, create a key and check `/v1/models` and `/v1/balance`.
4. With a funded test account, submit one small job, retry the identical request ID, and verify one generation debit, correct status and authenticated download. Confirm the job is visible in the studio. A paid production smoke test was not performed during implementation.

Do not rotate or replace the owner's existing 888API credentials. Customer credits and imported model enablement are not changed by installing this feature. Browsers are not granted cross-origin API access; customer applications should call from their own server.


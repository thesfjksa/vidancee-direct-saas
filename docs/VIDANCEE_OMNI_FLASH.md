# Vidancee Omni Flash integration (29 October 2026)

Source: Vidancee website session, not CreatePulse API. Project: https://cmmtools.site.

## Verified evidence and scope
The owner's Vidancee jobs JSON displayed a completed text-to-video job **26394**, model `Omni-Flash`, duration 4 seconds, ratio 9:16, provider cost **30 Vidancee credits** and an `output_url` relative to the Vidancee website. That record proves completion in the owner's account; it does not prove CMMTools has yet submitted and downloaded an Omni Flash job.

Only that mode, duration and ratio are listed in the new `vd_omni_flash` model. Additional durations, 16:9, image reference uploads, reference video and audio inputs remain disabled until documented and tested.

## Implementation
- `src/vidancee_models.js`: isolated catalog and per-clip quote. Provider 30 credits are represented as a USD-equivalent pricing **calculation only** to reuse the existing `quoteGateway` interface; they are **not a USD Vidancee charge**. Server record uses `provider_cost_unit=vidancee_credits`.
- `src/provider/vidancee.js`: retrieves login CSRF, posts authorized session email/password, retains PHP session and studio CSRF, submits one multipart generation without retry, polls job list by exact provider ID, downloads MP4.
- `src/vidancee_queue.js`: uses existing queue claim/heartbeat/refund handling, persists provider job ID before polling, and does not retry ambiguous charged POSTs.
- Admin source settings store login email and password encrypted. Enter them through Admin Providers, not in this document or code.
- New model/source is gated by Admin source switch and customer source access; global provider charge switch still applies.

## Deployment and checks
1. Run `npm test` and verify the new mock tests and existing queue tests. A successful GitHub merge alone does **not** prove deployment.
2. Deploy same revision to both web and worker, verify their health, DB write permissions and queue polling.
3. Save Vidancee email/password in Admin and use `Check website session` (read-only). Allow one approved account access and ensure the 4-second catalog row appears.
4. With owner approval and sufficient account credits, submit one 4-second job and verify its exact ID in Vidancee jobs, background status, MP4 download, final CMMTools output, and financial credit record.
5. Keep any unverified generation settings disabled. Do not automatically repeat a submit after a network failure. Check Vidancee session 403, pricing and status pagination if generation stalls.

Historical Vidancee was retired on 20 October because its old jobs returned 403. New Omni Flash requires a fresh read-only login check before activating customer use. Never commit sessions, login credentials, or signed URLs.

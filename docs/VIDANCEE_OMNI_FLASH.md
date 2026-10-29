# Vidancee Omni Flash integration (29 October 2026)

Source: Vidancee website session, not CreatePulse API. Project: https://cmmtools.site.

## Verified evidence and scope
The owner's Vidancee jobs JSON displayed a completed text-to-video job **26394**, model `Omni-Flash`, duration 4 seconds, ratio 9:16, provider cost **30 Vidancee credits** and an `output_url` relative to the Vidancee website. That record proves completion in the owner's account; it does not prove CMMTools has yet submitted and downloaded an Omni Flash job.

The owner's 29 October screenshot also showed Vidancee accepting Omni Flash image-reference job **26443** (4 seconds, 9:16), and a subsequent screenshot shows the resulting clip **Done** in the Recent list. The new screenshot displays the successful request's exact **Payload**:

```text
mode=image-to-video
model=Omni-Flash
duration=4
aspect_ratio=9:16
prompt=ad of this poster
quantity=1
images[]=(binary)
max_retries=0
```

This confirms one working image reference and the payload fields. The generated video is complete on Vidancee, **not** yet a CMMTools-to-Vidancee end-to-end verification. The Vidancee cost of this image job is not visible in the screenshot.

CMMTools enables **one JPEG/PNG/WebP image (up to 10 MB), 4s, 9:16** in addition to text-to-video. This uses the **now-confirmed** Omni Flash website request: multipart `mode=image-to-video`, `images[]` containing binary image data, and `max_retries=0`. Do not restore the older Seedance `max_retries=3` setting for Omni Flash. More images, start/end frames, reference video/audio, other durations and ratios remain disabled. The 30-source-credit price comes from an earlier **text-to-video** record; Omni Flash image-mode cost has not been independently confirmed and must be checked before offering it for paid customer use.

## Implementation
- `src/vidancee_models.js`: isolated catalog and per-clip quote. Provider 30 credits are represented as a USD-equivalent pricing **calculation only** to reuse the existing `quoteGateway` interface; they are **not a USD Vidancee charge**. Server record uses `provider_cost_unit=vidancee_credits`.
- `src/provider/vidancee.js`: retrieves login CSRF, posts authorized session email/password, retains PHP session and studio CSRF, submits text or image mode through multipart `generate.php` **with an inline binary `images[]` Blob** (not a public signed URL). Does not re-submit the paid POST. Polls jobs by exact ID and downloads MP4.
- `src/vidancee_queue.js`: uses existing queue claim/heartbeat/refund handling, loads stored reference bytes from `generation_media` (including R2 hydration), persists provider job ID before polling, and does not retry ambiguous charged POSTs.
- Admin source settings store login email and password encrypted. Enter them through Admin Providers, not in this document or code.
- New model/source is gated by Admin source switch and customer source access; global provider charge switch still applies.

## Deployment and checks
1. Run `npm test` and verify the new mock tests and existing queue tests. A successful GitHub merge alone does **not** prove deployment.
2. Deploy same revision to both web and worker, verify their health, DB write permissions and queue polling.
3. Save Vidancee email/password in Admin and use `Check website session` (read-only). Allow one approved account access and ensure the 4-second catalog row and Add image control appear.
4. With owner approval and sufficient account credits, submit one authorized 4-second text or image job, first confirming image-mode charge and the exact Payload fields, then verify its exact ID in Vidancee jobs, background status, MP4 download, final CMMTools output, and financial credit record.
5. Keep any unverified generation settings disabled. Do not automatically repeat a submit after a network failure. Check Vidancee session 403, pricing and status pagination if generation stalls.

Historical Vidancee was retired on 20 October because its old jobs returned 403. New Omni Flash requires a fresh read-only login check before activating customer use. Never commit sessions, login credentials, or signed URLs.

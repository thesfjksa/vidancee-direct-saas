# Story Studio: English narrated stories

Story Studio is available at `/story` after customer sign-in. One prompt creates a saved storyline, 1–3 character portraits, eight 15-second MiniMax H3 Cinematic scenes, eight English narration segments and one assembled MP4. Both landscape and vertical formats are supported. References guide identity; perfect character consistency is not guaranteed. The video output is 768p, normalized to 24 fps. No music, subtitles, crossfades or lip-sync are included in this first version. Original clip audio is replaced with narration and silence padding.

## Required setup

1. Deploy the same revision to the customer web app and the standalone worker host's **web parent process** (`server.js`). This story scheduler runs in that parent alongside the existing generation child. A deployment that runs only `worker.js` does not run the story scheduler. Keep customer `WORKER_ENABLED=false`; keep worker host `WORKER_ENABLED=true`. Both must share MySQL and the same provider settings.
2. Configure working AI Gateway, 888API, vgenv and Vibi connections in existing Admin provider settings. They must be enabled and visible to the customer, and provider charges must be permitted. The production 888API connection reset remains a separate issue; it must be resolved before character generation can succeed.
3. Import and enable 888API `gpt-image-2-1k`. This change adds that already mapped image adapter to the offered catalog. The default public ID is `api888_gpt_image_2_1k`; a previously unsupported saved row needs a fresh live import. An alternate reviewed, ready 888API image adapter can be selected via `STORY_IMAGE_MODEL`.
4. Set these environment values **on both web and worker**:

   ```dotenv
   STORY_STUDIO_ENABLED=true
   STORY_TEXT_MODEL=your-configured-ai-gateway-text-model-id
   STORY_IMAGE_MODEL=api888_gpt_image_2_1k
   STORY_ENGLISH_VOICE_ID=your-available-vibi-elevenlabs-english-voice-id
   STORY_VOICE_MODEL=eleven_multilingual_v2
   ```

   Select a text model that supports OpenAI-compatible chat completions and JSON object output. No new key is bundled or accepted from customers. Use an existing accessible English voice from Voice Studio; no voice cloning is performed. Verify narration speed with the selected voice before enabling customer access.
5. Install `ffmpeg` (libx264 and AAC enabled) and `ffprobe` on the worker host. `FFMPEG_PATH` / `FFPROBE_PATH` override their executable paths. Provide writable temporary disk space. Rendering uses at most two video-encoder threads and one story globally at a time. New/resumed stories wake the standalone worker, and the existing minute heartbeat keeps it awake while a story is active. If Hostinger cannot run these executables, use a worker host that can; a web-only deployment cannot assemble a final video.
6. First enabled startup creates `stories`, `story_steps` and `story_output_chunks` using the existing schema helper. Existing tables are probed before requesting CREATE rights. A database administrator must create the tables from `src/story_store.js` if the application account lacks CREATE rights.
7. Restart the worker-host parent process and customer web process. Visit `/story` while signed in, choose a format and maximum credits, and enter the prompt. Check provider access and real media outputs with an authorized acceptance test. Merge and synthetic tests do not establish live provider success.

## Billing and recovery

Image, speech and video child jobs use existing customer debit/refund transactions and plan concurrency. Story-step receipts are committed in those same transactions, including voice generation. Restarting the story orchestrator after a committed debit returns that generation rather than creating another. The customer's maximum applies to net child generation credits after refunds. It is checked transactionally before each child submission commits. Exhausted wallet, credit limit or unavailable services pause the story as failed, preserving completed work. Planning uses the owner's AI Gateway account and is not added to customer credits in this version; the owner must choose the model and accept that cost before enabling.

The page shows saved storyline, stage, child statuses and charged credits. Retry preserves completed children and assembly retries do not create new generations. Only explicitly retried, failed/refunded children are replaced. Unconfirmed submissions require Admin reconciliation; they are not automatically resubmitted. A planner call interrupted before saving its result is also held for an explicit retry, because the provider may have charged. The retry button explains this consequence. Plan-concurrency HTTP 429 waits for the next cycle.

Stopping prevents future stages. Already accepted provider jobs continue under their normal billing/refund rules. Cancellation does not promise cancellation at the provider. Child jobs remain in their existing libraries. Deleting a child that a story needs can prevent story completion.

Each scene narration is limited to 15–28 words. Assembly verifies the actual audio duration and stops instead of truncating speech longer than 15 seconds. A slow or unsuitable voice requires operator review; this first version does not expose per-scene script editing or replacement of completed narration. Eight scenes are normalized to 15 seconds each and the final duration must measure within 150 ms of 120 seconds. Short source clips are held on their final frame. This is not a guarantee that a provider delivered 15 seconds of unique motion.

Final output uses configured cloud object storage when available, with checksum-verified streaming upload under `stories/<story-id>/final.mp4`. Otherwise it uses transactional 1 MiB MySQL chunks (maximum final size 128 MiB). Child media downloads are bounded, remote URLs use the existing DNS-checked downloader, and FFmpeg receives local files with restricted input protocols. Temporary assembly files are removed on success/failure. Story media is authenticated and scoped to its owner, with byte-range playback.

## Validation performed

Eight focused Story Studio tests cover plan validation, complete mocked orchestration, restart/replay behavior, ambiguous submission handling, credit caps, voice rollback, owner isolation, cross-origin rejection, checksum-verified cloud upload and render arguments. A real local FFmpeg smoke test assembled eight synthetic scenes with tone narration into a 120.02-second MP4. This used no provider key or paid generation. Existing provider, visibility and original-extension checks are also run. A real browser acceptance test, MySQL integration deployment and paid end-to-end story generation remain pending.

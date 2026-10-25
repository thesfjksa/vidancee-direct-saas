# Cloud storage (Cloudflare R2 / S3-compatible)

Primary storage for generated videos, generated images and uploaded reference files, replacing MySQL BLOBs and Google Drive. Implemented in `src/object_storage.js` (dependency-free AWS Signature V4 client) and `src/r2_migration.js`. Works with any S3-compatible bucket: Cloudflare R2, Backblaze B2, Wasabi or AWS S3.

## Setup (owner, about 10 minutes)

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket**, for example `cmmtools-media`. Keep it private: no public access and no custom domain.
2. R2 → **Manage R2 API Tokens** → **Create API token** with **Object Read & Write**, limited to that bucket. Copy the **Access Key ID** and **Secret Access Key**; the secret is shown once.
3. Copy the bucket's **S3 API** endpoint from its Settings page, `https://<account-id>.r2.cloudflarestorage.com`, without the bucket name.
4. CMM Tools **Admin → Storage → Cloud storage**: enter the endpoint, bucket, Access Key ID and secret, then click **Test and save**.

Saving writes, reads and deletes a small test file first, so wrong keys or bucket names are rejected. On success:
- new videos are saved to the bucket (`output_url = r2:videos/<generation-id>.mp4`);
- the worker moves old MySQL videos to the bucket one at a time.

The secret is stored encrypted in `app_settings` and never returned.

## How it works

- **Saving:** `saveVideoOutput` tries cloud storage first, then Google Drive, then MySQL. Each upload is checked against its MD5 (`Content-MD5` header, then ETag).
- **Playback and download:** after the usual ownership checks, the browser is redirected to a private link that expires after 1 hour. Downloads add `download=1`, so the file arrives as an attachment. Video bytes don't pass through Hostinger.
- **Provider fetches** (`/provider-outputs`, connector): the video is streamed from the bucket through CMM Tools with byte ranges, because some providers don't follow redirects.
- **Moving old videos:** the worker processes one video every 15 seconds while enabled. It uploads the file, checks size and MD5, and only then changes the marker and deletes the MySQL chunks in one transaction. On any failure the MySQL copy is kept and the job retries after 5 minutes. Watch Activity for `r2.video_migrated` and `r2.migration_failed`.
- **Deleting:** when a customer deletes a video, the bucket object is removed after the database deletion commits. A failed cleanup is logged as `r2.delete_failed`.
- **Switching off:** "Stop using for new videos" sends new videos back to Drive or MySQL. Files already in the bucket keep playing for as long as the keys stay saved.

## Images and reference files

Generated images (`generation_image_outputs`), uploaded reference images (`generation_images`) and reference images, videos and audio (`generation_media`) also go to the bucket. To avoid a schema change while the database is over quota, the existing BLOB cell keeps a short tag instead of the bytes: NUL + `CMMR2` + NUL + the object key, always under 512 bytes. Real image, video and audio files never start that way.

- **Writing:** `offloadBlob(prefix, data, mime)` uploads the file and returns the tag, or returns the original bytes when cloud storage is off.
- **Reading:** every reader calls `hydrateBlobs(rows, field)`, so providers, previews, reuse and downloads get the original bytes unchanged.
- **Deleting:** deleting a generation removes its tagged objects after the commit. If a new generation's transaction rolls back, any objects it already uploaded are removed. Reused references are copied into new objects, so deleting one generation never breaks another.
- **Moving old files:** after all videos have moved, the worker moves one file per tick from these tables, videos first. The cell is replaced only if its length and MD5 are unchanged. Admin → Storage shows the counts still in MySQL. Activity events are `r2.file_migrated` and `r2.migration_failed`.

These stay in MySQL because they are small or short-lived: image thumbnails, voice-clone samples (cleared once sent to Vibi) and Claude connector uploads (deleted after a few days). Deleting a whole customer account doesn't yet remove that customer's bucket objects.

MySQL may not shrink its files on disk after rows are deleted. Ask Hostinger, or run `OPTIMIZE TABLE generation_video_chunks` with a backup, to reclaim the space.

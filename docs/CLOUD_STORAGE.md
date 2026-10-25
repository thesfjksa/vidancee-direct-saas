# Cloud storage (Cloudflare R2 / S3-compatible)

Primary storage for generated videos, replacing MySQL BLOBs and Google Drive. Implemented in `src/object_storage.js` (dependency-free AWS Signature V4 client) and `src/r2_migration.js`. Works with any S3-compatible bucket: Cloudflare R2, Backblaze B2, Wasabi or AWS S3.

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

## Not yet in cloud storage

Generated images, image thumbnails, uploaded reference images/videos/audio, voice-clone samples and connector uploads are still in MySQL; they are the next phase.

MySQL may not shrink its files on disk after rows are deleted. Ask Hostinger, or run `OPTIMIZE TABLE generation_video_chunks` with a backup, to reclaim the space.

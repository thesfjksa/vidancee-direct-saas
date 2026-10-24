# Google Drive video storage for CMM Tools

## What this changes
Customer-generated **videos** are stored as private MP4 files in a Google Drive folder named **CMM Tools Videos**. Video generation rows store \`gdrive:<file_id>\` instead of large MySQL BLOB chunks. Customer video playback/download and Admin video previews retain their existing CMM Tools URLs and authentication—**Google Drive files are not made public**.

This applies to all worker save flows that call \`saveVideoOutput\` (888API, Vercel, ArgoLink/HD, Higgsfield, Sluice, Upscaler, MiniMax / vgenv copy, and manual 888API recovery). **Images, audio, prompts, user records, and credit history remain in MySQL.** Providers whose videos are only represented by a remote provider URL, and never stored as MySQL BLOBs, are not part of the historical BLOB migration.

## One-time setup — requires the platform owner

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/) and enable **Google Drive API**.
2. Configure **OAuth consent screen**. Choose the appropriate audience (External for a personal Google account) and, if in Testing mode, add the connecting Google email as a test user. **Publishing the consent screen is recommended** for a long-running service; Testing refresh tokens can expire quickly (often 7 days).
3. Create **OAuth Client ID → Web application**, and add **exactly**
   \`https://cmmtools.site/admin/google-drive/callback\`
   to Authorized redirect URIs.
4. In **both** Hostinger apps, set \`GOOGLE_DRIVE_CLIENT_ID\`, \`GOOGLE_DRIVE_CLIENT_SECRET\`, and \`GOOGLE_DRIVE_REDIRECT_URI\` as documented in \`.env.example\`. Keep \`SETTINGS_ENCRYPTION_KEY\` identical across both apps. **Never commit client secrets, refresh tokens, access tokens, or private video links to GitHub.**
5. Redeploy the website and worker from the merged main commit. Open **Admin → Storage → Connect Google Drive** and authorize the Google account with \`drive.file\` (file-level app scope) and offline access. The refresh token is stored encrypted in \`app_settings\`; neither customers nor front-end JavaScript can read it.
6. Refresh the Admin Storage tab to verify **Connected and accessible** and see the current number of database videos. Connection switches **new uploads immediately to Drive** and enables the **worker's automatic, one-by-one migration**. Use Pause/Resume to control old-video migration. Confirm \`worker.mehroz.online\` is running.

**Use a Google account/Workspace Drive with enough free storage.** A typical free personal Google account starts with shared storage of 15 GB across Drive, Gmail and Photos; this is not an unlimited free database. Shared Drives require suitable Google Workspace access. Plain service accounts cannot own files in personal My Drive; this implementation uses a real user's OAuth authorization. Google Drive is not a substitute for a purpose-built streaming CDN at high request volumes.

## Data protection and migration

- Each historical video already stored as \`db:video\` is read from MySQL in **bounded 4 MiB batches**, streamed to Google Drive via **resumable upload** and confirmed by Drive metadata including size and MD5 checksum.
- Before deleting any source bytes, CMM Tools checks that Drive reports the correct MIME, byte count, MD5, and folder ID. The \`generations.output_url\` marker change and database chunk deletions happen in **one MySQL transaction**. Failure leaves the database copy intact. Uploads do not make Google Drive files public.
- If the worker restarts during migration, the next pass searches for an already-uploaded verified file by the generation's deterministic private name, avoiding unnecessary duplicate copies. A short-lived Drive upload session may expire and a partial upload may have to restart.
- The background worker holds a global named MySQL lock so multiple workers cannot migrate the same row. One video per migration pass, with five-minute cooldown after failure. Admin status reports the number and total bytes **remaining as MySQL video chunks**.
- On the Google Drive route, the API streams videos only after checking customer ownership, a signed provider-output link, or Admin-media authorization. Google Drive OAuth tokens and file IDs are not returned as public playback links.
- Disabling Google Drive after files have migrated is **not** supported as a data rollback: existing Drive videos require an active authorized Google connection to be playable. Pause only the historical migration if needed.
- Migrated MySQL chunk rows are deleted, reducing logical data stored. **MySQL disk allocations may not shrink automatically** after large deletions; a database maintenance/OPTIMIZE operation or a Hostinger plan change may be needed to reclaim physical storage. Do not attempt destructive database maintenance without a backup and appropriate database privileges.
- Google Drive API limits, Google account storage limits, OAuth refresh-token expiration, and MySQL quota failures can interrupt uploads. Monitor Activity \`gdrive.video_migrated\` and \`gdrive.migration_failed\`. A local MySQL video remains available if its migration fails.
- This migration targets all **database-stored** video chunks; externally hosted old provider URLs are not automatically ingested. Expired/unsafe remote video links cannot be recovered by storage migration.

## Security

The OAuth connection is initiated only by authenticated Admin; Google callback uses a one-time, expiring OAuth \`state\` stored in encrypted server settings. Customer video playback routes maintain existing per-owner authorization. Drive files remain private, not shared by "Anyone with the link". Untrusted Drive \`Location\` upload URLs are constrained to the Google API host.

Do not give Google Cloud credentials to ChatGPT or put them in screenshots. Enter them in Hostinger environment variables. No account is connected by merging code; the owner must complete Google consent.

## Verification after connecting

Open Admin → Storage and confirm:
- \`Connected and accessible\`
- \`Default for new videos: Google Drive\`
- \`Migration: Running\`
- \`Existing MySQL videos\` steadily decreasing and \`Videos on Drive\` increasing

Generate one small video from a reliable provider, verify playback and downloading from a customer account, and inspect MySQL's \`generations.output_url\` to confirm it begins with \`gdrive:\`. Confirm the new output generated no new \`generation_video_chunks\` rows, then inspect a migrated older video to ensure the owner can still play it.

Google OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
Drive resumable uploads: https://developers.google.com/workspace/drive/api/guides/manage-uploads
Drive metadata/downloads: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get

## Customer video deletion

When a customer deletes a completed Drive-backed generation, CMM Tools first commits the existing MySQL generation/reference deletion and then requests deletion of that exact private Drive file. If Google's delete request fails, the customer library removal remains committed; Admin Activity records \`gdrive.delete_failed\` so orphaned Drive files can be cleaned up later. No other customer's Drive file can be named by the client.

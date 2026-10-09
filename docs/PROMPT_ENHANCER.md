# Image and video prompt enhancer

The image and video creation screens each have an optional **Prompt enhancer** switch. It starts off. When enabled, the web app starts a background Gemini `gemini-3.8-flash` request and polls its status through short HTTP requests. After completion it puts the enhanced text in the prompt field and submits that text through the existing generation flow. Image prompts describe a still composition; video prompts describe action and camera motion while respecting the chosen duration. The enhancer preserves the user's subject, style, language, quoted text, and explicit constraints.

## Setup

1. Deploy the updated web application and restart it. No database schema change or worker update is needed for this feature.
2. In **Admin → Provider → Prompt enhancer · Gemini 3.8 Flash**, enter a Google Gemini API key and save provider settings. The key is encrypted using the app's existing secret storage; it is never returned to the browser. A blank key field keeps the saved key; **Clear saved API key** removes it.
3. Enable the enhancer source switch and the existing global **Allow paid provider calls** setting. The customer switch becomes available after the customer reloads the app.
4. Use **Test saved connection** to check that the saved key can list the exact model. This checks model metadata and does not generate text. It does not confirm remaining generation quota; test an enhancement separately after setup.

The model ID is fixed to `gemini-3.8-flash`, with thinking level `low`, the lowest setting this model supports. `minimal` is unsupported and causes HTTP 400. See Google's [thinking level compatibility table](https://ai.google.dev/gemini-api/docs/generate-content/thinking#thinking-levels). Public `/api/config` returns `promptEnhancer.revision: 4`, `async: true`, and `timeoutMs: 120000` to identify the background request update. There is no provider fallback. Google API availability, permissions, quota, and billing still apply.

## Request and failure behavior

`POST /api/prompts/enhance` requires a signed-in, active user. It accepts `mediaType` (`image` or `video`), `prompt`, and optional aspect ratio, video duration, and image/video reference counts. It sends text and this limited context to Google, without uploaded files or their names. The enhancer cannot see reference contents and is instructed not to invent them.

The updated UI also sends `async: true` and a random UUID `requestId`. The API immediately returns a job ID and processing status with HTTP 202; `GET /api/prompts/enhance/:jobId` returns processing, completed, or failed status. Only the same active user can retrieve it. Reusing a request ID with identical text/context returns the same processing or completed result without another provider call. Reusing it with different input is rejected. Legacy POST requests without `async` retain synchronous behavior; refresh already-open dashboards to use polling.

Enhancement does not deduct customer credits or change image/video generation pricing. Google may charge the site owner's API account. Existing generation validation and credit reservation happen when the enhanced generation is submitted.

If enhancement fails, generation is not submitted; the original prompt and attached references remain available. The user may retry or switch enhancement off. If enhancement succeeds but generation submission fails, the enhanced text and references remain. Retrying the unchanged text and context reuses that result rather than calling Gemini again. Successful generation clears the prompt and references as before.

Text enhancement has a 120-second deadline covering both response headers and body reading. The read-only model connection check retains a 25-second deadline. There are no automatic paid-request retries. Status polling retries temporary connection/service failures without starting another enhancement. The UI shows a longer-wait message after ten seconds; it preserves text and references on terminal failure. A manual retry after a lost status connection resumes the known job, or reuses its request ID if the initial response was lost.

The initial POST allows 30 seconds for acknowledgement. If that response times out, the connection fails, or the site returns HTTP 5xx, the UI uses read-only `GET /api/prompts/enhance/requests/:requestId` to find the accepted job. The same active owner is required for lookup; no new paid request is made during recovery. Status reads allow 20 seconds each. A brief missing request during recovery is retried for up to 45 seconds to allow an in-flight POST to register. If no job is confirmed, a subsequent explicit Generate action reuses the same request ID. Connection failures, an unconfirmed start, and a provider billing/quota error have separate messages.

Background records are held in the web process, capped at 1,000 entries, and retained for ten minutes after completion/failure. They do not survive process restarts and are not shared between web instances. An expired/restarted job returns a clear error, preserves the prompt and references, and requires an explicit retry. This design assumes the existing single web process for the customer domain. A multi-instance deployment would require shared persistent job storage.

Blocked, incomplete, empty, and oversized results are rejected. Rate limits are per web process: six starts per minute per user, one concurrent request per user, and eight concurrent requests overall. Limits reset after a process restart. Upstream errors report their HTTP category (request settings, credentials/access, billing, model availability, quota/rate limit, or temporary service failure) using fixed messages so they cannot disclose API keys or provider response bodies.

## Validation

`npm test` covers request shape, image/video instructions, model requests, delayed responses and stalled bodies, background request ownership/idempotency/expiry, initial-response recovery and interrupted polling, failure handling, concurrency limits, authentication, encrypted settings, source and global switches, public config, and unchanged customer credit balances. Browser QA covers a lost initial acknowledgement after 17 seconds, recovery by request ID without a second POST, a simulated 27-second enhancement, temporary status failures, service-restart recovery, both creation screens, actual submitted prompts, switch-off behavior, references, duplicate submission prevention, Admin controls, and mobile layout using mocked APIs. Live Google generation requires a configured key and is not part of these automated checks.

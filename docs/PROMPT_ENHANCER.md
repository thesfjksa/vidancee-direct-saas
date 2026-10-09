# Image and video prompt enhancer

The image and video creation screens each have an optional **Prompt enhancer** switch. It starts off. When enabled, the web app asks Gemini `gemini-3.8-flash` to rewrite the text, puts the enhanced text in the prompt field, and submits that text through the existing generation flow. Image prompts describe a still composition; video prompts describe action and camera motion while respecting the chosen duration. The enhancer preserves the user's subject, style, language, quoted text, and explicit constraints.

## Setup

1. Deploy the updated web application and restart it. No database schema change or worker update is needed for this feature.
2. In **Admin → Provider → Prompt enhancer · Gemini 3.8 Flash**, enter a Google Gemini API key and save provider settings. The key is encrypted using the app's existing secret storage; it is never returned to the browser. A blank key field keeps the saved key; **Clear saved API key** removes it.
3. Enable the enhancer source switch and the existing global **Allow paid provider calls** setting. The customer switch becomes available after the customer reloads the app.
4. Use **Test saved connection** to check that the saved key can list the exact model. This checks model metadata and does not generate text. It does not confirm remaining generation quota; test an enhancement separately after setup.

The model ID is fixed to `gemini-3.8-flash`. There is no provider fallback. Google API availability, permissions, quota, and billing still apply.

## Request and failure behavior

`POST /api/prompts/enhance` requires a signed-in, active user. It accepts `mediaType` (`image` or `video`), `prompt`, and optional aspect ratio, video duration, and image/video reference counts. It sends text and this limited context to Google, without uploaded files or their names. The enhancer cannot see reference contents and is instructed not to invent them.

Enhancement does not deduct customer credits or change image/video generation pricing. Google may charge the site owner's API account. Existing generation validation and credit reservation happen when the enhanced generation is submitted.

If enhancement fails, generation is not submitted; the original prompt and attached references remain available. The user may retry or switch enhancement off. If enhancement succeeds but generation submission fails, the enhanced text and references remain. Retrying the unchanged text and context reuses that result rather than calling Gemini again. Successful generation clears the prompt and references as before.

Requests have a 25-second deadline and no automatic retries. Blocked, incomplete, empty, and oversized results are rejected. Rate limits are per web process: six starts per minute per user, one concurrent request per user, and eight concurrent requests overall. Limits reset after a process restart and are not shared between web instances. Upstream errors are sanitized so they cannot disclose API keys or provider response bodies.

## Validation

`npm test` covers request shape, image/video instructions, model requests, failure handling, deadlines, concurrency limits, authentication, encrypted settings, source and global switches, public config, and unchanged customer credit balances. Browser QA covers both creation screens, actual submitted prompts, switch-off behavior, failure recovery, references, duplicate submission prevention, Admin controls, and mobile layout using mocked APIs. Live Google generation requires a configured key and is not part of these automated checks.

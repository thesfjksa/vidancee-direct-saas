# Claude connector (MCP)

Customers can use CMM Tools from Claude: they add CMM Tools as a **custom connector**, sign in with their CMM Tools account, and ask Claude for videos and images in chat. Jobs use the customer's own credits, follow the same plan limits, prices and provider rules as the website, and appear in their library.

- Connector URL: `https://cmmtools.site/mcp`
- Customers: **Use with Claude** page (URL, setup steps, connected apps with Disconnect).
- Admin: **Provider → Claude connector** (on/off for everyone, number of connected apps).
- Code: `src/connector.js` (HTTP routes), `src/mcp_server.js` (protocol and tools), `src/mcp_oauth.js` (sign-in), `src/mcp_pages.js` (sign-in, consent and upload pages), `src/remote_image.js` (safe image downloads).

Anthropic does not list connectors that generate images or video in its Connectors Directory, so CMM Tools is added by URL as a custom connector. Custom connectors are available on every Claude plan (Free accounts can add one). Claude shows custom connectors with a generic **Custom** icon; only directory connectors get a logo card. The server still reports its name, website and a 512×512 icon (`/assets/cmmtools-mcp-icon.png`) in `serverInfo` for clients that display it.

## Setting it up in Claude

The **Add to Claude** button on the Use with Claude page opens Claude's Add custom connector dialog with the name and URL filled in (`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=CMM%20Tools&connectorUrl=https%3A%2F%2Fcmmtools.site%2Fmcp`); the customer clicks **Add**, then **Connect**. By hand:

1. Claude → **Customize → Connectors** → **+ Add** → **Add custom connector**. CMM Tools does not appear in Claude's connector search.
2. Name `CMM Tools`, URL `https://cmmtools.site/mcp`, **Add**.
3. **Connect** → sign in to CMM Tools → **Allow**.
4. In a chat: **+ → Connectors** → turn on CMM Tools.

Claude Code: `claude mcp add --transport http cmm-tools https://cmmtools.site/mcp`, then `/mcp` to sign in.

## Tools

| Tool | What it does | Spends credits |
|---|---|---|
| `get_account` | Email, credits, plan, parallel job limit | No |
| `list_models` | Video and image models for this account with resolutions, durations, aspect ratios, qualities, sizes, reference limits | No |
| `estimate_cost` | Price in credits for given settings | No |
| `create_video` | Starts a video (Video Studio rules, including HD enhancement) | Yes |
| `create_image` | Starts an image (Image Studio rules, including the ArgoLink failover) | Yes |
| `get_job` | Status; `wait_seconds` (≤ 50) waits for it; finished jobs include a download link valid 7 days | No |
| `list_jobs` | Recent jobs | No |
| `upscale_video` | Upscales a finished video to 1080p, 2K or 4K | Yes |
| `request_image_upload` | A 1-hour link where the customer uploads a photo from their device | No |
| `list_uploads` | Photos uploaded in the last 7 days | No |

Reference images (`reference_images`) are one of: `{"upload_id"}` from `request_image_upload`, `{"image_job_id"}` for a finished CMM Tools image, or `{"url"}` for a public https JPEG/PNG/WebP (15 MB max). `image_mode` picks `reference` (default), `first_frame` or `first_and_last_frame`.

Read-only tools are marked `readOnlyHint` so Claude can run them without asking; the others always ask the customer in Claude.

## The CMM Tools card in Claude

`create_video`, `create_image`, `upscale_video` and `get_job` are linked to an MCP App (`ui://cmm-tools/job`, `src/mcp_view.js`), so Claude shows a CMM Tools card in the chat instead of only a link:

- While the job runs: status, elapsed time and a spinner. The card refreshes itself every 6 seconds through `get_job`.
- When finished: the image, or a video player, with a Download button (the 7-day link). Failures show the reason and the refund.
- Claude often checks a job several times; each card carries a server timestamp (`view` in the result) and older cards for the same job shrink to one line, so only the newest stays.
- The card loads the MCP Apps client (`@modelcontextprotocol/ext-apps` 1.7.5, MIT, kept in `vendor/` outside `public/` because Hostinger serves `public/` files itself without CORS) from `https://cmmtools.site/vendor/mcp-ext-apps-1.7.5.js` (served by the app with CORS) and media from `/media-share` links (served with `Cross-Origin-Resource-Policy: cross-origin`); its CSP allows only cmmtools.site and Claude's font host.
- `get_job` also returns a small copy of a finished image (the 768 px WebP thumbnail, up to 90 KB) so Claude can see it.

## Protocol

Streamable HTTP, stateless (no `Mcp-Session-Id`), JSON responses.

- Claude's current client uses the `initialize` handshake; versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05` are accepted.
- Newer clients (`2026-07-28`) send the version in each request's `_meta`; `server/discover`, `resultType`, `ttlMs`/`cacheScope`, `UnsupportedProtocolVersion` (-32022) and `HeaderMismatch` (-32020) are implemented.
- `GET /mcp` returns 405 (no server-to-client stream). Requests with an `Origin` header other than claude.ai, claude.com, cmmtools.site or localhost get 403.

## Sign-in (OAuth 2.1)

CMM Tools is its own authorization server.

- `GET /.well-known/oauth-protected-resource` (and `/mcp` suffix) → resource `https://cmmtools.site/mcp`, issuer `https://cmmtools.site`.
- `GET /.well-known/oauth-authorization-server` → advertises Client ID Metadata Documents (`client_id_metadata_document_supported: true` with `none` auth), DCR, PKCE S256, refresh tokens.
- An unauthenticated `/mcp` request gets `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="cmm"`, which starts Claude's sign-in.
- **Client identity**: Claude's published metadata documents (fetched only from claude.ai / claude.com, cached 1 hour) or Dynamic Client Registration at `/oauth/register` (20 per IP per hour). Registered clients may only use `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` or loopback addresses (Claude Code); loopback redirects match with any port.
- **Consent**: `/oauth/authorize` shows CMM Tools sign-in if needed, then an Allow/Cancel page naming the app and where it returns to (with a warning for apps on the customer's computer). The form is bound to the signed-in session by an HMAC.
- **Tokens**: access tokens last 1 hour; refresh tokens 90 days and rotate on every use (a used refresh token is refused). Codes last 10 minutes and work once. Only SHA-256 hashes of codes and tokens are stored (`oauth_codes`, `oauth_grants`). `/oauth/revoke` (RFC 7009) and the customer's **Disconnect** end a connection immediately.
- Errors use RFC 6749 codes (`invalid_grant`, `invalid_client`, …).

## Downloads and uploads

- Finished jobs get `/media-share/<id>?exp=…&sig=…` links (HMAC with `PROVIDER_ASSET_SECRET`/`ADMIN_TOKEN`), valid 7 days. Videos support range requests.
- Upload links `/connector-upload/<id>?exp=…&sig=…` are valid 1 hour; photos are kept 7 days (`connector_uploads`).
- Image links given to Claude are downloaded only from public https addresses: every connection's resolved address is checked against private, loopback, link-local and similar ranges, up to 3 redirects, 15 MB cap, image type checked from the bytes.

## Housekeeping

Every 6 hours the web app deletes expired codes, revoked/expired connections older than 30 days, unused registered clients older than 30 days, and uploads older than 7 days. Connector events are in the activity log under category `connector`: connected, authorized, denied, disconnected, and one `mcp.call` line per tool call with its arguments (without the prompt), what Claude was told and how long it took.

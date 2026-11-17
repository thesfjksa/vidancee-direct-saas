# Admin-managed Webshare connection — extension v1.7.0

## Admin setup

1. Deploy the web app containing this change. Open Admin → Provider → Connections → Extension · managed Webshare connection.
2. Enter a Webshare API key allowed to read the direct proxy list, optionally choose a country, enable the feature, and click Save & sync Webshare. Use a Webshare Proxy Server plan with direct endpoints; rotating residential/backbone plans are not imported.
3. The server reads Webshare's official list endpoint (GET only), selects up to five distinct valid endpoints from the first 100 matching rows, then stores the API key, endpoints and credentials as one encrypted app_settings record. A failed import preserves the prior setting. Admin status shows only configured/enabled/count/country, never credentials or the key. Empty key reuses the encrypted saved key for explicit Admin sync.
4. Customers do not configure Webshare or receive its API key. Proxy credentials sent to customer devices remain inspectable there. A separate gateway would be required to keep those credentials off devices.
5. Disable managed connection blocks new config requests without terminating accepted/in-progress provider work or revoking already distributed proxy credentials. Rotate/revoke credentials in Webshare if required. This integration makes no purchase, billing, proxy replacement, rotation or IP allowlist mutation.

## Customer setup

Install v1.7.0. In Extension Options, select Use the managed connection, acknowledge the browser-profile routing notice, and Save connection preference. Chrome requests optional proxy/auth permissions. No Webshare key or server-entry fields are shown.

Close other AIVID tabs and open Studio. Before each new session, a small CMMTools connection page uses the customer's normal signed-in website session to fetch the configured endpoints. If not signed in, sign in through the displayed link, return and Retry. The handoff is bound to the extension ID, cryptographic nonce and exact connection window; it expires after two minutes. Only active signed-in CMMTools accounts receive config. There is no persistent extension bearer token or direct extension access to Webshare's API.

The extension tests the imported proxies sequentially, using two bounded unauthenticated public AIVID response-header checks per endpoint. Each check has an eight-second deadline, no cookies or redirects. The lowest average response-header latency wins, is rechecked before navigation and stays stable for the session. This measures responsiveness, not bandwidth, render time or provider queue speed. No automatic direct fallback is allowed for the managed connection. Closing Studio restores underlying browser routing. Reusing an open Studio does not switch IPs or refresh the session's route.

## Routing and credential limits

Chrome cannot isolate proxy configuration to a popup. A local mandatory PAC rule routes aivid.dev/subdomains across the regular browser profile, including other AIVID tabs. Other domains use DIRECT, which can bypass a system proxy. External authentication/CDN/media domains are not included. Use a separate direct-internet profile if another proxy is needed. Existing fixed/PAC proxies, competing extension/policy control and open AIVID tabs block new testing. regular_only avoids Incognito inheritance. This is browser proxy routing, not a device-wide VPN or anonymity guarantee. No TLS validation or security challenge is bypassed.

Proxy credentials are saved in storage.local restricted to trusted extension contexts. They are not synced or exposed to content scripts; they are supplied only to the exact selected proxy host/port on an AIVID proxy-auth challenge, once per request. Local extension storage is not an encrypted password vault. The proxy operator sees authentication/connection metadata, and HTTP proxy authentication may use an unencrypted hop. The Webshare API key stays encrypted on the CMMTools server and is never included in the customer handoff.

## Publishing and verification

Upload CMMTools_Video_Studio_Chrome_Store_v1.7.0.zip to the existing store item and update the listing/privacy/permission disclosures. Single purpose: Launch the AIVID workspace with display preferences and an optional Admin-managed Webshare connection.

- proxy: Apply AIVID domain rules for the regular profile and keep the selected connection until Studio closes.
- webRequest/webRequestAuthProvider: Answer proxy-auth challenges only from the exact selected proxy on AIVID requests, not normal website sign-in.
- storage: Sync display preferences, maintain local managed preference/consent and proxy credentials, and track the live session.
- AIVID host access: Existing display scripts, bounded public connection checks and matching proxy-auth events.
- No Webshare host permission is required by the extension. API access happens only on the server during explicit Admin sync.

Deploy /extension/privacy and the signed-in /extension/connect and /api/extension/proxy-config flow before customer testing. Automated verification uses Node/VM fixtures. Actual Admin Webshare sync, Chrome permissions, connection-page sign-in, proxy authentication, egress IP/latency and authenticated AIVID behavior remain to be tested using an owner-provided account. No account key, proxy subscription, paid generation or production setting was used during implementation.

Official references: https://apidocs.webshare.io/proxy-list/list and https://developer.chrome.com/docs/extensions/reference/api/proxy

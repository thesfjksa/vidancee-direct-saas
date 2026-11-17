# Optional Studio proxy connection (v1.6.0)

The launcher can test up to five owner-supplied HTTP/HTTPS or unauthenticated SOCKS5 proxies before opening AIVID. It does not include proxy servers, a paid service subscription, device-wide VPN encryption or a guarantee of anonymity. No free public proxies are bundled. No provider render time is changed by this feature.

## Configure

1. Install/update the v1.6.0 package. For a store listing, upload the new ZIP to the existing item and update its privacy/permission disclosures before review. Do not claim the v1.5.1 listing already includes this feature.
2. Right-click the CMMTools extension → Options → Connection. Add your service's hostname/IP, port, protocol and, for HTTP/HTTPS, username/password. The extension has no provider API import; enter the supplied connection endpoints. SOCKS5 username/password is unsupported; use the service's IP authorization if available. IPv6 proxy host literals are not supported in this version.
3. Enable automatic connection. Confirm the browser profile uses direct internet without an existing system proxy and acknowledge the scope described below. Save and accept Chrome's optional proxy/request-auth permissions. Direct connection is excluded by default; explicitly enable “Include direct connection” only if direct internet may be selected as a winner.
4. Close all AIVID tabs and any previous Studio window, then click Open Video Studio. Testing switches the profile's route sequentially, so it must not run while another AIVID session is using that route.
5. Each candidate gets two bounded, unauthenticated GET checks to the public AIVID root with cache disabled, no cookies and no redirects. Each check waits at most eight seconds for successful response headers. The lowest average header latency wins and is rechecked before navigation. This measures responsiveness, not bandwidth, provider queue time or render speed. A login redirect, denied response or network timeout does not count as a passing route.
6. A small in-Studio indicator shows the selected route and last measured latency; click it for Options. The route remains stable for the session; there is no automatic IP change while working. When all proxies fail, the local loading page displays an error and AIVID navigation is blocked. Existing browser routing is restored. You may fix the endpoints or explicitly disable proxy mode to use browser defaults.
7. Closing Studio or clicking Disconnect clears only this extension's regular-profile proxy setting, restoring the underlying browser configuration. Disconnect affects AIVID tabs immediately. Close Studio before saving changes or using Forget proxy servers, which removes locally saved endpoints/credentials.

## Scope and limitations

- Chrome's proxy API cannot isolate a route to a popup window. A local mandatory PAC rule routes `aivid.dev` and its subdomains across the regular browser profile. Other AIVID tabs in that profile also use it. The PAC sends all other domains DIRECT; it can therefore bypass a system proxy while active. It refuses an existing fixed/PAC proxy or an active competing extension/policy. Use a separate, direct-internet browser profile if you normally rely on another proxy. An explicit direct-network acknowledgment is required.
- External sign-in, CDN and media domains are not included. This is not comprehensive window-wide tunneling, a device VPN, or an anonymity/privacy guarantee. Existing open browser sockets, browser DNS/network behavior, OS VPN routing and provider-side blocking are outside this feature's guarantees. It does not bypass security challenges or disable TLS validation.
- Proxy configuration uses `regular_only`; it does not inherit into Incognito. Studio is explicitly opened in a regular window. The existing user-managed Incognito setting for display customization is otherwise unchanged.
- Optional `proxy`, `webRequest` and `webRequestAuthProvider` are requested only when the user enables the feature and saves. Host access is limited to HTTPS AIVID domains, not `<all_urls>`. Proxy passwords live in `chrome.storage.local` restricted to TRUSTED_CONTEXTS, not sync, content scripts or CMMTools servers. This is local storage, not an encrypted credential vault. Users must trust the proxy operator, who sees network connection metadata; HTTP proxy authentication may be exposed on an unencrypted proxy hop. Prefer a TLS-capable HTTPS proxy where supported.
- Auth credentials are supplied only for an `isProxy` challenge from the exact active hostname+port on an AIVID request. A repeated auth challenge is cancelled to avoid retry loops. Normal website authentication never receives these credentials. The service worker registers MV3 async auth listeners and recovers persisted active state; stale in-progress tests are cleared on startup. Disabling/uninstalling the extension clears Chrome-managed extension proxy settings.
- Unit/VM tests simulate Chrome APIs. Live Chrome PAC/auth/permission prompts, a real proxy account, AIVID response behavior, IP changes and full authenticated sessions must still be tested with owner-supplied endpoints. No proxy was purchased or used, and no paid generation was submitted during development.

## Chrome Web Store disclosure text

Update the single purpose to: **Launch the AIVID Studio workspace with user-selected display preferences and an optional configured proxy connection.**

- **proxy:** Applies a locally generated routing rule for AIVID domains in the regular browser profile, tests configured routes and keeps the selected route until Studio closes or the user disconnects.
- **webRequest:** Handles authentication challenges for the selected user-configured proxy on HTTPS AIVID requests. It does not collect browsing history or page contents.
- **webRequestAuthProvider:** Supplies user-entered proxy credentials asynchronously only to the exact selected proxy host/port and cancels repeated failed challenges. Website authentication is not handled.
- **storage:** Existing display preferences use sync/session storage. This version also stores proxy endpoints and credentials locally, restricted to trusted extension contexts, plus non-secret connection timing/session state. Explain proxy-operator transmission accurately in the privacy questionnaire.
- **Host access:** HTTPS AIVID domains are required for the existing local display customization, bounded connection GET probes and proxy-auth events. No executable code is fetched remotely; the PAC is generated locally from strictly validated endpoints.

Official API references: https://developer.chrome.com/docs/extensions/reference/api/proxy and https://developer.chrome.com/docs/extensions/reference/api/webRequest

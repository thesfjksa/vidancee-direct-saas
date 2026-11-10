# CMMTools Premium RDP Viewer — Apache Guacamole

**Purpose:** Embed a secure, separately authenticated Windows RDP session inside the existing CMMTools Video Studio, using **Microsoft Edge on the Windows RDP** rather than Browserless. Provide real **upload/download file transfer** via Guacamole's RDP virtual drive. The new page is `/aivid-live-studio` (also `/rdp-studio`). The old Browserless `/api/aivid-live-studio/start`, upload and download routes no longer create cloud sessions.

This is an **infrastructure-dependent integration**, not a live Windows connection installed by a Git commit. The existing Edge worker pairing and automated paid AIVID queue are unchanged. A Guacamole viewer is a **different, interactive RDP login** and does not automatically reuse the Edge profile of the running Windows agent.

Official references: [Guacamole Docker](https://guacamole.apache.org/doc/gug/guacamole-docker.html), [Nginx proxy and WebSocket](https://guacamole.apache.org/doc/gug/reverse-proxy.html), [RDP virtual-drive transfer](https://guacamole.apache.org/doc/gug/using-guacamole.html), [RDP parameters](https://guacamole.apache.org/doc/gug/configuring-guacamole.html).

## Architecture and authorization

```text
Signed-in CMMTools customer (approved ID/email)
    |
    | GET /aivid-live-studio, /api/rdp-studio/config
    | server-side CMMTools allowlist + isolation/billing acknowledgements
    v
CMMTools HTTPS page (sandboxed cross-origin iframe)
    |
    | HTTPS/WebSocket, dedicated Guacamole user sign-in (independent)
    v
rdp.cmmtools.site -> TLS Nginx -> 127.0.0.1:8080 -> Guacamole
                                      |-> PostgreSQL (Guacamole users/connections)
                                      |-> private guacd (not exposed)
                                              |
                                         private VPN to Windows RDP 3389
                                              |
                                      restricted Windows account
                                      Microsoft Edge + dedicated AIVID login
    |
    +-- Guacamole menu <-> isolated RDP redirected drive <-> Windows file picker
```

**The iframe is not an authentication boundary on its own.** The Guacamole public endpoint *must* separately require a unique Guacamole user/password (and MFA if deployed). A CMMTools session does not grant a Guacamole session. Only grant each Guacamole user access to its assigned RDP connection and Windows identity; do not share the owner's existing Windows agent user, admin session, DPAPI credential or Edge profile with a customer. The gateway URL is not a signed session token.

**Do not expose TCP 3389 directly to the public Internet.** Establish a private WireGuard/Tailscale/VPN path from the Guacamole VPS to the RDP host and firewall RDP to that private source. RDP server must support distinct, restricted Windows logons and valid Windows/RDS licensing. Keep the existing agent running in its own Windows account/session and separately sign in to AIVID under the customer's Edge profile. A new RDP login does **not** necessarily connect to the same graphical session as the existing agent, and must not disconnect it.

## 1. Dedicated gateway VPS setup

Requires a Docker-capable Linux VPS and a TLS reverse proxy. This **cannot be started by Hostinger's ordinary Node.js web/worker processes alone**.

Inside `ops/aivid-rdp-gateway` on that VPS:

```sh
cp .env.example .env
# Replace GUAC_POSTGRES_PASSWORD in .env with a strong random secret:
# openssl rand -hex 32
chmod 600 .env
mkdir -p drives
docker compose up -d postgres guacd
docker run --rm guacamole/guacamole:1.6.0 /opt/guacamole/bin/initdb.sh --postgresql > initdb.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U guacamole -d guacamole_db < initdb.sql
docker compose up -d guacamole
docker compose ps
```

Run schema initialization **only on a fresh, empty Guacamole database**, not on upgrades. Back up PostgreSQL and the `drives` directory before upgrading. The `guacamole` HTTP frontend binds only to **127.0.0.1:8080**. PostgreSQL and guacd ports are never published. The Docker bridge must be able to reach the Windows RDP server's VPN address.

Set up `nginx.conf.example` as a TLS vhost for `rdp.cmmtools.site`, issue a valid certificate and check that the WebSocket tunnel and file transfers work. Ensure the exact `frame-ancestors https://cmmtools.site` policy matches the CMMTools origin. Removing Guacamole's `X-Frame-Options: SAMEORIGIN` must happen **only on this dedicated gateway location**, with that narrow CSP frame allowlist. If an upstream Guacamole CSP also blocks framing, investigate and explicitly align its framing policy; do not globally disable security headers. Do not expose 8080, 4822, 5432 or 3389 to the public.

The initial Guacamole SQL schema creates a `guacadmin` account with a known default password. **Before making the gateway public**, connect through a trusted administrator network, change that password, add a named administrator, and restrict/remove the default administrator. Set independent credentials for each customer. Enable Guacamole MFA (TOTP) before production where supported.

## 2. Configure a restricted RDP connection and transfer drive

In Guacamole Admin → Settings → Connections, create an **RDP** connection with:

- **Hostname:** the **VPN/private Windows IP**, not the public IP or domain.
- **Port:** 3389; security mode **NLA** where compatible; verify the RDP server certificate (do not disable certificate verification just to connect).
- **Username:** dedicated restricted Windows account for the assigned customer. Do not give the Guacamole customer Windows administrator credentials or access to the Windows worker's account/profile.
- **Device redirection → Enable drive:** **On**, drive name e.g. `CMM Transfer`; **Drive path:** `/guacamole-drive/customer-42`; **Create drive path:** only if allowed and permissioned correctly; **Disable upload/download:** both **Off**.
- Before granting access, create `drives/customer-42` and set permissions for the actual `guacd` container's user. Use a separate path per customer and a private disk volume; ensure customers cannot browse each other's directories. Do not use `/guacamole-drive` for all customers.
- Grant **only this connection** to the dedicated Guacamole customer identity. No admin or unrestricted active connection-sharing privileges. Enable per-user concurrent connection limit if applicable.

Upload references: open a Guacamole session, press **Ctrl+Alt+Shift**, click the shared drive and **Upload Files**, or drag files into its viewer. In Windows Microsoft Edge, choose the uploaded files from the redirected `CMM Transfer` virtual drive using AIVID's reference selector. The browser never receives a Windows filesystem path or the RDP credentials.

Download: save the finished AIVID video into the redirected drive, then open the drive in the Guacamole menu and select the MP4; alternatively save it to the virtual drive's special `Download` folder to trigger a browser download. Guacamole/NGINX transfer limits and the site's actual output format may apply. File bytes go through the dedicated Guacamole gateway, **not CMMTools MySQL or the old Browserless storage adapter**. Files in the drive persist until explicitly cleaned up—create and audit a retention/deletion policy for customer media.

## 3. Enable the CMMTools customer viewer

Set these **server-side only** on the Hostinger **web** application:

```env
AIVID_RDP_VIEW_ENABLED=false
AIVID_RDP_VIEW_URL=https://rdp.cmmtools.site/guacamole/
AIVID_RDP_VIEW_ALLOWED_EMAILS=
AIVID_RDP_VIEW_ALLOWED_IDS=
AIVID_RDP_VIEW_ISOLATION_ACK=false
AIVID_RDP_VIEW_DIRECT_BILLING_ACK=false
```

After verifying isolated Windows accounts, independent Guacamole login and the private VPN, set `AIVID_RDP_VIEW_ENABLED=true` and add **only approved CMMTools customer IDs/emails**. Set both `_ACK` flags to `true` only when the operator accepts those protections and understands that clicking Generate in the interactive RDP Edge session bills the upstream **AIVID account directly**. **CMMTools does not debit or reserve wallet credits here**, enforce its source credit ceilings, record a generation, or run the automated AIVID submission guard. This is a separate interactive billing channel. Independent customer billing must be arranged before client use.

Authorized users open `/app` → select a **Premium** model → click **Open secure Premium desktop**, or visit `/aivid-live-studio`. The page will ask the customer to sign in to their assigned Guacamole account. The remote Windows session then opens, with its own Microsoft Edge. The page has a full-screen new-tab option, upload/download instructions and a Disconnect viewer button.

The viewer also respects Admin → Users → Sources → AIVID: an explicit customer opt-out blocks the RDP entry even if the email/ID is in the environment allowlist.

The CMMTools page can disconnect its iframe, but **cannot revoke the separate Guacamole session cookie**: always sign out from the Guacamole menu before leaving a shared computer and configure Guacamole session expiry/idle timeout. Guacamole may also prompt for the assigned Windows login. The iframe has a narrow sandbox, HTTPS-only URL validation, no embedded RDP passwords, no old Browserless token, a response-specific script nonce and strict CSP.

## Verification checklist before enabling customers

1. Denied CMMTools users cannot open the page or read `/api/rdp-studio/config`; without all environment acknowledgements the feature stays unavailable. Legacy Browserless live-view APIs return HTTP 410 for authorized users.
2. An approved CMMTools user still **must sign in separately to Guacamole**; no default admin session, auto-login token or shared Windows desktop is exposed. Attempt accessing another customer's RDP connection and drive: both must be denied.
3. Two distinct customers have distinct Windows sessions, Microsoft Edge profiles, cookies, Guacamole users and drive paths. Ensure a customer cannot see `.aivid-agent.json`, agent receipts or the owner's private AIVID history.
4. Real Windows Edge can open AIVID and perform its normal interactive Google sign-in; user completes any provider CAPTCHA manually. This is not a CAPTCHA bypass and Google sign-in is not guaranteed.
5. Test one small PNG upload from the customer's device to the Guacamole virtual drive, reference it in AIVID, then upload audio/video if supported by AIVID. Test MP4 download both via the Guacamole menu and virtual `Download` folder.
6. Confirm the existing Windows AIVID agent remains connected and **no existing queued/accepted jobs are interrupted**. Do not retry uncertain charged requests.
7. Confirm HTTPS/WSS works under the gateway hostname, all non-TLS or unneeded public ports are firewalled, file uploads have bounded limits, admin credentials rotated, and Guacamole/TLS/security logs monitored.

## Verification boundary

The repository tests verify CMMTools allowlist and URL validation, the new route's CSP/nonces, UI link, and retirement of Browserless live-view routes. The Docker and Nginx files are deployable examples; a gateway VPS, private VPN, separate Windows login, Guacamole accounts, genuine uploads/downloads and production Hostinger deployment **cannot be verified from CI alone**. No paid generation or live RDP connection was initiated by this code change.

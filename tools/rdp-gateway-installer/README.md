# CMMTools RDP Gateway Setup — Windows GUI

**For the owner who will not use a command line.** The Windows app is a self-contained `CMMTools-RDP-Gateway-Setup.exe`. Double-click it on your Windows RDP. It provides buttons to buy a Linux VPS, install Tailscale on Windows, create a **one-time** Tailscale authentication key, and launch Hostinger DNS.

This is **not** the existing AIVID-Agent.exe. Do not replace, reset or stop the existing working Edge RDP agent.

## What must exist before pressing Install

1. A **new**, clean Ubuntu 24.04 Linux VPS (2 vCPU, >=2GB RAM, Docker-capable) with a reachable SSH login and root or **passwordless sudo** privileges. The GUI supports SSH username/password or a private SSH key/passphrase. For Hostinger this is a new VPS service; an ordinary Node app is insufficient to host Guacamole.
2. A DNS A record for `rdp.cmmtools.site` pointing to the VPS's public IPv4 address. Open inbound 80 and 443 on the VPS firewall; restrict SSH port 22 to your admin IP. Never expose Windows RDP 3389, database 5432, guacd 4822 or internal gateway 8080 to the public.
3. Official Tailscale installed and signed in on the **existing Windows RDP**, with an assigned private 100.64.0.0/10 IP. Obtain a **one-time** authentication key for the new Ubuntu VPS using the Tailscale admin website. Windows RDP server must be able to accept an RDP connection from this private VPN and support a separate isolated Windows user/session without disrupting the existing AIVID Edge agent.
4. Administrator certificate email address for Let's Encrypt. The VPS must be connected to the Internet for Ubuntu, Docker, Tailscale and certificate package downloads.

## What happens when you click Install

- The GUI checks DNS points at the new VPS. It connects via SSH.NET 2026.0.0 over SSH/SFTP and shows a SHA256 SSH **host key fingerprint that you must compare** with the VPS provider's console before trusting it.
- It uploads private temporary bootstrap/configuration files over SFTP and runs the bundled Ubuntu installation script through SSH. **It opens no Windows terminal or PowerShell window.**
- The bootstrap installs Docker, Docker Compose, Nginx, Certbot and Tailscale, joins your existing private Tailnet using a one-time authentication key file (not a process argv secret), starts Guacamole 1.6.0/guacd/PostgreSQL, initializes the fresh database, **rotates the default `guacadmin` password before exposing the web page**, obtains TLS and serves HTTPS/WebSockets at `https://rdp.cmmtools.site/guacamole/`. Docker only publishes Guacamole on 127.0.0.1; other containers remain private.
- The GUI displays the newly generated strong `guacadmin` password **only on successful completion**. Copy it somewhere safe before closing; no credentials are stored by the Windows app. Secrets in temporary SSH upload staging are removed on exit, although a failed network transfer can interrupt cleanup. The VPS retains its PostgreSQL password (private .env) and isolated media drive as expected.
- It creates the `drives/customer-1` folder owned by the `guacd` user. **It does not** create a Windows account, configure the Guacamole RDP connection/customer login, enable CMMTools permissions or run a paid AIVID generation; those still need secure verification through the respective graphical interfaces.

The installer is guarded: Ubuntu 24.04 only; requires an empty `/opt/cmmtools-guacamole` setup and refuses to overwrite an existing `.env`. If networking/DNS, cert issuance or Docker fail mid-install, **do not run it repeatedly on the partially configured server** until you've reviewed/recovered the VPS using the Hostinger web console or an administrator. Check the progress output.

## Finish using only web interfaces

1. Open `https://rdp.cmmtools.site/guacamole/`. Sign in as `guacadmin` with the generated password. Set up a **different Guacamole customer identity**, with access only to a dedicated RDP connection. Never share `guacadmin` with a customer.
2. Use Guacamole's Admin → Connections GUI to connect to the existing Windows RDP via its **Tailscale IP** and port **3389**, using a dedicated restricted Windows account. Enable virtual drive with path `/guacamole-drive/customer-1`; do not expose the Windows agent's files/Edge profile. Test upload and download through Guacamole's menu.
3. In Hostinger hPanel's graphical environment-variable page, configure `AIVID_RDP_VIEW_URL=https://rdp.cmmtools.site/guacamole/`, your authorized CMMTools customer ID/email and `AIVID_RDP_VIEW_ENABLED=true`. **Only** set isolation and direct-billing acknowledgment flags after the separate customer session and AIVID account billing have been confirmed. Deploy current `main` of the web app.
4. Customer opens `https://cmmtools.site/aivid-live-studio`. If the Guacamole login cannot operate within an iframe due to cross-site cookies, use **Open full-screen desktop**.

## Security and status

- **No Browserless** for this interactive RDP viewer. Existing Edge RDP agent and CMMTools generation queue are not changed.
- Interactive Generate clicks spend credits **directly in the upstream AIVID account**, not the CMMTools wallet. The installer does not protect against unexpected direct provider charges.
- The installer supports only fresh Ubuntu VPS provisioning. It does **not** magically create a VPS, register DNS, modify Hostinger environment settings, provide Windows licensing or bypass AIVID CAPTCHA.
- Current implementation is not certified against the owner's actual Hostinger Windows RDP/VPS; CI can verify Windows compilation and script syntax, but live gateway/customer isolation/file-transfer acceptance requires setup and manual verification.
- Review the [full production runbook](../../docs/AIVID_RDP_VIEWER.md). Apache Guacamole's own official documentation explains the required user account and RDP drive permissions.

## Download

Find the latest **CMMTools RDP Gateway Windows GUI EXE** successful GitHub Actions run under `.github/workflows/rdp-gateway-windows-installer.yml`. Open the run's artifact `CMMTools-RDP-Gateway-Setup-Windows-x64`, download and extract the ZIP, then double-click `CMMTools-RDP-Gateway-Setup.exe`.

The build is self-contained for Windows x64, so no separate .NET runtime installation is needed.

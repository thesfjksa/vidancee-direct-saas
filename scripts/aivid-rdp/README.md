# CMMTools AIVID RDP agent 2.0

Use Windows 10/11 x64 and the Google Chrome already installed on your RDP.
Extract the **entire ZIP** into a writable folder. Node.js and Playwright are
bundled; no installer or administrator access is required to run the package.

1. Open **AIVID-Login.exe**. Sign in to **aivid.dev** with Google in the ordinary
   Chrome window. No automation/debugging connection is active during this login.
   The login window has no Browserless timer. It uses its own profile, not a copy
   of your regular Chrome profile.
2. Close all windows opened by that Login launcher once. Your other Chrome
   windows can remain open.
3. In **CMMTools Admin → Provider → AIVID**, choose **Windows RDP agent** and
   **Save RDP connection**. Click **Generate pairing code**.
4. Open **AIVID-Agent.exe** on the RDP. Enter `https://cmmtools.site` and the
   pairing code. The code works once and expires after ten minutes. Do not enter
   a Google password or the CMMTools admin token in this terminal.
5. Keep the Agent window running. It opens the saved AIVID Chrome profile,
   checks the form without generating a video, then polls CMMTools for work.
   Back in Admin, **Refresh status**, then **Check RDP connection**. A zero
   AIVID balance can still pass the login/form check; paid submissions require
   sufficient balance and a positive source-credit limit.

After the initial login, Chrome stays running between operations. No browser
control port is exposed to the internet: the Chrome port is loopback-only and
the agent makes outbound HTTPS requests to CMMTools. Browserless is not used.

To sign in again, stop the Agent, close its AIVID Chrome windows, run Login,
finish sign-in, close those login windows and restart Agent. A failed check
leaves Chrome open for inspection; it does not instantly close your login.
Google may require you to complete account verification yourself.

Disconnecting RDP and signing out of Windows are different. The Agent needs the
Windows user session and Chrome processes to remain running. Check your RDP
provider's session-disconnection policy. This package does not configure
Windows auto-login or install a service; restart Agent after a Windows reboot
or sign-in. You can put a shortcut to Agent in your own Windows Startup folder.

The pairing credential is protected using Windows DPAPI for the current user
and bound to the CMMTools origin. Google authentication stays in the separate
`.aivid-rdp-profile` folder. Keep that folder, `.aivid-agent.json`, and `receipts`
when updating; replace only program files. Use the new Agent launcher rather
than the older standalone Submit launcher.

Only one Agent may use the profile. The server owns the job queue, price limit,
and paid-click reservation. Before clicking Generate, the Agent writes a local
receipt and waits for the server's saved reservation. Accepted source IDs are
used for subsequent collection. An ambiguous click is held for review, never
automatically submitted again. Do not delete a receipt to retry a paid job.

Finished MP4s are validated and uploaded in bounded chunks to CMMTools, which
uses its existing video storage and completion/refund transactions. Reference
files are fetched only for the assigned command and checked by size/hash.
Source-private visibility and the existing submission request guard are used.

Customer model activation is still a separate live-verification step. The
packaged tests do not prove Google login, a paid AIVID generation, or 24/7
operation on your particular RDP. Start with the no-charge connection check.

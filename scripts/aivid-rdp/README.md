# CMMTools AIVID RDP agent 2.1.0

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
   **Save RDP connection**. Click **Generate pairing code**, then **Copy code**.
4. Open **AIVID-Agent.exe** on the RDP. A normal Windows pairing window opens
   on the first run. The CMMTools address is prefilled. Click **Paste code**,
   then **Connect**; Ctrl+V and right-click Paste also work in the code field.
   The code works once and expires after ten minutes. After pairing, later
   starts reuse the encrypted credential without asking for another code.
   Do not enter a Google password or the CMMTools admin token here.
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
Public visibility is selected and independently checked in the outgoing request, following the owner’s setting.

Customer model activation is still a separate live-verification step. The
packaged tests do not prove Google login, a paid AIVID generation, or 24/7
operation on your particular RDP. Start with the no-charge connection check.

Version 2.0.1 prints each check stage and reports a fixed diagnostic code in
Admin instead of discarding the failure. It keeps a starting heartbeat alive
during the first Chrome check and uses keyboard events for the duration slider.
To update, stop Agent and overwrite the program files inside your existing
agent folder with this ZIP's contents. Preserve the profile, encrypted pairing
file and receipts. Reopen Agent, retry Check RDP connection, and report the
bracketed diagnostic code if a check still fails. No new login or pairing is
needed when using the same folder and Windows user.

Version 2.0.2 adds the Windows pairing dialog and Paste code button. Admin also
has Copy code and a selectable code field. The ZIP is a complete standalone
package. Starting in a fresh folder requires a fresh manual login and pairing;
keeping the existing folder preserves the saved profile and pairing.

Version 2.0.3 finds the visible prompt editor in the Generate area instead of
requiring specific placeholder text. It supports textareas and rich-text
editors, ignores hidden fallback fields, and reports separate codes for a
visible Sign In button, a missing editor, multiple editors or a redirected tab.
A zero credit balance is still valid for the no-charge connection check.

Version 2.0.4 fixes private visibility. AIVID uses a hidden checkbox inside a
visible Public/Private switch; checked means Private. The agent identifies
that switch by its labels, clicks its visible label only when needed, and
verifies the checked state again before finishing preparation. An unknown,
disabled or ambiguous switch still stops before submission. The outgoing
request in that version also required private visibility (changed to Public in 2.0.5 below). Update in the existing
folder as above; no new login or pairing is needed.

Version 2.0.5 always selects Public before every preflight or generation,
as requested by the owner. It unchecks the hidden Private checkbox through
the visible switch, verifies Public again after preparing the form, then reads
the displayed public price and checks the saved credit limit and balance.
The outgoing request guard also requires explicit public visibility and blocks
private, missing or contradictory visibility fields. This does not click
Generate during a connection check or authorize any paid trial.

Update using this complete ZIP: stop Agent, extract the entire ZIP into the
existing agent folder and allow overwriting, then restart AIVID-Agent.exe.
The package includes all EXEs, Node runtime, dependencies and adapters. Saved
profile, pairing and receipt files are not overwritten by the package.

## Premium Video Studio integration (2.1.0)

CMMTools lists AIVID Seedance 2.0 Mini, Seedance 2.0 and Seedance 2.5 as
Premium video models while this agent is paired, online and enabled in Admin.
The agent selects the model explicitly and reads Public-mode price before it
will attempt any paid click. If AIVID has changed a model selector or payload,
validation blocks the request; do not bypass these safety guards.
A new pricing preflight on the server is used for each new customer job.
The wallet reservation is released if the actual source price differs from
that quote, so a customer is never charged an unapproved higher amount.

In Admin, set the maximum AIVID credits per clip and the **customer credits
per AIVID credit** rate; these are separate from 888API's yuan prices.
Stop Agent, extract the complete latest ZIP over the existing agent folder,
then run AIVID-Agent.exe. Keep the existing agent profile, pairing file and
receipts; do not delete or reset them. Existing uncertain submissions must
be reconciled against provider history rather than retried.

For the initial customer-credit conversion, the Admin rate defaults to **480
CMMTools credits per one AIVID source credit** (Rs 20 at the current wallet
scale). Check the real cost per AIVID credit and adjust before enabling customer
payments. The normal per-customer price-rate adjustment still applies.

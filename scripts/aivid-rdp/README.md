# CMMTools AIVID RDP agent 2.1.4

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

**6 Nov source-cost update:** AIVID credits cost USD $0.12 each. The web and
worker use the same USD-to-wallet scale as the other models: **806.40 base
CMMTools credits per AIVID credit**, then standard 5% and any customer boost.
The Admin rate is now read-only and ignores old saved 480 values. The AIVID
source-credit ceiling is a separate per-video safety limit. Update both web
and worker; the agent code does not need a new package for this pricing change.

## Form verification improvement (v2.1.1)

Agent v2.1.1 verifies the **selected current model button**, not a menu option,
and tolerates AIVID adding descriptive text after the primary model/resolution
labels. It still validates the exact model identity, prompt, duration, ratio,
resolution, and **Public** visibility separately before any paid Generate click.
New safe error codes `form_model`, `form_resolution`, `form_aspect_ratio`,
`form_duration`, `form_prompt`, and `form_privacy` identify which value
mismatched without leaking your prompt, page text or login information.

This adapter change **requires replacing the entire Windows Agent ZIP**. To
upgrade, first stop Agent and close its Chrome profile windows; extract the
complete v2.1.1 package over your existing program files **without deleting**
`.aivid-agent.json`, `.aivid-rdp-profile/`, or `receipts/`. Keep pairing
and receipts intact, then start Agent once and use the Admin **Check RDP
connection** (read-only). Do not retry old uncertain paid jobs.

### Image reference upload safeguards (v2.1.1)
The reference uploader now matches media input acceptance by MIME family and
extension (rather than strict accept-attribute text), confirms the browser's
selected FileList, and rejects missing/ambiguous controls. In the customer
video path, CMMTools stores references and transfers them as verified binary
chunks with file-kind, size and SHA256 checks; the outbound paid request guard
still rejects missing/wrong reference counts/types. A selected browser file
is **not** proof that AIVID's server has finished receiving it; real live
reference-upload behavior must be verified before promising paid image-to-video.

**Admin Check RDP connection is text-only and never attempts a reference upload.**
If the failure says `form_model`, `form_privacy`, or `form_resolution`, it is
not a reference upload error; this check should not spend AIVID credits.

## Video length accuracy — v2.1.3

The AIVID adapter now reads the **actual current** slider min/max/step
after selecting the model and resolution; it never assumes 4–15 or 4–30
is available on the signed-in site. It drives each permitted step with
real keyboard events to update the React form and live quote, then checks
the slider value, ARIA state (when present), and nearby visible duration
label (e.g., `15s`). The same checks run again *after* setting Public,
uploading references and filling the prompt. The outbound paid request
guard still requires `body.duration === requested duration`. If the
browser's duration limit or step is different, preflight fails **without
submitting or charging**. Do not change the slider by JavaScript DOM
assignment or override this safety check.

Video Studio now selects the configured default (5 seconds) for Premium
models instead of automatically choosing the longest length. Existing
other providers keep their original selection behavior.

The maximum shown by AIVID's signed-in web slider for 2.5 may be less
than the API's theoretical 30 seconds. Only the actual browser control
can authorize the requested duration. To calibrate live controls, inspect
the slider's `outerHTML` plus nearby duration label for each model.
No private token, cookies, or prompt contents are needed.

## Model selection reliability — v2.1.3
Waits for the visible model menu option before selecting it, skips reopening an already-selected model, and rejects ambiguous options. Public visibility, exact duration, outgoing request and durable receipt checks remain required. Upgrade the entire ZIP after stopping the old agent; preserve pairing, Chrome profile and receipts.

## Prompt retention — v2.1.4
Windows CRLF/lone-CR line endings are normalized to browser LF without collapsing spaces, blank lines, mentions or Unicode. Prompt entry commits focus and must remain exact for a short stability window. One pre-submit refill is allowed after a reset; persistent changes still stop before Generate. The outgoing request guard independently checks the same text. Upgrade the entire package after stopping the old agent, preserving pairing/profile/receipts.

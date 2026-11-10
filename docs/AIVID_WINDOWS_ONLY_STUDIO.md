# Windows Premium Studio — updated to manual Edge sharing

**The former Playwright-based interactive Windows Edge viewer has been replaced by a view-only extension relay from an ordinary, manually opened Microsoft Edge AIVID tab.**

Do not use the older "Open private Edge", automated click/typing, or relay file-transfer setup instructions. Those viewer API routes have been retired. Do not run **AIVID-Login.exe** or **AIVID-Agent.exe** to start this new screen-sharing workflow.

For the complete Admin and Windows graphical setup, security model, pairing, no-CLI installation and limitations, see **[AIVID Manual Edge Tab Share](AIVID_MANUAL_EDGE_TAB_SHARE.md)**.

The separate automated AIVID paid-generation agent and its queued/receipt workflows remain unchanged and can still use Playwright; they are **not** used in the manual screen-share viewer. Pause new paid AIVID submissions in Admin if you want a completely manual AIVID browser experience, but do not interrupt an uncertain in-flight paid job.

No Linux VPS, Guacamole, Browserless, Hostinger environment changes or new Windows RDP server are required for the **view-only** extension solution. Remote mouse/keyboard automation and browser-controlled reference uploads/downloads are intentionally unavailable; all such actions must be performed by a person in normal Edge. This does not guarantee that AIVID will not issue CAPTCHA.

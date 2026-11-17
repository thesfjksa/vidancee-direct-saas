# CMMTools launcher: Chrome Web Store distribution

## v1.6.1 Webshare import update

Use `CMMTools_Video_Studio_Chrome_Store_v1.6.1.zip` for the Webshare-enabled package. The importer reads direct endpoints with a user-entered API key and requests optional access to `https://proxy.webshare.io/*`. It does not store the key, purchase a plan or enable routing automatically. Update privacy and host-permission disclosures before submitting the new version. Setup and justification text are in `EXTENSION_PROXY_SETUP.md`.

## v1.6.0 optional proxy update

Use `CMMTools_Video_Studio_Chrome_Store_v1.6.0.zip` for the new version. Proxy routing is off by default; no endpoints or subscription are bundled. Follow `EXTENSION_PROXY_SETUP.md` for setup, scope, credential handling and the new optional permission justifications. The v1.5.1 instructions below describe the earlier package without this feature; update your listing/single-purpose/privacy disclosures for v1.6 before submitting it. A listing already awaiting review must not be advertised as including the new behavior until the update is approved.


## Prepared in this change

- The Extension navigation link opens `/extension`. A valid `CHROME_WEB_STORE_EXTENSION_ID` enables its Chrome Web Store link. Blank/invalid settings display an explicit unavailable notice and manual ZIP fallback. Configure the ID only after the listing is published.
- `/extension/privacy` is public without sign-in. It covers the launcher's local DOM reads, Chrome sync preferences, session window ID and provider-site use. This policy covers this version only; adding proxy credentials/telemetry later requires a new review.
- `public/downloads/CMMTools_Video_Studio_Chrome_Store_v1.5.1.zip` is the publisher-upload archive, with manifest.json at its root. It preserves v1.5 launcher behavior; only packaging metadata, production website messaging origins and stale options guidance change. No VPN/proxy feature is added.
- Rebuild with `python3 scripts/package-chrome-store.py`. Input is the committed v1.5 manual ZIP. The deterministic output excludes the original README/integration wrapper. It contains the bundled JS/CSS/HTML and PNG icons.

## Finish publication

1. Open https://chrome.google.com/webstore/devconsole with the owner's Google developer account. Complete registration/payment if needed. The assistant has not created an account, paid a fee, accepted publisher terms or submitted the listing.
2. Upload the **Chrome Store v1.5.1** ZIP, not the old manual download ZIP. Review the manifest and packaged source. Run the extracted package in ordinary Chrome first: toolbar click, new/reused window, own-account sign-in and options changes. Actual authenticated AIVID UI acceptance remains necessary.
3. Suggested name: **CMMTools Video Studio Launcher**. Summary: **Open AIVID in a separate studio window with configurable CMMTools display preferences. Uses your own AIVID account.**
4. Suggested listing description: **Launch your AIVID workspace from the toolbar in a separate window. Apply CMMTools display preferences for page titles/icons, navigation, footers and the header credit-purchase control. Change these preferences in Extension options. This independent launcher requires your own AIVID account and does not include generation credits. It does not bypass sign-in or provide a VPN. Local display changes do not restrict your provider account or conceal its origin from browser security controls.** The owner must confirm any affiliation/branding rights before submitting.
5. Choose **Unlisted** if installation should be available by direct link without search discovery. It still goes through Google review and anyone with the URL can install; this is not account access control.
6. Provide the required real extension screenshots, store artwork, monitored support/developer contact and reviewer instructions. Use the bundled 128px PNG for the extension icon. Do not use mock screenshots implying unverified live behavior.
7. Privacy policy URL: `https://cmmtools.site/extension/privacy` after deploying this web revision. Disclose `storage` for display preferences and the existing AIVID content scripts for local DOM customization. Explain Chrome sync data accurately when completing the current privacy questionnaire; review the packaged code rather than blindly selecting “no data.” All executable code is bundled.
8. Submit for review, address any review findings, publish, then copy its 32-letter ID. Set `CHROME_WEB_STORE_EXTENSION_ID` in the Hostinger **web app**, restart/redeploy and verify `/extension` points to the real published listing. Never use an invented ID or indicate availability while pending review.
9. Test on ordinary Chrome on Windows: website → Extension → Add to Chrome → browser confirmation, then toolbar launch. Check Edge installation too. Remove an old unpacked copy after migrating; its ID and settings do not automatically transfer. Chrome manages store updates after installation.

## Deployment and boundaries

GitHub merging does not publish the Web Store listing or deploy Hostinger. The store ZIP is committed for the publisher; the website serves the existing manual ZIP until store installation is configured. Users must confirm installation in their browser; regular Windows/macOS Chrome cannot silently install a self-hosted CRX. Managed enterprise policies are a separate deployment model, not needed for this customer flow.

Official references:
- https://developer.chrome.com/docs/extensions/how-to/distribute
- https://developer.chrome.com/docs/webstore/register
- https://developer.chrome.com/docs/webstore/cws-dashboard-distribution
- https://developer.chrome.com/docs/webstore/review-process

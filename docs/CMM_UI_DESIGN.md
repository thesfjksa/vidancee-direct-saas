# CMM Tools creation studio

Brand system implemented on 2026-10-07; documentation updated 2026-10-11 for the current Hostinger app at `ai.mehroz.online`.

## Brand and visual system

- The supplied full logo appears in the application header, sign-in and admin screens.
- The supplied app icon is the favicon, touch icon and loading-screen mark.
- Deep blue `#004574` anchors headings and primary actions; turquoise `#00B9C9` identifies highlights and brand details.
- Interactive turquoise text uses a darker `#007D91` for readability on white.
- Since the 2026-10-11 restyle, surfaces are neutral (`#F6F7F9` page, white panels, `#E5E8EC` borders) and headings use near-black `#0F1D2B`; deep blue is reserved for primary actions, the active tab and highlight tiles.
- Type is Inter, self-hosted as a variable WOFF2 (`public/assets/fonts`, SIL OFL licence alongside). Body text is 14px and secondary text never drops below 12px.
- Status badges are rounded pills with a colored dot; cards use 12px radii, layered soft shadows and a subtle hover lift.
- The sign-in screen pairs a deep-blue gradient panel (white logo, grid texture) with a clean white form.
- Artwork is drawn in CSS and inline SVG. No external font or image service is required.

## Layout and behavior

- The logo, workspace navigation (underline tabs), credits and account sit in a single 64px sticky bar on wide screens. Below 1200px the tabs wrap into a second scrollable row and the active tab is scrolled into view. The content uses the full available width. Video/image creation uses a sticky panel with its own scrolling form and an always-visible submission footer.
- The document stays scrollable for long generation histories; the gallery does not sit in a fixed-height, clipped container.
- Mobile uses the same top navigation row. On narrow screens the creation panel sits above the gallery and both remain reachable through normal page scrolling.
- Model selection is a centered native modal dialog in the browser top layer. The header and search stay in place while the model list scrolls independently.
- Search filters the available model catalog. Keyboard arrows navigate results; Enter selects. Escape, the close button and a backdrop click dismiss the modal.
- Video, image, voice, library, plans, credits, account and admin screens share the same brand palette.
- Existing generation handlers, provider assignments, credit calculations and video DOM-preservation logic remain in place.

## Image controls and floating preview

The image ratio control opens a shape-based popup with vector representations of the selected model's supported ratios. SmartAIPI quality selection offers Low, Medium and High when priced, with Medium as the default when available. The server uses the selected model, ratio and quality for the saved quote and submitted request.

The completed-image preview was redesigned and deployed on 2026-10-09. It uses a pale `#f3f7f9` canvas, a light blurred backdrop, white details, fine borders and soft teal actions. The image stays fully contained. The panel shows the saved prompt, ratio, quality, reserved credits and actual loaded pixel dimensions. Download image saves the original output. Reuse prompt closes the preview and restores the composer and available owned references without submitting a new generation.

Desktop displays details beside the image. Mobile stacks them below the image with a collapsible prompt and reachable actions. Escape, the close button and backdrop dismiss the preview. Focus returns to the image thumbnail even if it was replaced while the dialog was open. Delayed close events are guarded so quick reopening does not clear a new preview.

Completed video and voice playback elements are preserved during periodic status rendering to avoid restart or interruption.

## Files and serving

- `public/brand.css`: shared color, typography, form, button and status tokens.
- `public/studio.css`: customer layout, galleries, model picker, authentication and responsive rules.
- `public/admin.css`: admin controls, tables, provider cards and dialogs.
- `public/assets/cmmtools-logo.png` and `public/assets/cmmtools-icon.png`: original supplied assets.
- `public/assets/cmmtools-logo-sm.png`: 360 px copy of the logo (6 KB) used in the page headers; regenerate it from the original if the logo changes.
- `public/assets/fonts/inter-latin-wght.woff2`: self-hosted Inter variable font (Latin subset) with `OFL.txt`.
- `server.js`: explicit GET/HEAD routes for these styles and assets, plus a favicon alias. No general filesystem route was added.
- CSS URLs include a version key. Assets/styles use a one-hour public cache lifetime.

## Verification

- The original 2026-10-07 brand rollout recorded build, parser-test, syntax and whitespace checks. The three-test count belonged to that early check and is not the current suite size.
- The 2026-10-09 image-canvas release recorded 42 automated tests passing. The preview redesign separately passed JavaScript syntax, whitespace and browser checks at seven desktop/mobile/landscape viewport sizes with portrait, landscape and square fixtures, long prompts, download, reuse, keyboard/backdrop dismissal, focus restoration, fast reopening and load errors. These are dated validation records, not new paid-provider tests on 2026-10-11.
- Browser checks use the real application HTTP server, with customer/admin API responses mocked. They do not spend provider credits or verify production providers.
- The browser run verifies loaded assets, a 27-model list, modal bounds, list scrolling, model search/keyboard selection, Escape/backdrop dismissal, a 28-generation history, gallery/page scrolling and independent form scrolling.
- Layouts are checked at 360, 390, 620, 768, 820, 1024, 1440 and 1920 pixels for horizontal overflow and appropriate navigation.
- All seven customer sections, generation submission with a mocked response, sign-in and admin overview render without browser JavaScript errors.
- Desktop and mobile screenshots were visually inspected. The live Hostinger deployment must be checked separately after deployment.

## Deployment

Deploy the updated `main` branch through the existing Hostinger GitHub integration. The web app must receive the updated `public` assets and `server.js` together. This update does not require database migrations or environment changes. The standalone worker does not require new UI configuration.


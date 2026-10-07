# CMM Tools creation studio

Implemented on 2026-10-07 for the existing Hostinger app at `ai.mehroz.online`.

## Brand and visual system

- The supplied full logo appears in the application header, sign-in and admin screens.
- The supplied app icon is the favicon, touch icon and loading-screen mark.
- Deep blue `#004574` anchors headings and primary actions; turquoise `#00B9C9` identifies highlights and brand details.
- Interactive turquoise text uses a darker `#007D91` for readability on white.
- Light surfaces, slate text, fine borders, consistent line icons, restrained shadows and larger typography replace the previous lime/dark presentation.
- Artwork is drawn in CSS and inline SVG. No external font or image service is required.

## Layout and behavior

- Desktop navigation occupies a separate rail. Video/image creation uses a sticky panel with its own scrolling form and an always-visible submission footer.
- The document stays scrollable for long generation histories; the gallery does not sit in a fixed-height, clipped container.
- Mobile navigation appears in a bottom dock. On narrow screens the creation panel sits above the gallery and both remain reachable through normal page scrolling.
- Model selection is a centered native modal dialog in the browser top layer. The header and search stay in place while the model list scrolls independently.
- Search filters the available model catalog. Keyboard arrows navigate results; Enter selects. Escape, the close button and a backdrop click dismiss the modal.
- Video, image, voice, library, plans, credits, account and admin screens share the same brand palette.
- Existing generation handlers, provider assignments, credit calculations and video DOM-preservation logic remain in place.

## Files and serving

- `public/brand.css`: shared color, typography, form, button and status tokens.
- `public/studio.css`: customer layout, galleries, model picker, authentication and responsive rules.
- `public/admin.css`: admin controls, tables, provider cards and dialogs.
- `public/assets/cmmtools-logo.png` and `public/assets/cmmtools-icon.png`: original supplied assets.
- `server.js`: explicit GET/HEAD routes for these styles and assets, plus a favicon alias. No general filesystem route was added.
- CSS URLs include a version key. Assets/styles use a one-hour public cache lifetime.

## Verification

- `npm run build`, `npm test` (3 existing tests), Node syntax checks and whitespace validation pass.
- Browser checks use the real application HTTP server, with customer/admin API responses mocked. They do not spend provider credits or verify production providers.
- The browser run verifies loaded assets, a 27-model list, modal bounds, list scrolling, model search/keyboard selection, Escape/backdrop dismissal, a 28-generation history, gallery/page scrolling and independent form scrolling.
- Layouts are checked at 360, 390, 620, 768, 820, 1024, 1440 and 1920 pixels for horizontal overflow and appropriate navigation.
- All seven customer sections, generation submission with a mocked response, sign-in and admin overview render without browser JavaScript errors.
- Desktop and mobile screenshots were visually inspected. The live Hostinger deployment must be checked separately after deployment.

## Deployment

Deploy the updated `main` branch through the existing Hostinger GitHub integration. The web app must receive the updated `public` assets and `server.js` together. This update does not require database migrations or environment changes. The standalone worker does not require new UI configuration.

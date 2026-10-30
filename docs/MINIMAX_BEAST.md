# Minimax Beast — vgenv Origin Quality (30 October 2026)

## User-facing model
- Display name: **Minimax Beast**
- Internal CMMTools ID: `minimax_beast`
- Provider: existing `vgenv` (no new key or source switch)
- vgenv POST: `/v3/videos`, payload `model: "origin"`, `tier: "quality"`.
- Existing `minimax_h3_origin` still sends `model: "origin"`, `tier: "fast"`. Base and Cinematic are unchanged.
- Duration: integer 4–15 seconds, resolutions 480p / 768p, existing H3 aspect ratios and validated reference-media handling.

## Source and customer pricing
Published vgenv Origin **Quality** rates checked 30 October 2026:
| Resolution | USD per second | 10s upstream USD |
| --- | ---: | ---: |
| 480p | $0.0077 | $0.077 |
| 768p | $0.015 | $0.150 |

`src/pricing.js` computes `ceil(rate_per_second * CREDITS_PER_USD * seconds)` at 6,720 CMM credits per USD; the server applies existing account pricing (including standard 5% increase and optional boosted rate) downstream. At 10 seconds, baseline: 518 credits (480p), 1,008 credits (768p); standard 5% account price: 543.9 (480p), 1,058.4 (768p) credits. Do not manually multiply again in the worker.

The model is exposed by the existing `H3_MODEL_IDS` catalog, public video config and Cartoon Studio list; vgenv worker `submitVgenv` selects model/tier from the *saved CMM model ID*, never from untrusted client tier input. H3 worker polling already requests `/v3` for both Origin and Beast.

## Changed files
- `src/pricing.js` — public model, pricing, `h3VgenvTier` helper.
- `src/provider/vgenv.js` — validated tier parameter in the POST body, default `fast` for prior callers.
- `src/worker_admin_settings.js` — passes tier for the saved H3 ID.
- `test/h3_models.test.js` — catalog, rate and request tests, worker payload and regression check.
- `docs/CHANGELOG.md`, `docs/PROJECT_HANDOFF_2026-10-25.md`, `README.md` — continuity.

## Release boundary and validation
- Run `npm test` and confirm GitHub Actions passes on the PR.
- Check the public config and video/cartoon picker display Beast and its exact quoted credits for 480p and 768p. Ensure the 5% / boosted customer adjustments match actual debit and refund.
- Deploy the **same merged commit** to both Hostinger web (`server.js`) and worker (`worker.js`), confirm recent worker polling, DB writes and available provider balance.
- With owner approval, submit **one paid 4-second Beast job** and verify provider request `origin+quality`, exact provider job ID, completed MP4, cloud storage and credit ledger. Do not automatically repeat an uncertain paid POST.
- vgenv studio's *Origin* and *Quality* are upstream concepts; **Minimax Beast** is a local CMMTools marketing alias, not a separately certified vgenv model.
- No provider credentials, customer files or production DB contents belong in the repo.

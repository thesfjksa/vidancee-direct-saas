# Seedance 2.0 Mini — vgenv-backed CMMTools alias (31 October 2026)

Customer display label: **Seedance 2.0 Mini**, video model ID `seedance_2_0_mini`. This is a **local marketing alias** of **MiniMax H3 Origin Fast via vgenv**, NOT the original ByteDance Seedance model. This fact is disclosed in the Video Studio model warning.

The video worker sends `POST /v3/videos` with `model: "origin"`, `tier: "fast"`. Supports durations 4–15 seconds, resolutions 480p/768p, existing H3 aspect ratios and image/video/audio reference limits. Published source rates are $0.0023/sec (480p) and $0.0046/sec (768p), converted at 6720 CMM credits/USD, then existing customer 5%/optional boosted rate rules.

The original `minimax_h3_origin` and Quality-tier `minimax_beast` remain available. New alias is visible in Video Studio only, and requires existing vgenv source access.

Old 888API Mini upstream ID `sd_2.0_mini_special` was removed from the 888API customer OFFERED allowlist. Historical DB rows and jobs are not deleted. Saved adapter state is overridden at read time: unavailable for new generations even if formerly enabled. Other Seedance 2.0 888API SKUs are unaffected.

## Acceptance
1. Merge only after CI passes; deploy same merged commit separately to web and worker in Hostinger.
2. Verify Video Studio catalog includes `seedance_2_0_mini`, original Origin and Beast, and displays real-backend disclosure; Cartoon Studio does not duplicate Mini.
3. Verify no new customer quote or submission routes to `api888_sd_2_0_mini_special`.
4. Compare 480p/768p quotes to `minimax_h3_origin`, including account price multipliers and correct debit/refund.
5. With separate owner consent, run one paid 4-second vgenv test; confirm `origin`+`fast`, provider job ID, successful output and ledger. Never retry ambiguous paid submissions automatically.

This source change is not a live deployment or paid-provider confirmation.

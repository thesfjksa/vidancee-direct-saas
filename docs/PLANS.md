# CMM Tools plans

Updated 11 October 2026.

## Public plans

| Plan | Monthly price | Included credits | Concurrent generations | Queue |
| --- | ---: | ---: | ---: | --- |
| Basic | PKR 1,500 | 500 | 2 | Standard |
| Pro | PKR 4,500 | 1,500 | 3 | Priority |
| Premium | PKR 12,000 | 4,000 | 5 | Highest |

All plans use one customer balance, with source-specific generation pricing:

- Fixed-price video models (Seedance on Vidancee/CreatePulse, MiniMax H3 on vgenv) are calculated in `src/pricing.js`: real source cost in credits (Rs 3 each; USD at Rs 280) × 2.5, rounded to two decimals. No environment variable changes them.
- SmartAIPI uses `ceil(estimated source USD * customer credits per USD)`, default `160 / 0.0265`. It does not add the shared multiplier.
- Vibi TTS reserves an estimate and reconciles to the reported source credits times the shared multiplier. Voice cloning has an Admin-configurable customer cost.

The plan price does not multiply generation costs again. Source assignments and model availability remain separate from plan concurrency. See [SMARTAIPI.md](SMARTAIPI.md) and [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md).

## Current purchase workflow

There is no automatic payment gateway, recurring billing or scheduled monthly credit grant. Included credits are granted for each approved purchase request. The displayed monthly price does not implement automatic renewal.

1. Customer opens **Plans**.
2. Customer requests Basic, Pro, or Premium.
3. The request appears in **Admin → Plans**.
4. Admin verifies payment externally.
5. Admin approves the request.
6. The app activates the plan and adds its included credits.

Rejecting a request does not modify the user's plan or credits.

## Runtime entitlement

Plan concurrency is shared across active video, image and voice generation records:

- no paid plan: 1
- Basic: 2
- Pro: 3
- Premium: 5

Plan queue priority is:

- no paid plan: 0
- Basic: 10
- Pro: 20
- Premium: 30

Queued jobs are processed by priority first, then by creation time.

## Source of truth

Plan definitions are in:

`src/plans.js`

Do not duplicate plan prices/credits in frontend JavaScript. The customer page receives plan definitions from `/api/config`.


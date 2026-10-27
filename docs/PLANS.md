# CMM Tools plans

Updated 25 October 2026 to reflect current `src/plans.js`; see [latest handoff](PROJECT_HANDOFF_2026-10-25.md). **GitHub source may be newer than Hostinger production**, which had a blocked repository clone.

## Currently offered plans (request + manual approval)

| Plan | Price per approved purchase | Included credits | Concurrent generations | Queue |
| --- | ---: | ---: | ---: | --- |
| Creator | PKR 5,000 | 60,000 | 3 | Priority 20 |
| Studio | PKR 10,000 | 120,000 | 5 | Priority 30 |
| Enterprise | Custom / contact | Custom | Custom | Custom |

Former **Basic** (PKR 1,500, 500 credits), **Pro** (PKR 4,500, 1,500 credits) and **Premium** (PKR 12,000, 4,000 credits) are **legacy plans** supported for existing customers but are no longer offered as new public purchases. No automatic monthly renewal is implemented.

All plans use one customer balance, with source-specific generation pricing:

- Fixed-price video models (MiniMax H3 on vgenv) are calculated in `src/pricing.js` at cost: 24 credits per rupee of source cost (USD at Rs 280), rounded up.
- SmartAIPI uses `ceil(estimated source USD * customer credits per USD)`, default `160 / 0.0265`. It does not add the shared multiplier.
- Vibi TTS reserves an estimate and reconciles to the reported source credits times the shared multiplier. Voice cloning has an Admin-configurable customer cost.
- **Boosted pricing (per customer, Admin → Users → 60k → 42k):** every price for that customer is shown and charged × 60,000 / 42,000 (`users.price_rate`), so a 60,000-credit plan buys 42,000 credits of usage. Off by default.

The plan price does not multiply generation costs again. Source assignments and model availability remain separate from plan concurrency. See [SMARTAIPI.md](SMARTAIPI.md) and [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md).

## Current purchase workflow

There is no automatic payment gateway, recurring billing or scheduled monthly credit grant. Included credits are granted for each approved purchase request. The displayed monthly price does not implement automatic renewal.

1. Customer opens **Plans**.
2. Customer requests Creator or Studio (Enterprise requires manual contact).
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


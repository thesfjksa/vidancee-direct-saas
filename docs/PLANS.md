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

The plan price does not multiply generation costs again. Source assignments and model availability remain separate from plan concurrency. See [SMARTAIPI.md](SMARTAIPI.md) and [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md).

## Current purchase workflow

There is no automatic payment gateway, recurring billing or scheduled monthly credit grant. Included credits are granted for each approved purchase request. The displayed monthly price does not implement automatic renewal.

1. Customer opens **Plans**, or selects a priced plan on the public pricing page and signs in.
2. Creator shows the owner's **PKR 5,000** Easypaisa QR; Studio shows the separate **PKR 10,000** QR. These were reconstructed as vector assets from the original uploaded QR payloads and independently decoded.
3. The QR checkout displays recipient **MEHROOZ MUSHARRAF**, number ending **0512**, and the expiration date **27 November 2026**. The interface hides the expired code and requests that customers contact support after that date. Replace both assets with fresh bank-issued codes before expiry.
4. After sending funds externally, the customer selects **I have paid — submit for review**, creating the existing pending plan request. This is a *claim*, not proof or automated verification.
5. The user can send their payment receipt or transaction ID to existing WhatsApp support with their request number. There is no new receipt storage system.
6. The request appears in **Admin → Plans**; admin independently verifies cleared funds in Easypaisa, not merely from the screenshot.
7. Only after admin approval are plan and credits granted. Rejection leaves credits untouched.
8. Enterprise remains a custom WhatsApp quote without a QR.

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


## Easypaisa QR implementation (2 November 2026)

- `public/assets/payments/easypaisa-5000.svg` and `easypaisa-10000.svg` are scannable vector reproductions of the owner's uploaded QR payloads; they must **not** be freely regenerated with new account details.
- `public/payment-qr.js` and `public/payment-qr.css` provide the checkout dialog, receipt-submission WhatsApp link, and expiry guard. `public/index.html` retains the existing database-backed pending-plan-request flow, and `public/pricing.html` provides the selected-plan login deep link.
- No changes to plan prices, credit grants, financial ledger logic, or the admin approval route. Clicking I have paid does not confirm payment.
- GitHub merge does not guarantee that Hostinger's separate web and worker applications deploy this revision. Verify the web release and scan both QR codes on the actual deployed site.

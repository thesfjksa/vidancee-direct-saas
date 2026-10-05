# Mehroz AI plans

## Public plans

| Plan | Monthly price | Included credits | Concurrent generations | Queue |
| --- | ---: | ---: | ---: | --- |
| Basic | PKR 1,500 | 500 | 2 | Standard |
| Pro | PKR 4,500 | 1,500 | 3 | Priority |
| Premium | PKR 12,000 | 4,000 | 5 | Highest |

All three plans use the same credit economy. Individual model deductions continue to be calculated from the sourcing rule:

`customer credits = source billing units × 2.5`

The plan price does not multiply generation costs again.

## Current purchase workflow

There is no automatic payment gateway yet.

1. Customer opens **Plans**.
2. Customer requests Basic, Pro, or Premium.
3. The request appears in **Admin → Plans**.
4. Admin verifies payment externally.
5. Admin approves the request.
6. The app activates the plan and adds its included credits.

Rejecting a request does not modify the user's plan or credits.

## Runtime entitlement

Plan concurrency is shared across video and image generations:

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

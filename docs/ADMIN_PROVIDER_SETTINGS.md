# CMM Tools Admin provider settings

Updated through the 25 October 2026 PR #45 source-control checkpoint. Earlier sections retain October 11 integration history.

## 25 October 2026 — 888API account model audit and new-model activation

For full status, see the [comprehensive October 25 handoff](PROJECT_HANDOFF_2026-10-25.md) and [888API model contract guide](API888.md). The current GitHub `main` source checkpoint after PRs #43–#45 was `f82b02c0` (281 post-merge passing tests); this does **not** verify Hostinger web or worker have deployed those changes.

**Owner-observed Admin → Providers → 888API → Verify live import (read-only)** showed **64** live upstream IDs, **115** historical MySQL IDs, **49** stale, **0** missing imports, **0** incorrect `available` flags, **0** wrong types, **27** supported adapters, **32** locally priced, and **27** ready-and-enabled (23 video / 4 image) before the last model expansion. **888API global source was ON** in that audit; each customer still needs its separate source assignment.

- **Read-only audit:** `POST /admin/api888/audit` fetches authenticated upstream `GET /v1/models` and reads `provider_models`; no paid creation or DB mutation. “Historical / not returned” means the current account is not listing that exact ID; the old MySQL row is not an entitlement. Auditing alone never fixes unsupported adapters.
- **Writable refresh:** **Import all accessible models** (`POST /admin/api888/sync`) persists the current authorized IDs and model metadata. Requires a healthy, writable database. A full/permission-denied Hostinger database will block this step. GitHub merge does not refresh saved options automatically for newly enabled models.
- **Three reference types:** `seedance-2.5-g5-v2` was returned by the current API key, but originally “adapter not implemented.” Its 888API model card confirms **720p**, **5–30 seconds**, **¥7 per request**, and **30 image + 10 video + 10 audio references**. PR #45 implements a CMMTools adapter with corresponding price, references and upload controls. **Exact G5-V2 POST field names follow a related G2-V model and still need a controlled live test**; do not assert upstream generation succeeds just because UI selectors appear.
- **Critical Admin gate:** PR #44 changed sync to mark previously unsupported/new 888API SKUs **`enabled=0` when they first gain adapter support**. This protects paying users despite the owner's globally enabled source. After import, enable the **specific G5-V2 model** and **specific test customer's source** for a controlled approved paid request, not the whole provider inventory.
- **Pricing:** For 888API only, **1 CNY of verified source cost = 1 CMMTools credit**, with no USD conversion; G5-V2 should show **7 credits per request**. The new code may implement up to **55 of the same 64** audited IDs, but the actual ready-and-enabled count stays lower until explicitly enabled and must be checked after deployment/sync.
- **Still blocked unless independently documented:** G5-V2 provider-specific request schema, production generation/download, deployed web+worker SHA, and older Hostinger MySQL quota and clone issues. Never paste API keys, OAuth secrets, signed reference URLs or raw credit records into support chat or documentation.

**Operator order:** Verify both Hostinger services and database writes → audit → import → review model metadata/price and disabled state → grant limited test account → obtain explicit permission for a paid G5-V2 test → check task/MP4/wallet/refund → optionally enable broader customer use.

---


Provider credentials are managed from the private Admin dashboard rather than from the customer-facing app.

## Admin path

`/admin-console` → **Provider**

The Provider section stores and manages:

- Primary engine base URL
- Primary engine login email
- Primary engine password
- Overflow engine base URL
- Overflow engine API key
- Overflow max-inflight jobs
- vgenv MiniMax H3 API base URL / encrypted API key / max-inflight jobs
- SmartAIPI API base URL / encrypted key / max-inflight jobs / per-model Low, Medium and High square prices / direct customer credits per USD
- Vercel AI Gateway encrypted API key, live image/video catalog, model visibility, USD overrides, max inflight and direct credit conversion
- Gemini prompt-enhancer encrypted API key and global enable switch
- Vibi encrypted API key, max-inflight jobs and customer clone cost
- Routing policy
- Generation submission enable/pause state

## Secret handling

Saved provider passwords and API keys are encrypted before they are stored in MySQL.

The encryption root is:

1. `SETTINGS_ENCRYPTION_KEY` when configured, otherwise
2. `ADMIN_TOKEN`

The Admin read endpoint never returns the saved password or API key. It only reports whether each secret is configured.

Leaving a password/API-key field blank keeps the saved value.

## Legacy hPanel values

On the first deployment of this version, existing provider values from the old hPanel environment configuration are imported into the Admin-managed settings when the matching database value does not already exist.

After confirming the Provider page shows the required engines as configured, legacy provider credential variables can be removed from hPanel.

Infrastructure variables such as MySQL credentials, `APP_URL`, `ADMIN_TOKEN`, and the optional `SETTINGS_ENCRYPTION_KEY` remain server environment settings.

## Runtime behavior

The generation worker reads provider settings from MySQL and refreshes provider clients when saved settings change. Updating an API key in Admin therefore does not require a code change or redeploy.


## Current provider roles

| Studio | Sources |
| --- | --- |
| Video Studio | ArgoLink at 720p/1080p (Seedance 2.5/2.0/Fast/Mini, Wan 3.0/Prime, Grok Video 1.5, MiniMax H3); rendered lower and upscaled by fal.ai |
| Image Studio | Vercel AI Gateway and SmartAIPI first; ArgoLink takes over a model while its source is out of credits, and ArgoLink-only models are always listed |
| Cartoon Studio | vgenv (MiniMax H3) |
| Upscaler and Video Studio HD enhancement | fal.ai (ByteDance Video Upscaler). See `docs/FAL_UPSCALER.md` |
| Voice Studio | Vibi |
| Prompt enhancer | Google Gemini 3.8 Flash |

Atlas Cloud and Higgsfield were removed on 12 October 2026; jobs still open on them are refunded by the worker.

vgenv settings are stored as `vgenv_base_url`, encrypted `vgenv_api_key`, and `vgenv_max_inflight`. The default API origin is `https://api.vgenv.com`.

## Per-customer source access

Provider-wide switches are the master availability controls.

Admin can additionally assign sources per customer from:

`/admin-console` → **Users** → **Sources**

Assignable sources are ArgoLink, Vercel AI Gateway, SmartAIPI, Higgsfield, vgenv/MiniMax, fal.ai/Upscaler and Vibi/Voice Studio. Every studio, Voice included, is on for a customer until it is turned off for them. The prompt enhancer is controlled globally and requires an active signed-in customer.

A customer's model catalog is built only from sources that are both globally available and assigned to that customer. The server also checks the assignment during cost lookup and submission, so this is not only a frontend filter.

All sources default to access enabled until an explicit per-user setting is saved. Voice Studio was opt-in until 2026-10-13; on that release's first start, stored "Voice off" settings were cleared once so Voice follows the default.

## Pricing rule

Provider settings and customer pricing are separate concerns.

Legacy/static providers continue to use the shared billing/pricing configuration where applicable.


SmartAIPI is another exception. Its default direct conversion is `160 / 0.0265` customer credits per estimated source USD, rounded up to whole credits. The shared 2.5 multiplier is not added. Per-quality prices and model switches are Admin-managed. The `gpt2-medium-160` revision supersedes earlier saved conversion factors; an override saved at this revision persists.

Prompt enhancement consumes no customer credits, although Google may charge the owner. Vibi TTS reconciles to reported source credits times the shared multiplier; clone pricing is set separately.

Provider secrets remain Admin-managed.


## Current customer visibility hierarchy

For a model to be offered to a customer:

1. the backend source must be configured
2. the provider-wide source switch must allow it
3. the customer must have that source assigned
4. for catalog models (Vercel, ArgoLink), the model itself must also be visible in Admin

This hierarchy lets Admin disable a provider globally or selectively grant providers to individual customers.

## Vibi voice provider

Voice generation and cloning use Vibi's official API.

Admin fields:

- Base URL: `https://api.vibi.pro`
- API key: saved encrypted
- Global source ON/OFF
- Max inflight voice jobs
- Customer clone charge: configurable because the supplied Vibi docs do not define a fixed clone-credit formula

Use **Test connection** to call the Vibi account endpoint and verify the key/remaining provider credits.

Voice Studio is on for every customer by default. In **Users → Sources**, untick **Voice Studio** for a customer who should not see the voice workspace.

The customer Voice Studio supports Vibi-backed TTS model/voice selection and customer-owned MiniMax voice clones. The backend source name is not shown in the customer navigation.


## SmartAIPI and prompt enhancer checks

SmartAIPI Test connection reads model availability without creating an image. Gemini Test saved connection checks the exact `gemini-3.8-flash` model metadata without generating text. Neither check proves a paid generation, remaining quota or response time. Provider-settings read responses expose configured flags rather than saved keys.

For setup and error handling, see [SMARTAIPI.md](SMARTAIPI.md) and [PROMPT_ENHANCER.md](PROMPT_ENHANCER.md). The global Allow paid provider calls setting also controls actual enhancement and generation submissions.

## Vercel AI Gateway

Save an AI Gateway key, then use **Check saved key** to read the gateway credit balance. **Sync live models** updates the official catalog and account eligibility, while preserving per-model visibility and price overrides. Sync also works without a key for the public catalog. See [Vercel setup](VERCEL_AI_GATEWAY.md) for price configuration and supported workflows.

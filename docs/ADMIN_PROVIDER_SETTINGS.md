# CMM Tools Admin provider settings

Updated 11 October 2026.

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
- Atlas Cloud image API base URL / encrypted API key / max-inflight jobs
- vgenv MiniMax H3 API base URL / encrypted API key / max-inflight jobs
- SmartAIPI API base URL / encrypted key / max-inflight jobs / per-model Low, Medium and High square prices / direct customer credits per USD
- Gemini prompt-enhancer encrypted API key and global enable switch
- Vibi encrypted API key, max-inflight jobs and customer clone cost
- Higgsfield OAuth connection, model sync and per-model visibility
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

After confirming the Provider page shows the required engines as configured, legacy provider credential variables can be removed from hPanel. Legacy migration also recognizes Atlas Cloud and vgenv settings.

Infrastructure variables such as MySQL credentials, `APP_URL`, `ADMIN_TOKEN`, and the optional `SETTINGS_ENCRYPTION_KEY` remain server environment settings.

## Runtime behavior

The generation worker reads provider settings from MySQL and refreshes provider clients when saved settings change. Updating an API key in Admin therefore does not require a code change or redeploy.


## Current provider roles

- Vidancee — primary Seedance video source
- CreatePulse — Seedance overflow source
- Atlas Cloud — image generation source
- vgenv — MiniMax H3 video source
- Higgsfield MCP — dynamic image/video catalog; available overlapping definitions take precedence
- SmartAIPI — GPT image generation and edits
- Vibi — TTS and voice cloning
- Google Gemini — prompt enhancement in the web process

vgenv settings are stored as `vgenv_base_url`, encrypted `vgenv_api_key`, and `vgenv_max_inflight`. The default API origin is `https://api.vgenv.com`.

## Per-customer source access

Provider-wide switches are the master availability controls.

Admin can additionally assign sources per customer from:

`/admin-console` → **Users** → **Sources**

Assignable sources include Higgsfield, Vidancee, CreatePulse, vgenv/MiniMax, Atlas Cloud, SmartAIPI and Vibi/Voice Studio. Voice is opt-in per customer. The prompt enhancer is controlled globally and requires an active signed-in customer.

A customer's model catalog is built only from sources that are both globally available and assigned to that customer. The server also checks the assignment during cost lookup and submission, so this is not only a frontend filter.

Legacy generation sources default to access enabled until an explicit per-user setting is saved; Voice Studio is the opt-in exception.

## Pricing rule

Provider settings and customer pricing are separate concerns.

Legacy/static providers continue to use the shared billing/pricing configuration where applicable.

**Higgsfield is currently an exception:** its provider-reported credit cost is exposed and charged 1:1 with no 2.5× multiplier. A provider-reported cost of 0 is valid for subscription-covered generations and is displayed/charged as 0 credits.

SmartAIPI is another exception. Its default direct conversion is `160 / 0.0265` customer credits per estimated source USD, rounded up to whole credits. The shared 2.5 multiplier is not added. Per-quality prices and model switches are Admin-managed. The `gpt2-medium-160` revision supersedes earlier saved conversion factors; an override saved at this revision persists.

Prompt enhancement consumes no customer credits, although Google may charge the owner. Vibi TTS reconciles to reported source credits times the shared multiplier; clone pricing is set separately.

Provider secrets remain Admin-managed.


## Current customer visibility hierarchy

For a model to be offered to a customer:

1. the backend source must be configured
2. the provider-wide source switch must allow it
3. the customer must have that source assigned
4. for dynamic Higgsfield models, the model itself must also be enabled/available in the synced catalog

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

Vibi is opt-in per customer. In **Users → Sources**, enable **Voice Studio** for customers who should see the voice workspace.

The customer Voice Studio supports Vibi-backed TTS model/voice selection and customer-owned MiniMax voice clones. The backend source name is not shown in the customer navigation.


## SmartAIPI and prompt enhancer checks

SmartAIPI Test connection reads model availability without creating an image. Gemini Test saved connection checks the exact `gemini-3.8-flash` model metadata without generating text. Neither check proves a paid generation, remaining quota or response time. Provider-settings read responses expose configured flags rather than saved keys.

For setup and error handling, see [SMARTAIPI.md](SMARTAIPI.md) and [PROMPT_ENHANCER.md](PROMPT_ENHANCER.md). The global Allow paid provider calls setting also controls actual enhancement and generation submissions.

# Admin-managed provider credentials

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

After confirming the Provider page shows both engines as configured, the legacy provider credential variables can be removed from hPanel.

Infrastructure variables such as MySQL credentials, `APP_URL`, `ADMIN_TOKEN`, and the optional `SETTINGS_ENCRYPTION_KEY` remain server environment settings.

## Runtime behavior

The generation worker reads provider settings from MySQL and refreshes provider clients when saved settings change. Updating an API key in Admin therefore does not require a code change or redeploy.

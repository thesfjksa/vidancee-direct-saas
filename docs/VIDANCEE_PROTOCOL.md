# Vidancee Protocol Notes

This document records the confirmed provider protocol observed during discovery. It intentionally contains no live credentials, sessions, or token values.

## Authorization context

The project owner states that the Vidancee owner personally authorized this integration. Keep that authorization documented outside the codebase as well.

## Login

Confirmed successful login request:

```http
POST https://vidancee.com/login.php
Content-Type: application/x-www-form-urlencoded
```

Confirmed form fields:

```text
email
password
csrf_token
```

Confirmed successful response behavior:

```text
302 Found
Location: /studio.php
```

The login CSRF token is expected to be parsed from the GET /login.php HTML by the connector. If the provider markup changes, update `extractLoginCsrf()`.

## Authenticated studio

```http
GET https://vidancee.com/studio.php
```

Confirmed generation CSRF source:

```html
<meta name="csrf-token" content="...">
```

Confirmed provider JavaScript helper:

```js
function csrfToken(){
  var m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.content : '';
}
```

The authenticated browser also sends a PHP session cookie named `PHPSESSID`.

## Text-to-video generation

Endpoint:

```http
POST https://vidancee.com/api/generate.php
```

Important request properties observed:

```text
Cookie: PHPSESSID=...
X-CSRF-Token: <studio meta token>
Origin: https://vidancee.com
Referer: https://vidancee.com/studio.php
Content-Type: multipart/form-data
```

Confirmed multipart fields:

```text
mode         = text-to-video
model        = seedance_2.5
duration     = 10
aspect_ratio = 9:16
prompt       = A red sports car driving on a city road
quantity     = 1
```

Confirmed response shape:

```json
{
  "ok": true,
  "job_id": 1397,
  "job_ids": [1397],
  "quantity": 1
}
```

Always store `job_ids`; do not assume quantity will always be one.

## Job polling

Confirmed endpoint:

```http
GET https://vidancee.com/api/jobs.php?limit=12&status=finished&with_active=1
```

Confirmed top-level response fields:

```json
{
  "ok": true,
  "active": [],
  "reserved": 0,
  "credits": 327,
  "concurrency": 1,
  "processing": 0,
  "jobs": [],
  "has_more": true
}
```

Observed job fields include:

```text
id
mode
model
duration
aspect_ratio
prompt
reference_image_path
reference_images
cost_credits
attempts
max_retries
status
output_url
error_message
created_at
started_at
completed_at
poster
```

Observed terminal statuses:

```text
completed
failed
```

A completed output path is relative, for example:

```text
renders/v1393_8e5922e7.mp4
```

and should be resolved against `https://vidancee.com/`.

## Known provider costs observed during discovery

These were observations, not a contract. Do not hardcode them into customer pricing:

```text
Seedance 2.5, 10s: 6 provider credits
Seedance 2.5, 15s: 9 provider credits
Seedance 2.5, 30s image-to-video example: 14 provider credits
```

## Not yet confirmed

- exact image-to-video submission multipart field names
- pagination beyond the first `jobs.php` page
- cancellation endpoint
- rate limits
- whether provider CSRF rotates during long-lived sessions
- whether completed provider files have a retention/expiry policy

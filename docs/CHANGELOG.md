# Changelog

## 2026-10-04 — Milestone 1 initialized

- Created fresh GitHub project for direct Vidancee integration.
- Added Hostinger-compatible Node server.
- Added authenticated Vidancee connector.
- Added text-to-video submission.
- Added jobs polling and provider-status inspection.
- Added provider-spend safety switch.
- Added admin-only test UI.
- Added tests and deployment/protocol/handoff documentation.

## 2026-10-04 — Hostinger 503 hardening

- Added explicit package main/build/start configuration.
- Added `app.js` compatibility launcher.
- Prevented missing ADMIN_TOKEN from killing the web process.
- Added safe configuration indicators to `/health`.
- Documented `PORT=3000` for Hostinger managed Node hosting.

## 2026-10-04 — Fix LiteSpeed ERR_REQUIRE_ASYNC_MODULE

- Converted runtime from ESM to CommonJS for Hostinger LiteSpeed compatibility.
- Removed top-level await from the entry graph.
- Converted provider module and tests to CommonJS.

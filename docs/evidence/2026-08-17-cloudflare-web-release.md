# Cloudflare static Web release · 2026-08-17

This record covers the static Web deployment built from commit `c31d818641adadc4f496b25ec7f537152b0601ab`. It contains no Supabase secret, database URL, password, user credential, access token, or business row value. It proves the public Web asset boundary only; it does not prove BFF/Gateway or authenticated business workflows.

## Build and deployment

- Wrangler version: `4.118.0`; authenticated Cloudflare account matched the account pinned in `apps/web/wrangler.jsonc`.
- `pnpm --filter @supplier/web cf:dry-run` rebuilt the static export from the owner-only staging public configuration, read 85 files, and reported `No bindings found`.
- `wrangler deploy` uploaded 32 new or modified assets and reused 30 already-uploaded assets.
- Stable URL: `https://supplier-staging-web.chenjie.workers.dev`.
- Cloudflare Worker version: `b2cfa531-a452-44c3-8a5d-6ca142ab9569` (version number 6).
- `wrangler tail` returned Cloudflare code `100311`, `Cannot tail a Worker which only has assets`, confirming that the deployment executes no Worker code and has no D1, KV, R2, or other runtime binding.

## HTTP and artifact verification

- `/`, `/settings`, `/published/batch`, and `/products?id=mock-1001` returned HTTP 200.
- Removed `/prototypes/supplier-desk` returned HTTP 404.
- Legacy `/products/mock-1001` returned HTTP 301 to `/products?id=mock-1001`.
- The local and deployed root HTML SHA256 values matched exactly: `aea8eee39b32979e3fc6ee6880a7c32563b46614c738b5f82cf6622ae921d355`.
- An exact-value scan confirmed that the public output contains none of the staging service key, database runtime URL, or migration URL. The expected public publishable key and public origins remain build-time client configuration.

## Browser verification

An isolated Chromium session opened the stable Web URL at a 1440×900 viewport:

- The invitation-only Supabase email/password gate rendered on `/` and on the direct `/settings` deep link.
- The page title was `Supplier - 更简单的 1688 分销经营工具`.
- Browser page errors and console messages were empty after successful loads.
- axe-core 4.12.1 reported 0 WCAG A/AA violations and 0 incomplete checks on the login page.
- One non-SLA browser sample measured TTFB 656.2ms, FCP 2576ms, LCP 2984ms, and CLS 0. This is diagnostic evidence only; it is not a latency SLO.
- The first direct `/settings` navigation encountered one transient `net::ERR_SOCKET_NOT_CONNECTED`; an immediate repeat succeeded. Because the host currently runs through the unstable Shadowrocket packet tunnel, this remains network-path evidence rather than an application defect.

## Remaining boundary

The static Web is current and reachable, but the fixed Gateway still returns Cloudflare Tunnel 530 for the current BFF revision because Shadowrocket is intercepting the Cloudflare Tunnel region domains and blocking required port 7844 connectivity. Auth submission and authenticated business flows therefore remain unverified for this release. See [Supabase-only runtime boundary](./2026-08-17-supabase-runtime-boundary.md).

# Supabase-only runtime boundary · 2026-08-17

This record covers commits `1d8e007` and `8a9fd30`. It contains no database URL, password, Supabase key, tunnel origin, token, user identifier, or business row value. It is internal-staging evidence and does not claim production readiness.

## Implemented boundary

- Development, staging, and production BFF startup reject loopback or mismatched databases, `REDIS_URL`, and inline queue execution. Isolated test processes remain the only exception.
- The BFF uses Supabase PostgreSQL for business data, persistent queues, leases, one-time state, fixed-window counters, and AI exact cache. AI cache failure is now a cache miss rather than a process-memory fallback.
- State-changing HTTP requests use the Supabase `runtime_states` atomic counter for the 120-per-minute guard. Read-only requests do not write an extra rate-limit row.
- The production BFF binds to `127.0.0.1` for the local Tunnel topology. Its runtime environment uses the Supabase pooler with `connection_limit=5`, explicitly blanks `DIRECT_URL` to prevent Prisma development-env leakage, contains no `REDIS_URL`, and keeps every real platform, worker, batch, and SKU flag disabled.
- The repository no longer exposes local PostgreSQL start/seed commands for development. Local browser regression uses the API-mocked Web test; destructive full E2E PostgreSQL exists only as disposable tmpfs infrastructure in GitHub Actions. Restore rehearsals remain separate disposable disaster-recovery gates.

## Verification

- `pnpm lint`, 15/15 monorepo typecheck tasks, the full monorepo test suite, 98/98 operations tests, 9/9 build tasks, and the middleware-free Playwright browser regression passed locally.
- The current BFF starts from an owner-only environment file and returns `database=up` plus `runtimeState=up` with exact revision `8a9fd30b6d46ef356c0d8a9f5099031eca9027b4`.
- A read-only protected request returned 401 without rate-limit headers. A state-changing protected request returned 401 with `X-RateLimit-Limit: 120`, proving the Supabase-backed guard runs before the mutation is accepted.
- The BFF has a single `127.0.0.1:3001` listener. No Supplier PostgreSQL, Redis, Supabase-local, MinIO, or S3-compatible middleware listener/container is running.
- [Release gates #32032682539](https://github.com/harzss/supplier/actions/runs/32032682539) and [Security scans #32032682768](https://github.com/harzss/supplier/actions/runs/32032682768) are green. The first `1d8e007` run exposed a newly published `nanoid <3.3.18` advisory; `8a9fd30` pins the patched version and both audit jobs now pass.

## Cloudflare Tunnel blocker

The BFF and Supabase boundary are healthy, but the fixed Gateway is not currently a valid external proof for this revision:

- Cloudflare Gateway requests return a Tunnel 530 page because the current Quick Tunnel hostname has no routable connector at the edge.
- Native and disposable-container `cloudflared` prechecks both show that the active Shadowrocket packet tunnel resolves `region1.v2.argotunnel.com` and `region2.v2.argotunnel.com` to proxy-reserved `198.18.0.0/15` addresses, then blocks both QUIC and HTTP/2 connectivity on port 7844.
- Public DNS returns Cloudflare's documented `198.41.192.0/24` and `198.41.200.0/24` edge ranges, and direct host checks to those ranges on TCP 7844 succeed. This isolates the failure to the local proxy/DNS path rather than the BFF, Supabase, Cloudflare API, or repository code.
- Cloudflare's current [Tunnel firewall documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/) requires outbound TCP/UDP 7844 to the two `argotunnel.com` region hostnames. The next external step is to add direct/bypass rules for those Tunnel domains in Shadowrocket or temporarily disable that packet tunnel, then restart the supervised Quick Tunnel and rerun fixed-Gateway smoke.

The one-off `cloudflare/cloudflared:2026.7.3` diagnostic image was removed after the test. The native supervised BFF remains healthy and the native Tunnel process remains under launchd supervision, but HTTPS internal testing through the fixed Gateway must not be reported restored until the network rule is corrected and smoke passes.

## Remaining product gates

Real Supabase Auth email lifecycle, two-tenant business isolation, Douyin/1688 E2E, LLM/image-provider E2E, independent production resources, external monitoring, backup restore/cutover, and compliance remain open. All side-effect flags stay disabled.

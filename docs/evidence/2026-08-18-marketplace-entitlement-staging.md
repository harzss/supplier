# Marketplace entitlement staging release · 2026-08-18

This record covers the invitation-only audit-release baseline at commit `5cd6b2854502a4b833d013aacb8a08b1f04b0cd5`. It contains no database URL, password, Supabase key, Cloudflare token, OAuth credential, user credential, or business row value.

## CI and code gates

- GitHub Release gates and Security scans completed successfully for the release candidate.
- Local production dependency audit reported no known vulnerabilities.
- Lint, 15/15 typecheck tasks, all repository tests, 98/98 operations tests, 9/9 production build tasks, Prettier, `git diff --check`, and the isolated Chromium regression passed.
- A final concurrency review found and fixed four cross-system races before release: rotated OAuth Token recovery, publish-before-retry recovery, per-order entitlement fencing, and database-clock inbox timestamps.

## Supabase 45 → 46 maintenance

- Pre-migration audit proved exactly 45 applied migrations, one continuous pending suffix (`20260818034357_add_marketplace_entitlement_foundation`), zero unfinished/rolled-back/checksum-mismatch entries, and 42/42 public tables with RLS.
- The final consistent pre-migration archive is Git-ignored at `tmp/staging-backups/supplier-staging-pre-45-to-46-5cd6b28-20260818.dump`: 249106 bytes, 571 TOC entries, SHA256 `671124b1e355a5377aba3992999bde01c602b3260fcffdb93d901c41bab3c3bb`.
- The archive was restored to a disposable PostgreSQL 17 tmpfs container. Exact 45 → 46 migration, status, schema diff and `assert-45-to-46-marketplace-entitlement.sql` passed; the container was then removed.
- The real staging migration ran once through the SHA-bound maintenance image `sha256:6864368355cf6d04627e523e834368c787c1c6fe69e919d1fda759a95474ddc5`.
- Post-migration audit proved 46/46 applied, pending 0, schema diff matched, 46/46 public tables with RLS, zero `anon` / `authenticated` table or sequence privileges, and zero unsafe default privileges.

## Gateway and Web

- Shadowrocket uses an enabled local `Cloudflare Tunnel Direct` module for `argotunnel.com`, `cftunnel.com`, and `trycloudflare.com`; the module remains separate from the remotely refreshed base profile.
- The SHA-bound staging supervisor is running with all real platform, marketplace, batch, SKU, scan and audit workers disabled.
- Local and fixed-Gateway readiness both return `revision=5cd6b2854502a4b833d013aacb8a08b1f04b0cd5` with `database=up` and `runtimeState=up`.
- The fixed Gateway deployment verifier passed 18/18 checks before and after the Web release.
- The invitation audit-mode static Web was deployed as Cloudflare version `488ee083-f2e8-4e08-8bbc-9b77baebb264` with no runtime bindings.
- Local and deployed SHA256 values match for `/`, `/settings`, `/published/batch`, and `/sources/import`; the removed prototype route returns 404.

## Remaining boundary

This is still staging, not production or marketplace approval evidence. Railway Hobby creation/GitHub authorization, two-account Auth, official marketplace signature vectors and callback adapter, real Douyin/1688 accounts, real order/logistics/refund E2E, independent production resources, monitoring, support and compliance materials remain open. `MARKETPLACE_EVENT_PROCESSING_ENABLED` and every real platform side-effect flag remain `false`.

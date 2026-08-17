# Supabase-only staging evidence · 2026-08-10

This record captures the controlled staging validation of commit `d30d302`. It contains no password, DSN, Supabase key, token, user identifier, row value, or other credential. It is staging evidence only and does not claim production readiness.

## Candidate and maintenance runtimes

- Candidate commit: `d30d302` (`fix: keep staging tunnel stable during gateway outages`).
- The 2026-08-08 staging mutation ran from the verified `6fa58f0` Linux maintenance image ID `sha256:0d325079ce90d449b4f7b90c3837aa9b21f8ef262e4ec268fccb1a2b00131525`.
- The later `d30d302` read-only strict audit ran from image ID `sha256:004bee2ef74b4842815f5821fdc7baddc82ba20f80f5c187ff72cb1020879ae5`.
- The `d30d302` image did not perform or repeat the already-completed migration.

## Pre-migration backup and isolated rehearsal

- The pre-migration staging archive was 245624 bytes with SHA256 `afa5ff8f9671576ac45821ac6cd087d927e33139d872d5ad89cc4e9ecd72f687`.
- The archive was restored into a disposable, isolated PostgreSQL 17 target.
- The isolated target completed the 43→45 migration, schema checks, and repository upgrade assertions successfully before the real staging migration.
- The rehearsal target was not used as a staging runtime and does not establish a production recovery time objective.

## Supabase database result

- Migration history: 45/45 applied.
- Pending migrations: 0.
- Unfinished migrations: 0.
- Rolled-back migrations: 0.
- Repository/applied checksum mismatches: 0.
- Live schema comparison: matched.
- Public-table RLS: 42/42 enabled.
- `anon` / `authenticated` table privileges: 0.
- `anon` / `authenticated` sequence privileges: 0.
- `anon` / `authenticated` default privileges: 0.

These checks cover the staging schema and public access boundary at the time of the run. They do not replace application-level tenant-isolation or real-user Auth testing.

## Post-migration backup

- A Git ignored post-45 staging archive was created at 248508 bytes with SHA256 `0a15a148e5f973bd87ec72851728ae16cf063ddea466b92a762fa39b63061ae4`.
- Its archive TOC validation passed.
- This post-45 archive was not restored into a separate target during this run. Disaster-recovery validation must not treat TOC validation alone as a completed restore rehearsal.

## BFF, Gateway, and runtime-state validation

- The `d30d302` BFF returned readiness with exactly `database + runtimeState` healthy on the local endpoint and through the current Quick Tunnel.
- An external probe confirmed the fixed Cloudflare Gateway returned the same ready result.
- The ordered deployment verification passed 18/18 checks against the current Quick Tunnel BFF and the current local production Web build. The fixed Gateway was independently proven only for readiness by the external probe.
- The `d30d302` GitHub [Release gates](https://github.com/harzss/supplier/actions/runs/31208812362) (verify/browser/images) and [Security scans](https://github.com/harzss/supplier/actions/runs/31208812359) (dependency audit/CodeQL) completed successfully.
- Runtime-state dynamic checks passed for store, read, consume, lease acquire, lease renew, and lease release.
- The current BFF/runtime configuration contains no `REDIS_URL`; Redis is not part of readiness.
- The old supplier Redis and PostgreSQL runtime containers and runtime volumes were deleted after the controlled transition. The unmounted historical backup volume `supplier-staging-pre-rls-20260803-1730` was intentionally retained; it is not a runtime dependency. No local long-running Redis or PostgreSQL middleware remains for this staging runtime.

The local machine had polluted DNS resolution for `workers.dev`; therefore a local request to the fixed Gateway was not accepted as authoritative evidence of Gateway failure. The fixed Gateway result above came from an external probe, while the local endpoint and Quick Tunnel were checked directly.

## Disabled side effects

The staging validation kept platform automation and SKU mutation disabled:

- `DOUYIN_ORDER_SYNC_ENABLED=false`
- `EXCEPTION_CENTER_SCAN_ENABLED=false`
- `INVENTORY_SYNC_ENABLED=false`
- `ALIBABA_1688_PURCHASE_ENABLED=false`
- `ALIBABA_1688_PURCHASE_AUDIT_ENABLED=false`
- `PRODUCT_BATCH_ENABLED=false`
- `PRODUCT_BATCH_SKU_EDIT_ENABLED=false`
- `SOURCE_IMPORT_ENABLED=false`

No real-platform order sync, purchase, audit, inventory, batch operation, source import, or SKU edit was authorized by this maintenance validation.

## Boundary and remaining gates

This evidence establishes that the current internal staging candidate runs on Supabase PostgreSQL/Auth/Storage architecture without Redis or a local long-running PostgreSQL dependency, and that its database/runtime-state readiness path is operational. It does not establish production readiness.

The following remain open:

- real Supabase Auth email registration, verification, login, refresh, and logout evidence;
- real Douyin and 1688 OAuth, product, order, purchase, logistics, refund, and SKU E2E;
- independent production compute, database, networking, secrets, backup restore, and rollback validation;
- production monitoring, alert delivery, logging/APM, on-call, and recovery drills;
- marketplace onboarding, privacy, security, data-retention, billing, customer-support, and other compliance requirements.

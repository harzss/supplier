# Local PostgreSQL 17 restore rehearsal · 2026-08-06

This record captures a local-only rehearsal of the split restore/helper flow that existed on 2026-08-06. It contains no database password, DSN, Supabase key, or project credential.

## Inputs

- Source: the 2026-08-05 read-only staging backup preflight archive.
- Local path: `/private/tmp/supplier-staging-libpq-preflight-99075b3.dump`.
- Size and mode: 150239 bytes, `0600`.
- SHA256: `a325f82ddb2e9d1815de9860bab99c46ce7ba01e1692cb3eae5a95ceec21be98`.
- Valid non-comment TOC entries: 365.
- Container image: `postgres:17-alpine`.
- Image digest: `sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`.
- Docker daemon: the active context resolved to a local `unix:///.../.colima/default/docker.sock` endpoint; inherited `DOCKER_HOST` and `DOCKER_CONTEXT` were not passed to the helper's Docker subprocesses.
- Target: disposable database `supplier_restore_preflight_20260806` in auto-remove container `supplier-restore-preflight-pg17`, exposed only through host `127.0.0.1:55432`.
- Container identity: `d3d28152be34046be7da398a8828428c3247832d9a4ba6d19a0ac44a8b14b592`.
- Storage: `/var/lib/postgresql/data` used `rw,noexec,nosuid,size=256m` tmpfs; no bind or named-volume mount was present.

## Sanitized execution sequence

1. Start a labeled, auto-remove PostgreSQL 17 container with an ephemeral password, confirmed `supplier_restore_*` database, numeric-loopback-only port binding, and tmpfs data directory.
2. Run `restore-rehearsal.mjs restore` with both database URLs pointing to the same numeric loopback host, port, user, and database, plus the exact container confirmation.
3. Run Prisma `migrate deploy`, `migrate status`, and `migrate diff --exit-code` against the restored database.
4. Run `restore-rehearsal.mjs post-upgrade-assert` with the same exact database confirmation.
5. Stop the `--rm` container and verify that no container with the rehearsal name remains.

## Results

- Restore helper confirmed the local Unix-socket Docker context, pinned image ID, default PostgreSQL entrypoint, exact database label, auto-remove state, unique loopback port binding, tmpfs-only storage, fixed full container ID, empty target database, and connected PostgreSQL 17 server before mutation.
- The helper re-inspected the same full container ID immediately before role initialization, inspected all 365 TOC entries, initialized the local Supabase roles, and restored the archive successfully.
- Prisma applied the exact ten-migration suffix from `20260803200000_add_publish_request_idempotency` through `20260805040000_harden_workflow_check_null_semantics`.
- `migrate status`: `43 migrations found` and `Database schema is up to date!`.
- `migrate diff --exit-code`: `No difference detected.`.
- Post-upgrade assertions: all three fixed checks passed, covering public schema isolation, rollback-only workflow constraint probes, and 33-to-43 upgrade data invariants.
- Post-upgrade assertion repeated the Docker identity checks before running its fixed SQL files.
- Cleanup: `supplier-restore-preflight-pg17` was stopped with automatic removal; a subsequent exact-name container query returned no result.

## Boundary

This proves that the earlier helper and Docker port-forward path could restore and upgrade the previously captured real staging dataset. The current runbook uses the stricter single-process `restore-rehearsal.mjs rehearse` action so restore, migration checks, and assertions retain one full container ID throughout; its subsequent real run is recorded in [the integrated rehearsal evidence](./2026-08-06-integrated-local-pg17-restore-rehearsal.md). Neither run is the maintenance-window final backup, proves a stop-the-world snapshot, or authorizes or claims that staging has been migrated.

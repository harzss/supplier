# Integrated PostgreSQL 17 restore rehearsal · 2026-08-06

This record captures a local-only run of the single-process `restore-rehearsal.mjs rehearse` flow. It contains no password, DSN, Supabase key, or project credential and made no connection to Supabase staging.

## Inputs and target

- Archive: `/private/tmp/supplier-staging-libpq-preflight-99075b3.dump`, 150239 bytes, mode `0600`, SHA256 `a325f82ddb2e9d1815de9860bab99c46ce7ba01e1692cb3eae5a95ceec21be98`.
- Docker context: `colima`, resolving to the local `unix:///.../.colima/default/docker.sock` endpoint.
- Image: `postgres:17-alpine`, pinned image ID `sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`.
- Disposable target: database `supplier_restore_integrated_20260806`, container `supplier-restore-integrated-pg17`, host binding `127.0.0.1:55433`, and tmpfs-only PostgreSQL data directory.
- Fixed container ID: `eb72ccfa33ddfa94701905bcd1133d1dfe342602f46cfe9eccca3912bbd555db`.

## Result

- The helper copied the source through an `O_NOFOLLOW` handle into a private `0600` snapshot, bound both PostgreSQL 17 `pg_restore` operations to fresh inherited descriptors using `/dev/fd/3` and `--format=custom`, and validated 365 TOC entries.
- It fixed one Docker context name, Unix endpoint, image ID, and full container ID for the entire process; every mutation or verification phase re-inspected that target.
- The connected server was PostgreSQL 17 with `data_directory=/var/lib/postgresql/data`; the restore database was empty before role initialization.
- The restored migration history exactly matched the first 33 repository migrations by order, name, checksum, completed step count, and rollback state before any Prisma write.
- The fixed Prisma CLI then completed deploy, status, and schema diff against its canonical local datasource and repository schema. The three fixed post-upgrade assertion files all passed.
- Final helper result: `archiveEntries=365`, `prismaChecks=3`, `assertions=3`.
- The `--rm` container was stopped and an exact-name query confirmed that no rehearsal container remained.

## Boundary

This closes the real-execution gap for the integrated local helper and the previously captured staging-data archive. It is not the maintenance-window final backup or final restore rehearsal, does not prove a stop-the-world snapshot, and does not authorize or claim any staging migration, backfill, deployment, or key change.

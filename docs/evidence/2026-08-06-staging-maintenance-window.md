# Staging maintenance window · 2026-08-06

This record captures the authorized Supplier staging maintenance window and the
post-maintenance verification. It contains no database password, DSN, Supabase
key, user credential, or secret response body.

## Scope and immutable inputs

- Final-backup capture Git SHA:
  `d4e9e0a462dfe5e21fc5bf7a03a57ac01f613684`.
- Backfill, migration, and post-audit runtime Git SHA:
  `3ea3a302ebd19e34b5bed08afe36094041ca8907`.
- Linux maintenance image ID: `sha256:20fe36a2a4bfc677b166f9dd98a068312dbdd0d68f448ca712e14817f40ec16f`.
- The image OCI revision matched the full Git SHA, ran as `node`, and was
  selected by full image ID through the fixed local `colima` Unix-socket
  context.
- The maintenance runner used a read-only filesystem, a bounded `/tmp` tmpfs,
  dropped all capabilities, enabled `no-new-privileges`, and passed only the
  three validated staging datasource variables.
- BFF, queues, and workers were stopped before the final backup and database
  writes. Failure policy was fail-closed: do not resume writes and use only a
  forward corrective migration.

## Final backup and isolated recovery

- Final stop-the-world archive:
  `tmp/staging-maintenance-20260806-d4e9e0a/supplier-staging-pre-migration-d4e9e0a.dump`.
- The `d4e9e0a` suffix records the backup-capture commit. Strict-TLS backfill,
  migration, and the final audit used the later full `3ea3a302...` Linux
  runtime recorded above; the two provenances are intentionally distinct.
- Size and mode: 150239 bytes, `0600`; parent directory mode `0700`.
- SHA256:
  `c482ea5387c9fb6b5bb70ea1b8704af0ceacbae9161d820435d591d4ba39c30c`.
- The archive restored successfully into an isolated PostgreSQL 17 instance.
  The fixed 33-migration manifest, ordered checksums, deploy/status/diff, and
  all three post-upgrade assertion groups passed before the staging migration.
- The archive remains local and private after maintenance. It is the only
  retained maintenance artifact containing staging data.

## Backfill and migration

- The pre-write audit reconfirmed the exact ten-product mock set and no
  published products, orders, purchases, or publish tasks.
- The dedicated guarded backfill populated the ten missing deterministic
  `supplierId` values. Immediate readback reported zero pending updates and no
  unexpected identifiers.
- A single `migrate-once` executor applied migrations 34 through 43, from
  `20260803200000_add_publish_request_idempotency` through
  `20260805040000_harden_workflow_check_null_semantics`.
- Post-upgrade checks passed for public-schema isolation, rollback-only
  workflow constraint probes, and the fixed 33-to-43 data invariants.
- The final read-only audit reported PostgreSQL 17.6, 43 local and 43 applied
  migrations, zero pending/unfinished/rolled-back/checksum mismatch, and
  `No difference detected.` for the Prisma schema diff.
- Data/readiness summary: 10 source products, 0 published products, 0 orders,
  0 purchase orders, 0 publish tasks; the exact mock set is publish-ready and
  no backfill remains.
- Isolation summary: all 41 public tables have RLS enabled; `anon` and
  `authenticated` have zero direct table, sequence, or default privileges.
  Recovery-key and platform-product duplicate group counts are both zero.

The final audit was repeated after deployment and key rotation with the same
result. Its immutable maintenance operation reported the image ID and Git SHA
above.

## Deployment and access boundary

- Cloudflare Gateway deployment version:
  `c9d7e03e-2d63-4af0-90ee-6b0c450394c0`.
- Cloudflare Web deployment version:
  `29b01f71-9a1a-4051-8a58-413fe291744f`.
- Stable origins:
  `https://supplier-staging-gateway.chenjie.workers.dev` and
  `https://supplier-staging-web.chenjie.workers.dev`.
- `com.supplier.staging-local` is installed and running. Host BFF readiness,
  Gateway readiness, and the Web root each returned HTTP 200 after cleanup.
- The deployment verifier passed all 18 probes: live/ready, production Swagger
  and OpenAPI gates, unauthenticated/invalid/forged-auth rejection, public OAuth
  callback, operations protection/status/check, protected metrics, positive
  PUT/DELETE draft CORS, rejected untrusted-origin CORS, and Web root.
- `/sources`, `/exceptions`, and `/after-sales` returned HTTP 200 from the
  deployed Web application.

## Supabase key rotation

- BFF uses a dedicated new-style `sb_secret_*` key; Web uses a new-style
  `sb_publishable_*` key. Legacy JWT-based API keys are disabled.
- The ECC P-256 signing key is current. The previous Legacy HS256 shared-secret
  signing key was revoked after the new-key smoke passed.
- The post-revocation secret-key verifier passed Auth admin, Storage upload,
  public read, and delete with HTTP 200.
- The publishable-key boundary verifier confirmed public signup is disabled and
  anonymous business-table access is denied with HTTP 401.
- The complete 18-probe deployment verifier passed again after revocation.

Revocation intentionally invalidates any still-live session signed by the old
HS256 key. No internal test account had been accepted as verified at this
point.

## Cleanup and retained state

- Removed the unreferenced `supplier-staging-maintenance:tls-test` image and the
  current-SHA maintenance image after the final audit; both are reproducible
  from clean commits.
- Removed the temporary Linux Prisma datasource file, both isolated-restore env
  files, and the temporary downloaded TLS chain/leaf/intermediate copies.
- Preserved the existing PostgreSQL/Redis containers, volumes, and networks,
  the owner-only staging runtime env files, and the final backup above.
- No volume, network, or system-wide Docker prune was run.

## Remaining acceptance boundary

- A real invite, password setup, login/refresh/logout, recovery-email callback,
  and old-to-new-password transition still require a user-approved test inbox
  and password.
- Douyin, 1688, LLM, and image-service credentials are not configured. Their
  automation switches remain disabled; no real-platform E2E is claimed.
- This is an internal staging baseline. It is not evidence of 1688 marketplace
  approval, production traffic, production monitoring/compliance completion,
  or production readiness.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const MIGRATION_NAME = '20260818034357_add_marketplace_entitlement_foundation';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const migrationsDir = join(packageDir, 'prisma', 'migrations');
const migrationPath = join(migrationsDir, MIGRATION_NAME, 'migration.sql');
const schemaPath = join(packageDir, 'prisma', 'schema.prisma');

const MARKETPLACE_TABLES = [
  'marketplace_account_bindings',
  'marketplace_plan_mappings',
  'marketplace_subscription_projections',
  'marketplace_event_inbox',
];

const MARKETPLACE_SEQUENCES = MARKETPLACE_TABLES.map((table) => `${table}_id_seq`);

test('marketplace entitlement foundation is the next UTC Prisma migration', async () => {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.match(MIGRATION_NAME, /^\d{14}_[a-z0-9_]+$/);
  assert.equal(migrations.at(-1), MIGRATION_NAME);
});

test('migration adds explicit user entitlement provenance without changing existing plans', async () => {
  const [sql, schema] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ]);

  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.match(sql, /CREATE TYPE "EntitlementSource" AS ENUM \('internal_beta', 'marketplace'\)/);
  assert.match(sql, /CREATE TYPE "EntitlementAccessStatus" AS ENUM \('active', 'suspended'\)/);
  assert.match(sql, /"entitlement_source" "EntitlementSource" NOT NULL DEFAULT 'internal_beta'/);
  assert.match(
    sql,
    /"entitlement_access_status" "EntitlementAccessStatus" NOT NULL DEFAULT 'active'/,
  );
  assert.match(sql, /"entitlement_revision" INTEGER NOT NULL DEFAULT 1/);
  assert.match(sql, /"entitlement_updated_at" TIMESTAMPTZ\(3\) NOT NULL/);
  assert.match(sql, /CONSTRAINT "users_entitlement_revision_check" CHECK/);
  assert.doesNotMatch(sql, /UPDATE\s+"users"/i);

  assert.match(
    schema,
    /entitlementSource\s+EntitlementSource\s+@default\(internal_beta\) @map\("entitlement_source"\)/,
  );
  assert.match(
    schema,
    /entitlementAccessStatus\s+EntitlementAccessStatus\s+@default\(active\) @map\("entitlement_access_status"\)/,
  );
  assert.match(schema, /entitlementRevision\s+Int\s+@default\(1\)/);
  assert.match(
    schema,
    /entitlementUpdatedAt\s+DateTime\s+@default\(now\(\)\)[\s\S]*@db\.Timestamptz\(3\)/,
  );
});

test('migration creates four private marketplace tables with least privilege', async () => {
  const sql = await readFile(migrationPath, 'utf8');

  for (const table of MARKETPLACE_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
  }
  for (const sequence of MARKETPLACE_SEQUENCES) {
    assert.match(sql, new RegExp(`"${sequence}"`));
  }

  assert.match(sql, /FROM "anon", "authenticated";/);
  assert.match(sql, /rolname = 'service_role'/);
  assert.match(sql, /FROM "service_role";/);
  assert.doesNotMatch(sql, /CREATE\s+POLICY/i);
  assert.doesNotMatch(sql, /\bGRANT\b/i);
});

test('migration enforces identity, lifecycle, queue and short-lease invariants', async () => {
  const sql = await readFile(migrationPath, 'utf8');

  for (const constraint of [
    'marketplace_account_binding_keys_check',
    'marketplace_account_binding_status_check',
    'marketplace_plan_mapping_keys_check',
    'marketplace_projection_origin_check',
    'marketplace_projection_access_check',
    'marketplace_projection_revision_check',
    'marketplace_projection_currency_check',
    'marketplace_event_keys_check',
    'marketplace_event_digest_check',
    'marketplace_event_callback_check',
    'marketplace_event_authoritative_state_check',
    'marketplace_event_attempts_check',
    'marketplace_event_processing_check',
    'marketplace_event_applied_check',
  ]) {
    assert.match(sql, new RegExp(`CONSTRAINT "${constraint}" CHECK`));
  }

  assert.match(
    sql,
    /CREATE UNIQUE INDEX "marketplace_projection_user_active_key"[\s\S]*WHERE "origin" = 'marketplace' AND "access_status" = 'active'/,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "marketplace_projection_external_key"[\s\S]*WHERE "origin" = 'marketplace'/,
  );
  assert.match(
    sql,
    /CREATE INDEX "marketplace_event_inbox_ready_idx"[\s\S]*WHERE "status" IN \('received', 'retry_wait'\)/,
  );
  assert.match(
    sql,
    /CREATE INDEX "marketplace_event_inbox_processing_lease_idx"[\s\S]*WHERE "status" = 'processing'/,
  );

  for (const index of [
    'marketplace_account_bindings_user_id_status_idx',
    'marketplace_subscription_projections_account_binding_id_idx',
    'marketplace_subscription_projections_plan_mapping_id_idx',
    'marketplace_event_inbox_account_binding_id_idx',
    'marketplace_event_inbox_plan_mapping_id_idx',
    'marketplace_event_inbox_projection_id_idx',
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX "${index}"`));
  }
});

test('nullable callback, processing and currency inputs cannot bypass CHECK constraints', async () => {
  const sql = await readFile(migrationPath, 'utf8');

  assert.match(
    sql,
    /"source" <> 'callback'[\s\S]*"signature_verified_at" IS NOT NULL[\s\S]*"verifier_version" IS NOT NULL[\s\S]*char_length\(btrim\("verifier_version"\)\) > 0/,
  );
  assert.match(
    sql,
    /"status" = 'processing'[\s\S]*"locked_at" IS NOT NULL[\s\S]*"locked_by" IS NOT NULL[\s\S]*char_length\(btrim\("locked_by"\)\) > 0/,
  );
  assert.match(
    sql,
    /"amount_cny" IS NOT NULL[\s\S]*"currency" IS NOT NULL[\s\S]*"currency" ~ '\^\[A-Z\]\{3\}\$'/,
  );
  assert.match(sql, /"authoritative_state" "MarketplaceLifecycleState"/);
  assert.match(
    sql,
    /"normalized_kind" = 'reconciled'[\s\S]*"authoritative_state" IS NOT NULL[\s\S]*"source" IN \('reconciliation', 'manual_repair'\)[\s\S]*"normalized_kind" IS DISTINCT FROM 'reconciled'[\s\S]*"authoritative_state" IS NULL[\s\S]*\) IS TRUE/,
  );
  assert.match(sql, /CONSTRAINT "marketplace_projection_origin_check" CHECK \([\s\S]*\) IS TRUE/);
});

test('legacy subscriptions are backfilled one-to-one as unverified without synthetic marketplace facts', async () => {
  const [sql, schema] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ]);

  const inserts = [...sql.matchAll(/INSERT INTO\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(inserts, ['marketplace_subscription_projections']);
  assert.match(sql, /'legacy:' \|\| subscription\."id"::text/);
  assert.match(sql, /'legacy',[\s\S]*subscription\."id",[\s\S]*subscription\."user_id"/);
  assert.match(sql, /'unverified',[\s\S]*FROM "subscriptions" AS subscription/);
  assert.doesNotMatch(
    sql,
    /INSERT INTO\s+"marketplace_(?:account_bindings|plan_mappings|event_inbox)"/,
  );
  assert.doesNotMatch(sql, /UPDATE\s+"users"/i);

  assert.match(
    schema,
    /legacySubscriptionId\s+BigInt\?[\s\S]*@unique\(map: "marketplace_projection_legacy_key"\)/,
  );
  assert.match(
    schema,
    /legacySubscription\s+Subscription\?[\s\S]*map: "marketplace_projection_legacy_fkey"/,
  );
});

test('schema keeps protocol-specific signatures outside the persistence foundation', async () => {
  const [sql, schema] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ]);

  for (const model of [
    'MarketplaceAccountBinding',
    'MarketplacePlanMapping',
    'MarketplaceSubscriptionProjection',
    'MarketplaceEventInbox',
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /payloadDigest\s+String[\s\S]*@db\.Char\(64\)/);
  assert.match(schema, /verifierVersion\s+String\?/);
  assert.match(
    schema,
    /authoritativeState\s+MarketplaceLifecycleState\?\s+@map\("authoritative_state"\)/,
  );
  assert.doesNotMatch(schema, /rawPayload|signatureHeader|signatureAlgorithm/);
  assert.doesNotMatch(sql, /x-[a-z0-9-]+|\bHMAC\b|SHA-?1|SHA-?256/i);
});

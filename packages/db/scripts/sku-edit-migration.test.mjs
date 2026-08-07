import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const migrationPath = join(
  packageDir,
  'prisma',
  'migrations',
  '20260807110000_add_published_product_sku_edits',
  'migration.sql',
);
const schemaPath = join(packageDir, 'prisma', 'schema.prisma');
const forwardAssertionPath = join(scriptDir, 'assert-43-to-44-sku-edits.sql');

test('migration 44 adds only the SKU edit enum, nullable platform snapshot fields, and guard', async () => {
  const sql = await readFile(migrationPath, 'utf8');

  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.match(sql, /ALTER TYPE "ProductBatchAction" ADD VALUE 'edit_sku';/);
  assert.match(sql, /ADD COLUMN "sku_spec_snapshot" JSONB/);
  assert.match(sql, /ADD COLUMN "sku_spec_fingerprint" VARCHAR\(64\)/);
  assert.match(sql, /ADD COLUMN "sku_spec_synced_at" TIMESTAMP\(3\)/);
  assert.match(sql, /CONSTRAINT "published_products_sku_spec_snapshot_check"/);
  assert.match(sql, /jsonb_typeof\("sku_spec_snapshot"\) = 'object'/);
  assert.match(sql, /"sku_spec_fingerprint" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /\) IS TRUE\s*\n\s*\);/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE)\s+(?:INTO\s+)?"published_products"/i);
  assert.doesNotMatch(sql, /sku_snapshot/i);
  assert.doesNotMatch(sql, /GRANT\s+/i);
});

test('Prisma models the nullable authoritative SKU snapshot triplet and edit action', async () => {
  const schema = await readFile(schemaPath, 'utf8');

  assert.match(schema, /skuSpecSnapshot\s+Json\?\s+@map\("sku_spec_snapshot"\) @db\.JsonB/);
  assert.match(
    schema,
    /skuSpecFingerprint\s+String\?\s+@map\("sku_spec_fingerprint"\) @db\.VarChar\(64\)/,
  );
  assert.match(schema, /skuSpecSyncedAt\s+DateTime\?\s+@map\("sku_spec_synced_at"\)/);
  assert.match(schema, /enum ProductBatchAction \{[\s\S]*\n\s+edit_sku\n/);
});

test('the dedicated forward assertion verifies migration 44 as an exact prefix and security', async () => {
  const sql = await readFile(forwardAssertionPath, 'utf8');

  assert.match(sql, /^BEGIN TRANSACTION READ ONLY;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.match(sql, /20260805040000_harden_workflow_check_null_semantics/);
  assert.match(sql, /20260807110000_add_published_product_sku_edits/);
  assert.match(sql, /applied_migration_count < 44/);
  assert.match(sql, /ProductBatchAction/);
  assert.match(sql, /published_products_sku_spec_snapshot_check/);
  assert.match(sql, /array_agg\(expected\.column_name ORDER BY expected\.column_name\)/);
  assert.match(sql, /migration 44 must not backfill non-authoritative platform SKU snapshots/);
  assert.match(sql, /published_products must keep RLS enabled/);
  assert.match(sql, /'anon', 'authenticated'/);
  assert.match(sql, /has_column_privilege/);
  assert.match(sql, /sku_spec_snapshot', 'sku_spec_fingerprint', 'sku_spec_synced_at/);
});

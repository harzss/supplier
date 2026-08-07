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
  '20260807150000_add_runtime_state_store',
  'migration.sql',
);
const schemaPath = join(packageDir, 'prisma', 'schema.prisma');
const assertionPath = join(scriptDir, 'assert-44-to-45-runtime-state.sql');

test('migration 45 adds the private Supabase PostgreSQL runtime-state table', async () => {
  const sql = await readFile(migrationPath, 'utf8');

  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.match(sql, /CREATE TABLE "runtime_states"/);
  assert.match(sql, /"owner_token" UUID/);
  assert.match(sql, /"counter_value" INTEGER/);
  assert.match(sql, /"expires_at" TIMESTAMPTZ\(3\) NOT NULL/);
  assert.match(sql, /CONSTRAINT "runtime_states_mode_check"/);
  assert.match(sql, /CREATE INDEX "runtime_states_expires_at_idx"/);
  assert.match(sql, /ALTER TABLE "runtime_states" ENABLE ROW LEVEL SECURITY/);
  assert.match(
    sql,
    /REVOKE ALL PRIVILEGES ON TABLE "runtime_states" FROM "anon", "authenticated"/,
  );
  assert.doesNotMatch(sql, /GRANT\s+/i);
});

test('Prisma models every runtime-state mode and the timestamptz expiry', async () => {
  const schema = await readFile(schemaPath, 'utf8');

  assert.match(schema, /model RuntimeState \{[\s\S]*@@map\("runtime_states"\)/);
  assert.match(schema, /ownerToken\s+String\?\s+@map\("owner_token"\) @db\.Uuid/);
  assert.match(schema, /counterValue\s+Int\?\s+@map\("counter_value"\)/);
  assert.match(schema, /expiresAt\s+DateTime\s+@map\("expires_at"\) @db\.Timestamptz\(3\)/);
});

test('the dedicated assertion verifies exact migration order, shape and client isolation', async () => {
  const sql = await readFile(assertionPath, 'utf8');

  assert.match(sql, /^BEGIN TRANSACTION READ ONLY;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.match(sql, /20260807110000_add_published_product_sku_edits/);
  assert.match(sql, /20260807150000_add_runtime_state_store/);
  assert.match(sql, /applied_migration_count <> 45/);
  assert.match(sql, /runtime_states_mode_check/);
  assert.match(sql, /runtime_states_expires_at_idx/);
  assert.match(sql, /runtime_states must have RLS enabled/);
  assert.match(sql, /'anon', 'authenticated'/);
  assert.match(sql, /has_table_privilege/);
  assert.match(sql, /must not expose client RLS policies/);
});

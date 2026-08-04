import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const migrationsDir = resolve(packageDir, 'prisma', 'migrations');
const assertionPath = resolve(
  packageDir,
  '..',
  '..',
  'infra',
  'postgres',
  'assert-33-to-43-upgrade-data.sql',
);
const releaseWorkflowPath = resolve(
  packageDir,
  '..',
  '..',
  '.github',
  'workflows',
  'release-gates.yml',
);

const strictChecks = [
  'exception_case_events_transition_check',
  'after_sale_purchase_links_lifecycle_check',
  'after_sale_case_events_transition_check',
];

const rlsTables = [
  'product_batch_tasks',
  'product_batch_items',
  'source_import_tasks',
  'source_import_items',
  'user_source_products',
  'published_product_source_bindings',
  'exception_cases',
  'exception_case_events',
  'after_sale_cases',
  'after_sale_case_items',
  'after_sale_purchase_links',
  'after_sale_case_events',
];

test('the 33-to-43 post-upgrade assertion is read-only and tracks the exact migration set', async () => {
  const [sql, migrationEntries, releaseWorkflow] = await Promise.all([
    readFile(assertionPath, 'utf8'),
    readdir(migrationsDir, { withFileTypes: true }),
    readFile(releaseWorkflowPath, 'utf8'),
  ]);
  const migrationNames = migrationEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const diskManifest = await Promise.all(
    migrationNames.map(async (name) => {
      const migrationSql = await readFile(resolve(migrationsDir, name, 'migration.sql'));
      return {
        name,
        checksum: createHash('sha256').update(migrationSql).digest('hex'),
      };
    }),
  );
  const manifestMatch = sql.match(
    /expected_migrations CONSTANT jsonb := \$migration_manifest\$(\[[\s\S]*?\])\$migration_manifest\$::jsonb;/,
  );
  const sqlWithoutComments = sql.replace(/^\s*--.*$/gm, '');

  assert.equal(migrationNames.length, 43);
  assert.ok(manifestMatch);
  assert.deepEqual(JSON.parse(manifestMatch[1]), diskManifest);
  assert.match(sql, /^BEGIN TRANSACTION READ ONLY;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.doesNotMatch(
    sqlWithoutComments,
    /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY)\b/i,
  );
  assert.match(sql, /row_number\(\) OVER \(ORDER BY started_at, id\)/);
  assert.match(sql, /expected_history\.checksum IS DISTINCT FROM applied_history\.checksum/);
  assert.match(releaseWorkflow, /infra\/postgres\/assert-33-to-43-upgrade-data\.sql/);
});

test('the post-upgrade assertion covers data backfills, strict CHECKs, and new-table RLS', async () => {
  const sql = await readFile(assertionPath, 'utf8');

  for (const fragment of [
    '_prisma_migrations',
    'finished_at IS NULL',
    'rolled_back_at IS NOT NULL',
    'applied_steps_count <= 0',
    'duplicate platform product ids exist within a shop',
    'published products without exactly one matching current source binding',
    'published order items have missing or mismatched source snapshots',
    'unresolved purchase exceptions are missing structured codes',
  ]) {
    assert.match(sql, new RegExp(fragment));
  }
  assert.match(sql, /WHERE order_item\.published_product_id IS NOT NULL\s+AND \(/);
  assert.doesNotMatch(
    sql,
    /WHERE order_item\.published_product_id IS NOT NULL\s+AND NULLIF\(btrim\(order_item\.source_offer_id\)/,
  );
  for (const legacyField of ['source_offer_id', 'source_supplier_id']) {
    assert.match(
      sql,
      new RegExp(
        `NULLIF\\(btrim\\(order_item\\.${legacyField}\\), ''\\) IS NOT NULL\\s+AND binding\\.${legacyField} IS DISTINCT FROM order_item\\.${legacyField}`,
      ),
    );
  }
  for (const constraintName of strictChecks) {
    assert.match(sql, new RegExp(`'${constraintName}'`));
  }
  assert.match(sql, /constraint_record\.convalidated/);
  assert.match(sql, /position\('IS TRUE' IN pg_get_constraintdef/);
  for (const tableName of rlsTables) {
    assert.match(sql, new RegExp(`'${tableName}'`));
  }
  assert.match(sql, /relation\.relrowsecurity/);
});
